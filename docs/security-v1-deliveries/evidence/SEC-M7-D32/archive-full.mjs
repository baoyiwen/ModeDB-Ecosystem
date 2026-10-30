/** Archive explicit public reports/builds only. Never copy an instance tree. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, lstatSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertFullCheckReport,
  assertNoPublicSecrets,
} from '../../../../scripts/security-full-contract.mjs';
import { sha256 } from '../../../../scripts/security-install-contract.mjs';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D32/';
const root = resolve(process.argv[2] ?? '');
assert.ok(
  process.argv.length === 3 ||
    (process.argv.length === 4 && process.argv[3] === '--replace-with-final'),
);
const replaceFinal = process.argv[3] === '--replace-with-final';
assert.equal(dirname(root), resolve(tmpdir()));
assert.match(root.split(sep).at(-1), /^ModeDB-Full-Check-[\w-]+$/);
const full = JSON.parse(readFileSync(join(root, 'full-check.json')));
assertFullCheckReport(full);
for (const [directory, pattern] of [
  [full.regression.root, /^ModeDB-Regression-[\w-]+$/],
  [full.browser.root, /^ModeDB-Browser-Candidate-[\w-]+$/],
]) {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.match(resolve(directory).split(sep).at(-1), pattern);
}
const safe = (directory, name) => {
  const path = resolve(directory, name),
    rel = relative(directory, path);
  assert.ok(rel && !rel.startsWith('..') && !rel.includes(':'));
  let current = resolve(directory);
  assert.equal(lstatSync(current).isSymbolicLink(), false);
  for (const part of rel.split(sep)) {
    current = join(current, part);
    assert.equal(lstatSync(current).isSymbolicLink(), false);
  }
  assert.equal(lstatSync(path).isFile(), true);
  return path;
};
const copy = (directory, name, destination) => {
  const bytes = readFileSync(safe(directory, name));
  assertNoPublicSecrets(bytes);
  const path = base + destination;
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    assert.equal(replaceFinal, true, 'FULL_ARCHIVE_ALREADY_EXISTS');
    assert.equal(lstatSync(path).isSymbolicLink(), false);
    const previous =
      base + 'pre-final-2/archived/' + destination.replace(/\.tap$/, '.tap.original.txt');
    mkdirSync(dirname(previous), { recursive: true });
    writeFileSync(previous, readFileSync(path), { flag: 'wx' });
    writeFileSync(path, bytes);
  } else {
    writeFileSync(path, bytes, { flag: 'wx' });
  }
};
for (const name of ['full-check.json', 'source-manifest.json']) copy(root, name, 'native/' + name);
for (const result of full.regression.results) {
  assert.equal(dirname(result.log), full.regression.root);
  copy(full.regression.root, result.name + '.log', 'regression/' + result.name + '.original.txt');
}
copy(full.regression.root, 'regression.json', 'regression/regression.json');
for (const command of full.commands) {
  assert.match(
    command.name,
    /^(registration|authentication|recipients|asset|delivery|security-registration-storage-check|security-registration-consumer-check)$/,
  );
  copy(root, command.name + '.original.txt', 'native/' + command.name + '.original.txt');
  copy(root, 'command-' + command.name + '.json', 'native/command-' + command.name + '.json');
}
copy(full.browser.root, 'candidate-manifest.json', 'browser/candidate-manifest.json');
const manifest = JSON.parse(readFileSync(join(full.browser.root, 'candidate-manifest.json')));
for (const file of manifest.applications) {
  assert.match(file.path, /^(model-designer|data-studio|web)\/.+\.(js|css|html|svg)$/);
  assert.equal(
    sha256(readFileSync(safe(join(full.browser.root, 'builds'), file.path))),
    file.sha256,
  );
  copy(join(full.browser.root, 'builds'), file.path, 'browser/builds/' + file.path);
}
for (const group of full.browser.groups) copy(full.browser.root, group.log, 'browser/' + group.log);
process.stdout.write(
  JSON.stringify({
    ok: true,
    sourceSha256: full.sourceSha256,
    totalPass: full.totalPass,
    archive: base,
  }) + '\n',
);
