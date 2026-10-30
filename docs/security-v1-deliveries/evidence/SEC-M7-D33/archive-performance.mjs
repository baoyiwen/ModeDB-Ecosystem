/** Copy only explicit public measurement outputs; never walk a generated instance directory. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertNoPublicSecrets } from '../../../../scripts/security-full-contract.mjs';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D33/';
function copy(source, target) {
  const bytes = readFileSync(source);
  assertNoPublicSecrets(bytes);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes, { flag: 'wx' });
}
const args = process.argv.slice(2);
assert.ok(
  args.length >= 3,
  'Usage: archive-performance <explore-root> <confirm-root> <registration> [failed-report ...]',
);
for (const [index, phase] of ['exploration', 'confirmation'].entries()) {
  const root = args[index];
  for (const name of [
    'performance.json',
    'source-manifest.json',
    'candidate-manifest.json',
    ...Array.from({ length: 4 }, (_, i) => 'block-' + i + '.json'),
  ])
    copy(join(root, name), base + phase + '/' + name);
  const candidate = JSON.parse(readFileSync(join(root, 'candidate-manifest.json')));
  for (const file of candidate.files) {
    assert.match(file.path, /^(?:index\.html|assets\/[A-Za-z0-9_.-]+\.(?:js|css))$/);
    copy(join(root, 'designer', file.path), base + phase + '/designer/' + file.path);
  }
}
copy(args[2], base + 'registration.json');
for (const [i, path] of args.slice(3).entries())
  copy(path, base + 'development-failures/' + String(i + 1).padStart(2, '0') + '.json');
process.stdout.write(JSON.stringify({ ok: true, publicOnly: true }) + '\n');
