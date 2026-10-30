/** Freeze only completed DR-P4.3 development evidence; never reads instance state. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../../../../scripts/security-install-contract.mjs';
import { verifyInstallEvidence } from '../../../../scripts/security-install-evidence.mjs';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D31/',
  previousPath = 'docs/security-v1-deliveries/evidence/SEC-M7-D30/acceptance.json';
const read = (path) => readFileSync(path),
  json = (path) => JSON.parse(read(path)),
  save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const descriptor = (path) => ({ path, sha256: sha256(read(path)) });
const previous = json(previousPath),
  native = json(base + 'native/install-check.json'),
  manifest = json(base + 'native/release-candidate.json');
assert.equal(native.ok, true);
for (const file of [...manifest.sourceFiles, ...manifest.documentation])
  assert.equal(sha256(read(file.path)), file.sha256, 'Candidate drift: ' + file.path);
const summary = (name) => {
  const text = read(base + name + '.original.txt').toString('utf8'),
    out = {};
  for (const [label, key] of [
    ['pass', 'pass'],
    ['fail', 'fail'],
    ['skipped', 'skip'],
    ['cancelled', 'cancelled'],
    ['todo', 'todo'],
  ]) {
    const matches = [...text.matchAll(new RegExp('^# ' + label + ' (\\d+)\\s*$', 'gm'))];
    assert.equal(matches.length, 1);
    out[key] = Number(matches[0][1]);
  }
  for (const key of ['fail', 'skip', 'cancelled', 'todo']) assert.equal(out[key], 0);
  return out;
};
const unit = summary('unit'),
  receiptUnit = summary('receipt-tools');
const historicalEvidence = [
  ...previous.historicalEvidence,
  ...previous.verificationArtifacts,
  descriptor(previousPath),
];
for (const file of historicalEvidence)
  assert.equal(sha256(read(file.path)), file.sha256, 'Historical bytes changed: ' + file.path);
const verification = {
  format: 'modeldb.install-verification.v1',
  revision: 'SEC-M7-D31',
  task: 'DR-P4.3',
  date: '2026-10-28',
  timezone: 'Asia/Shanghai',
  candidateSha256: native.releaseManifestSha256,
  tasks: { registration: '20/23', registrationP4: '3/6', registrationWorkPackages: '3/4' },
  unit,
  receiptUnit,
  nativePass: 1,
  totalTargetedPass: unit.pass + receiptUnit.pass + 1,
  historicalEvidenceVerified: historicalEvidence.length,
  scope: {
    temporarySyntheticOnly: true,
    installedCandidateTested: true,
    liveMaterialRead: false,
    realTwoDeviceTested: false,
    hardwareAuthenticatorTested: false,
    performanceTested: false,
    fullHistoricalPackageDowngradeTested: false,
    productionMigrationPerformed: false,
    frontendChanged: false,
  },
};
save(base + 'verification.json', verification);
const paths = [
  ...new Set([
    ...previous.files.map((f) => f.path),
    ...manifest.sourceFiles.map((f) => f.path),
    ...manifest.documentation.map((f) => f.path),
    'scripts/security-install-evidence.mjs',
    'test/unit/security-install-contract.test.mjs',
    'test/unit/security-install-evidence.test.mjs',
  ]),
].sort();
const files = paths.map((path) => ({
  ...descriptor(path),
  sha256Lf: sha256(read(path).toString('utf8').replace(/\r\n/g, '\n')),
}));
const verificationArtifacts = [];
function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name).replaceAll('\\', '/'),
      s = lstatSync(path);
    assert.equal(s.isSymbolicLink(), false);
    if (s.isDirectory()) walk(path);
    else if (path !== base + 'acceptance.json') verificationArtifacts.push(descriptor(path));
  }
}
walk(base);
const receipt = {
  format: 'modeldb.security-release-recheck.v1',
  revision: 'SEC-M7-D31',
  task: 'DR-P4.3',
  date: verification.date,
  baseCommit: previous.baseCommit,
  purpose:
    'Fresh seven-package/three-frontend candidate, actual offline installation, installed minified-JS synthetic upgrade and disable acceptance. Frozen V1 reader with current helpers only; no complete historical binary, hardware, production or performance claim.',
  verification: { status: 'passed', report: base + 'verification.json' },
  currentResults: {
    targetedUnitPass: unit.pass + receiptUnit.pass,
    nativePass: 1,
    totalTargetedPass: verification.totalTargetedPass,
    skip: 0,
    ...verification.tasks,
  },
  files,
  historicalEvidence,
  verificationArtifacts,
};
verifyInstallEvidence({ read, receipt, base });
save(base + 'acceptance.json', receipt);
process.stdout.write(
  JSON.stringify({
    ok: true,
    developmentFiles: files.length,
    historicalEvidence: historicalEvidence.length,
    verificationArtifacts: verificationArtifacts.length,
    totalTargetedPass: verification.totalTargetedPass,
    candidateSha256: native.releaseManifestSha256,
  }) + '\n',
);
