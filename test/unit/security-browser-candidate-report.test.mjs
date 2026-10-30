import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { candidateGroups, hostileBrowserChecks, parseHostileBrowserTap, snapshotCandidateDirectory, validateCandidateResults } from '../../scripts/security-browser-candidate-check.mjs';

const browser = () => ({ format: 'modeldb.hostile-browser.v1', ok: true, browser: 'Chrome/156.0.0.0', hardwareAuthenticatorTested: false, systemTrustInstalled: false, liveMaterialRead: false, checks: Object.fromEntries(hostileBrowserChecks.map(k => [k, true])) });
const tap = (record = browser()) => '# ' + JSON.stringify(record) + '\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
const result = () => ({ format: 'modeldb.browser-candidate-check.v1', task: 'DR-P3.6', platform: 'win32', ok: true, candidateSha256: 'a'.repeat(64), totalNativePass: 9, groups: candidateGroups.map(([name], i) => ({ name, log: name + '.tap', exitCode: 0, timedOut: false, ok: true, candidateSha256: 'a'.repeat(64), unit: { pass: [2, 1, 1, 1, 3, 1][i], fail: 0, skip: 0, cancelled: 0, todo: 0 } })), build: { applications: ['model-designer', 'data-studio', 'web'], configFile: false, envFile: false, existingDistUnchanged: true, sourceUnchanged: true, buildUnchanged: true, singleCandidate: true }, scope: { temporarySyntheticOnly: true, liveMaterialRead: false, hardwareAuthenticatorTested: false, systemTrustInstalled: false, lanTested: false, fullReleaseInstallTested: false } });

test('hostile browser parser requires real Chrome and every defense', () => {
  assert.equal(parseHostileBrowserTap(tap(), 0).unit.pass, 1);
  for (const key of hostileBrowserChecks) { const record = browser(); record.checks[key] = false; assert.throws(() => parseHostileBrowserTap(tap(record), 0)); }
});
test('hostile parser rejects missing or duplicated records and summary drift', () => {
  for (const source of [tap().replace('# tests 1', ''), tap().replace('# pass 1', '# pass 2'), tap().replace('# skipped 0', '# skipped 1'), tap().replace('# todo 0', '# todo 1'), tap() + '# pass 1\n', tap() + '# ' + JSON.stringify(browser()) + '\n', tap() + 'not ok 2 - synthetic\n', tap() + '# synthetic SKIP\n']) assert.throws(() => parseHostileBrowserTap(source, 0));
  assert.throws(() => parseHostileBrowserTap(tap(), 1));
});
test('hostile parser rejects invented hardware, trust or live environment evidence', () => {
  for (const key of ['hardwareAuthenticatorTested', 'systemTrustInstalled', 'liveMaterialRead']) { const record = browser(); record[key] = true; assert.throws(() => parseHostileBrowserTap(tap(record), 0)); }
  const record = browser(); record.browser = 'Synthetic'; assert.throws(() => parseHostileBrowserTap(tap(record), 0));
});
test('candidate requires all six groups on one build and exact successful units', () => {
  assert.equal(validateCandidateResults(result()), true);
  for (const edit of [r => r.groups.pop(), r => r.groups.reverse(), r => r.groups[0].candidateSha256 = 'b'.repeat(64), r => r.groups[1].unit.skip = 1, r => r.groups[2].exitCode = 1, r => r.groups[3].timedOut = true, r => r.groups[4].unit.pass++, r => r.groups[5].ok = false, r => r.groups[5].log = '../other.tap', r => r.totalNativePass++]) { const r = result(); edit(r); assert.throws(() => validateCandidateResults(r)); }
});
test('candidate rejects stale build, source drift and expanded scope', () => {
  for (const key of ['singleCandidate', 'sourceUnchanged', 'buildUnchanged', 'existingDistUnchanged']) { const r = result(); r.build[key] = false; assert.throws(() => validateCandidateResults(r)); }
  for (const key of ['configFile', 'envFile']) { const r = result(); r.build[key] = true; assert.throws(() => validateCandidateResults(r)); }
  for (const key of ['liveMaterialRead', 'hardwareAuthenticatorTested', 'systemTrustInstalled', 'lanTested', 'fullReleaseInstallTested']) { const r = result(); r.scope[key] = true; assert.throws(() => validateCandidateResults(r)); }
});
test('candidate snapshot is stable and detects mutation, removal and additions', () => {
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Candidate-Snapshot-')); mkdirSync(join(root, 'assets')); writeFileSync(join(root, 'index.html'), '<main>synthetic</main>'); writeFileSync(join(root, 'assets/app.js'), 'synthetic');
  const before = snapshotCandidateDirectory(root); assert.deepEqual(snapshotCandidateDirectory(root), before);
  writeFileSync(join(root, 'assets/app.js'), 'changed'); assert.notDeepEqual(snapshotCandidateDirectory(root), before);
  writeFileSync(join(root, 'added.css'), 'body{}'); assert.equal(snapshotCandidateDirectory(root).length, before.length + 1);
  unlinkSync(join(root, 'assets/app.js')); assert.equal(snapshotCandidateDirectory(root).some(file => file.path === 'assets/app.js'), false);
});
test('candidate snapshot rejects a directory junction', () => {
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Candidate-Link-')); mkdirSync(join(root, 'source')); writeFileSync(join(root, 'source/file.js'), 'synthetic'); symlinkSync(join(root, 'source'), join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); assert.throws(() => snapshotCandidateDirectory(root), /CANDIDATE_LINK_REJECTED/);
});
