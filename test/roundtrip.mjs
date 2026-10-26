/**
 * Re-read the memory files in a fresh process, so the test can prove that the
 * data survives the process instead of lingering in module state.
 *
 * Usage: DSH_MEMORY_ROOT=<temp dir> node test/roundtrip.mjs
 * (`DSH_HOME` is still honoured as a fallback for older layouts.)
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = process.env.DSH_MEMORY_ROOT ?? process.env.DSH_HOME;
if (!root) throw new Error('DSH_MEMORY_ROOT (or DSH_HOME) is required');

const dataDir = path.join(root, 'memory');
let hot = readFileSync(path.join(dataDir, 'hot.md'), 'utf8');

/** Remove one reserved block, returning its inner text and the remaining text. */
function takeBlock(text, start, end) {
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from < 0 || to < 0 || to < from) return { inner: '', rest: text };
  return {
    inner: text.slice(from + start.length, to),
    rest: `${text.slice(0, from)}${text.slice(to + end.length)}`,
  };
}

const candidates = takeBlock(hot, '<!-- candidates:start -->', '<!-- candidates:end -->');
hot = candidates.rest;
const topics = takeBlock(hot, '<!-- topics:start -->', '<!-- topics:end -->');
hot = topics.rest;

const topicCount = topics.inner
  .split(/\r?\n/)
  .filter((line) => /^\s*.+?\s*\|\s*\d{4}-\d{2}\s*$/.test(line)).length;

const coldDir = path.join(dataDir, 'cold');
let coldEntries = 0;
if (existsSync(coldDir)) {
  for (const month of readdirSync(coldDir)) {
    for (const file of readdirSync(path.join(coldDir, month))) {
      if (!file.endsWith('.md')) continue;
      const text = readFileSync(path.join(coldDir, month, file), 'utf8');
      coldEntries += text.split(/\r?\n/).filter((line) => line.trim().startsWith('- [')).length;
    }
  }
}

process.stdout.write(JSON.stringify({ hot: hot.trim(), coldEntries, topicCount }));
