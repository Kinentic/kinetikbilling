import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const srcDir = fileURLToPath(new URL('../', import.meta.url));
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true, recursive: true })
  .filter((e) => e.isFile() && e.name.endsWith('.ts'))
  .map((e) => `${e.parentPath}/${e.name}`);

test('nothing outside src/coding imports a coding file other than index.ts', () => {
  const offenders: string[] = [];
  for (const file of walk(srcDir)) {
    if (file.includes('/coding/')) continue;
    for (const m of readFileSync(file, 'utf8').matchAll(/from '([^']*\/coding\/[^']*)'/g)) {
      if (!m[1]!.endsWith('/coding/index.ts')) offenders.push(`${file.slice(srcDir.length)} imports ${m[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
});
