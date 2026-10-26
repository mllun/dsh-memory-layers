/**
 * Validate this plugin against the host's real tool registry rules.
 *
 * DSH's `tools.register` accepts only a closed JSON-Schema subset, and it throws
 * on anything outside it — which takes the whole plugin down at activation, with
 * no obvious error in the UI. It also validates every tool result against
 * `output.schema` at call time. This test imports the host's own
 * `assertSupportedJsonSchema` / `validateJsonSchemaValue` and:
 *
 *  1. asserts every registered `parameters` + `output.schema` is inside the subset;
 *  2. calls every tool once and validates the returned value against its schema;
 *  3. pins the regression that broke v1.2 (`type: ['object', 'null']`).
 *
 * The host package path is machine-specific; when it cannot be found the test
 * reports a skip instead of failing (a machine without DSH stays green).
 *
 * Usage: node test/schema.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';

const TOOLS_ENTRY = 'dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js';

/** Likely install locations, so no machine-specific path is baked in. */
function candidates() {
  return [
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'resources', 'app', TOOLS_ENTRY),
    path.join('C:\\Program Files', 'DeepSeek Harness', 'resources', 'app', TOOLS_ENTRY),
    `/Applications/DeepSeek Harness.app/Contents/Resources/app/${TOOLS_ENTRY}`,
    `/opt/DeepSeek Harness/resources/app/${TOOLS_ENTRY}`,
  ];
}

const host = process.argv[2] ?? candidates().find((file) => existsSync(file));
if (!host) {
  console.log('schema: 跳过（找不到 dsh-tools，可把路径作为第一个参数传入）');
  process.exit(0);
}

const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(
  new URL(`file://${host.replace(/\\/g, '/')}`)
);
assert.equal(typeof assertSupportedJsonSchema, 'function', 'dsh-tools 应导出 assertSupportedJsonSchema');
assert.equal(typeof validateJsonSchemaValue, 'function', 'dsh-tools 应导出 validateJsonSchemaValue');

const home = mkdtempSync(path.join(tmpdir(), 'dsh-schema-'));

const { apply } = await import('../index.js');
const { localDateKey } = await import('../lib/paths.mjs');

const registered = new Map();
const ctx = {
  get: (name) =>
    name === 'tools'
      ? {
        register(definition) {
          registered.set(definition.name, definition);
          return () => registered.delete(definition.name);
        },
      }
      : undefined,
  effect: (run) => run(),
  on() {},
  logger: { info() {}, warn() {} },
};

/** The host compiles `parameters` the same way; validate the equivalent schema. */
function parametersSchema(parameters) {
  return {
    type: 'object',
    properties: parameters.properties ?? {},
    ...(parameters.required ? { required: parameters.required } : {}),
  };
}

try {
  apply(ctx, { hotLimit: 600, autoLogOnSessionEnd: true, dataRoot: home });
  assert.equal(registered.size, 9, `应注册 9 个工具，实际 ${registered.size}`);

  for (const [name, definition] of registered) {
    assertSupportedJsonSchema(parametersSchema(definition.parameters));
    assertSupportedJsonSchema(definition.output.schema);
    assert.equal(typeof definition.output.render, 'function', `${name} 缺少 render`);
  }
  console.log('  子集检查通过：9 个工具的 parameters 与 output.schema');

  const call = (name, args = {}) => registered.get(name).execute(args);
  const today = localDateKey();
  await call('mem_write', {
    text: '宿主校验用的一条记忆',
    tag: '校验',
    important: true,
    source: { conv: 'private:1', seq: 7 },
  });
  await call('mem_write', { text: '没有来源的旧式条目', tag: '校验' });

  const calls = [
    ['mem_hot_get', {}],
    ['mem_hot_set', { content: '# 核心\n- 名字：测试' }],
    ['mem_write', { text: '第二条校验记忆', tag: '校验' }],
    ['mem_recall', { keyword: '校验', mode: 'any' }],
    ['mem_recent', { days: 1 }],
    ['mem_by_tag', { tag: '校验' }],
    ['mem_by_date', { from: today, to: today }],
    ['mem_summarize', { period: 'day' }],
    ['mem_stats', {}],
  ];

  for (const [name, args] of calls) {
    const value = await call(name, args);
    const detached = JSON.parse(JSON.stringify(value));
    const violations = validateJsonSchemaValue(registered.get(name).output.schema, detached, 'value');
    assert.deepEqual(violations, [], `${name} 的返回值不符合 output.schema：${violations.join('; ')}`);
    // render 也必须能吃下这个值
    const rendered = registered.get(name).output.render(args, detached);
    assert.ok(Array.isArray(rendered) && rendered.length > 0, `${name}.render 应返回内容`);
    assert.ok(rendered.every((part) => part && part.type === 'text' && typeof part.text === 'string'));
    console.log(`  ok ${name}（返回值 + render）`);
  }

  // v1.2 的事故形态：宿主明确拒绝 type 数组。这条断言保证判据没失效。
  assert.throws(
    () => assertSupportedJsonSchema({ type: ['object', 'null'] }),
    /type arrays are not supported/,
    '宿主确实不支持 type 数组',
  );
  assert.throws(
    () => assertSupportedJsonSchema({ type: 'integer', minimum: 1 }),
    /minimum is not a supported keyword/,
    '宿主确实不支持 minimum',
  );

  console.log('schema: 全部通过（宿主白名单 + 返回值校验）');
} finally {
  rmSync(home, { recursive: true, force: true });
}
