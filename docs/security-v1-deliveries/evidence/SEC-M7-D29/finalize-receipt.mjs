/** Bind DR-P4.1 only after real results exist. Reads development/evidence paths, never an instance. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { verifyRecipientEvidence } from '../../../../scripts/security-recipient-evidence.mjs';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D29/',
  previousPath = 'docs/security-v1-deliveries/evidence/SEC-M7-D28/acceptance.json';
const read = (path) => readFileSync(path),
  json = (path) => JSON.parse(read(path)),
  sha = (bytes) => createHash('sha256').update(bytes).digest('hex'),
  save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n'),
  descriptor = (path) => ({ path, sha256: sha(read(path)) });
const previous = json(previousPath),
  native = json(base + 'native/integration-check.json'),
  manifest = json(base + 'native/candidate-manifest.json');
assert.equal(native.ok, true);
assert.equal(json(base + 'unit.command.json').exitCode, 0);
for (const file of manifest.source)
  assert.equal(sha(read(file.path)), file.sha256, 'Candidate drift: ' + file.path);
const summary = (name) => {
  const text = read(base + name).toString('utf8'),
    out = {};
  for (const [raw, key] of [
    ['pass', 'pass'],
    ['fail', 'fail'],
    ['skipped', 'skip'],
    ['cancelled', 'cancelled'],
    ['todo', 'todo'],
  ]) {
    const matches = [...text.matchAll(new RegExp('^# ' + raw + ' (\\d+)\\s*$', 'gm'))];
    assert.equal(matches.length, 1);
    out[key] = Number(matches[0][1]);
  }
  for (const key of ['fail', 'skip', 'cancelled', 'todo']) assert.equal(out[key], 0);
  return out;
};
const unit = summary('unit.original.txt'),
  receiptUnit = summary('receipt-tools.original.txt');
const historicalEvidence = [
  ...previous.historicalEvidence,
  ...previous.verificationArtifacts,
  descriptor(previousPath),
];
for (const file of historicalEvidence)
  assert.equal(sha(read(file.path)), file.sha256, 'Historical bytes changed: ' + file.path);
const verification = {
  format: 'modeldb.recipient-verification.v1',
  revision: 'SEC-M7-D29',
  task: 'DR-P4.1',
  date: '2026-10-28',
  timezone: 'America/New_York',
  node: json(base + 'unit.command.json').node,
  browserNode: native.node,
  platform: process.platform,
  candidateSha256: native.candidateSha256,
  tasks: {
    v1Milestones: '7/7',
    v1: '20/20',
    registration: '18/23',
    registrationP1: '6/6',
    registrationP2: '5/5',
    registrationP3: '6/6',
    registrationP4: '1/6',
    registrationWorkPackages: '3/4',
  },
  unit,
  receiptUnit,
  nativePass: 1,
  totalTargetedPass: unit.pass + receiptUnit.pass + 1,
  checks: Object.fromEntries(
    [
      'protocolAndRecovery',
      'atomicProofAndHistory',
      'strictTypes',
      'browserBoundary',
      'localizedUi',
      'documents',
      'materialGuard',
    ].map((k) => [k, true]),
  ),
  historicalEvidenceVerified: historicalEvidence.length,
  scope: {
    temporarySyntheticOnly: true,
    liveMaterialRead: false,
    realTwoDeviceTested: false,
    hardwareAuthenticatorTested: false,
    packageDeliveryTested: false,
    fullReleaseInstallTested: false,
    performanceTested: false,
    physicalDiskFullTested: false,
    productionMigrationPerformed: false,
  },
};
save(base + 'verification.json', verification);
const extra = [
  'docs/security-v1/recipient-key-contract.md',
  'scripts/security-recipient-check.mjs',
  'scripts/security-recipient-key.ts',
  'scripts/security-recipient-evidence.mjs',
  'test/unit/security-recipient-keys.test.ts',
  'test/unit/security-recipient-report.test.mjs',
  'test/unit/security-recipient-evidence.test.mjs',
  'test/integration/security-recipient-keys-browser.test.ts',
];
const paths = [
  ...new Set([
    ...previous.files.map((f) => f.path),
    ...manifest.source.map((f) => f.path),
    ...extra,
  ]),
].sort();
const files = paths.map((path) => ({
  ...descriptor(path),
  sha256Lf: sha(read(path).toString('utf8').replace(/\r\n/g, '\n')),
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
  revision: 'SEC-M7-D29',
  task: 'DR-P4.1',
  date: verification.date,
  baseCommit: previous.baseCommit,
  purpose:
    'Independent recipient encryption keys, bounded OAEP possession proof, explicit V5 migration, version history and local UI/offline holder tool. No live instance, package delivery, hardware, install or performance claim.',
  verification: { status: 'passed', report: base + 'verification.json' },
  currentResults: {
    targetedUnitPass: unit.pass + receiptUnit.pass,
    nativePass: 1,
    totalTargetedPass: verification.totalTargetedPass,
    skip: 0,
    registration: '18/23',
    registrationP4: '1/6',
    registrationWorkPackages: '3/4',
  },
  files,
  historicalEvidence,
  verificationArtifacts,
};
verifyRecipientEvidence({ read, receipt, base });
save(base + 'acceptance.json', receipt);
console.log(
  JSON.stringify({
    ok: true,
    developmentFiles: files.length,
    historicalEvidence: historicalEvidence.length,
    verificationArtifacts: verificationArtifacts.length,
    totalTargetedPass: verification.totalTargetedPass,
    candidateSha256: native.candidateSha256,
  }),
);
