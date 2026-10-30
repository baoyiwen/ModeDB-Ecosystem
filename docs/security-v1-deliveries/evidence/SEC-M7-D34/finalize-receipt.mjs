/** Freeze preparation evidence; deliberately cannot close DR-P4.6. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { digest } from '../../../../scripts/security-device-drill-contract.mjs';
import { verifyDevicePreparationEvidence } from '../../../../scripts/security-device-drill-evidence.mjs';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D34/', previousPath = 'docs/security-v1-deliveries/evidence/SEC-M7-D33/acceptance.json';
const read = (path) => readFileSync(path), json = (path) => JSON.parse(read(path)), save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const descriptor = (path) => ({ path, sha256: digest(read(path)) });
const previous = json(previousPath), source = json(base + 'source-manifest.json'), smoke = json(base + 'smoke-report.json');
for (const file of source.files) assert.equal(digest(read(file.path).toString('utf8').replace(/\r\n/g, '\n')), file.sha256, 'DEVICE_CURRENT_SOURCE_CHANGED');
const tap = read(base + 'unit.original.txt').toString('utf8'), unitPass = Number(tap.match(/^# pass (\d+)$/m)?.[1]);
assert.equal(unitPass, 59);
const verification = { format: 'modeldb.device-drill-preparation-verification.v1', revision: 'SEC-M7-D34', task: 'DR-P4.6', taskStatus: 'waiting-for-actual-devices', taskComplete: false, date: '2026-10-29', sourceSha256: smoke.sourceSha256, unitPass, tasks: { registration: '22/23', registrationP4: '5/6', registrationWorkPackages: '3/4' }, actualHelloTested: false, twoDeviceTested: false, liveMaterialRead: false, systemTrustInstalled: false };
save(base + 'verification.json', verification);
const docs = spawnSync(process.execPath, [base + 'document-check.mjs'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
writeFileSync(base + 'documents.original.txt', (docs.stdout ?? '') + (docs.stderr ?? ''));
assert.equal(docs.status, 0, 'DEVICE_DOCUMENTS_FAILED');
const historicalEvidence = [...previous.historicalEvidence, ...previous.verificationArtifacts, descriptor(previousPath)];
assert.equal(historicalEvidence.length, 1788);
assert.equal(new Set(historicalEvidence.map((f) => f.path)).size, historicalEvidence.length);
for (const file of historicalEvidence) assert.equal(digest(read(file.path)), file.sha256, 'DEVICE_HISTORICAL_BYTES_CHANGED');
const paths = [...new Set([...previous.files.map((f) => f.path), ...source.files.map((f) => f.path), 'docs/security-v1/windows-device-drill-guide.md'])].sort();
const files = paths.map((path) => ({ ...descriptor(path), sha256Lf: digest(read(path).toString('utf8').replace(/\r\n/g, '\n')) }));
const verificationArtifacts = [];
function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name).replaceAll('\\', '/'), stat = lstatSync(path);
    assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory()) walk(path);
    else if (path !== base + 'acceptance.json') verificationArtifacts.push(descriptor(path));
  }
}
walk(base);
const receipt = { format: 'modeldb.security-release-recheck.v1', revision: 'SEC-M7-D34', task: 'DR-P4.6', date: verification.date, baseCommit: previous.baseCommit, purpose: 'Assisted Windows drill preparation only. Actual Hello, two-device and recovery-policy execution remain pending.', verification: { status: 'preparation-passed', report: base + 'verification.json' }, currentResults: { ...verification.tasks, taskComplete: false }, files, historicalEvidence, verificationArtifacts };
verifyDevicePreparationEvidence({ read, receipt, base });
save(base + 'acceptance.json', receipt);
process.stdout.write(JSON.stringify({ ok: true, unitPass, developmentFiles: files.length, historicalEvidence: historicalEvidence.length, verificationArtifacts: verificationArtifacts.length, taskComplete: false }) + '\n');
