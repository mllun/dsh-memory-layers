/**
 * Re-read the memory files in a fresh process, so the test can prove that the
 * data survives the process instead of lingering in module state.
 *
 * Usage: DSH_HOME=<temp dir> node test/roundtrip.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const home = process.env.DSH_HOME;
if (!home) throw new Error('DSH_HOME is required');

const dataDir = path.join(home, 'dsh-memory-layers');
const hotRaw = readFileSync(path.join(dataDir, 'hot.md'), 'utf8');
const hot = hotRaw.split('<!-- candidates:start -->')[0].trim();

const coldDir = path.join(dataDir, 'cold');
let coldEntries = 0;
for (const month of readdirSync(coldDir)) {
  for (const file of readdirSync(path.join(coldDir, month))) {
    if (!file.endsWith('.md')) continue;
    const text = readFileSync(path.join(coldDir, month, file), 'utf8');
    coldEntries += text.split(/\r?\n/).filter((line) => line.trim().startsWith('- [')).length;
  }
}

process.stdout.write(JSON.stringify({ hot, coldEntries }));
