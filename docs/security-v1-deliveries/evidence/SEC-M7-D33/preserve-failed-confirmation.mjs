/** Preserve the complete public failed run and its original registration without rewriting it. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertNoPublicSecrets } from '../../../../scripts/security-full-contract.mjs';
import assert from 'node:assert/strict';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D33/pre-expiry-repair/';
const copy = (from, to) => {
  const bytes = readFileSync(from);
  assertNoPublicSecrets(bytes);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, bytes, { flag: 'wx' });
};
for (const [run, phase] of [
  ['jnDfwo', 'exploration'],
  ['YXTzpI', 'failed-confirmation'],
]) {
  const root = join(process.env.TEMP, 'ModeDB-Performance-' + run);
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
  if (phase === 'exploration') copy(join(root, 'registration.json'), base + 'registration.json');
}
process.stdout.write(JSON.stringify({ ok: true, preservedFailure: true, publicOnly: true }) + '\n');
