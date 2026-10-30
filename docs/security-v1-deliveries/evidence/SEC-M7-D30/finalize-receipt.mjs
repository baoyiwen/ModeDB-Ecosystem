/** Bind DR-P4.2 only after real results exist. Reads development/evidence paths, never an instance. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { verifyRecipientDeliveryEvidence } from '../../../../scripts/security-recipient-delivery-evidence.mjs';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D30/',
  previousPath = 'docs/security-v1-deliveries/evidence/SEC-M7-D29/acceptance.json';
const read = (path) => readFileSync(path),
  json = (path) => JSON.parse(read(path)),
  sha = (bytes) => createHash('sha256').update(bytes).digest('hex'),
  save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n'),
  descriptor = (path) => ({ path, sha256: sha(read(path)) });
const previous = json(previousPath),
  native = json(base + 'native/integration-check.json'),
  manifest = json(base + 'native/source-manifest.json');
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
  format: 'modeldb.recipient-delivery-verification.v1',
  revision: 'SEC-M7-D30',
  task: 'DR-P4.2',
  date: '2026-10-28',
  timezone: 'Asia/Shanghai',
  node: json(base + 'unit.command.json').node,
  nativeNode: native.node,
  platform: process.platform,
  candidateSha256: native.candidateSha256,
  tasks: {
    v1Milestones: '7/7',
    v1: '20/20',
    registration: '19/23',
    registrationP1: '6/6',
    registrationP2: '5/5',
    registrationP3: '6/6',
    registrationP4: '2/6',
    registrationWorkPackages: '3/4',
  },
  unit,
  receiptUnit,
  nativePass: 1,
  totalTargetedPass: unit.pass + receiptUnit.pass + 1,
  checks: Object.fromEntries(
    [
      'exactRecipientAndCas',
      'atomicSealingAudit',
      'existingFormatsAndRecovery',
      'strictTypes',
      'browserBoundary',
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
    frontendChanged: false,
    packageDeliveryTested: true,
    fullReleaseInstallTested: false,
    performanceTested: false,
    physicalDiskFullTested: false,
    productionMigrationPerformed: false,
  },
};
save(base + 'verification.json', verification);
const extra = [
  'scripts/security-recipient-delivery-check.mjs',
  'scripts/security-recipient-delivery-evidence.mjs',
  'packages/server/src/cli-recipient-delivery.ts',
  'packages/server/src/cli-recipient-list.ts',
  'packages/server/src/security/recipient-delivery.ts',
  'test/fixtures/security-recipient-delivery.ts',
  'test/unit/security-recipient-delivery.test.ts',
  'test/unit/security-recipient-delivery-report.test.mjs',
  'test/unit/security-recipient-delivery-evidence.test.mjs',
  'test/integration/security-recipient-delivery-native.test.ts',
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
  revision: 'SEC-M7-D30',
  task: 'DR-P4.2',
  date: verification.date,
  baseCommit: previous.baseCommit,
  purpose:
    'Offline delivery to exact verified recipients through existing backup and asset formats, atomic sealing audit and native independent-key recovery. No live instance, UI, hardware, install or performance claim.',
  verification: { status: 'passed', report: base + 'verification.json' },
  currentResults: {
    targetedUnitPass: unit.pass + receiptUnit.pass,
    nativePass: 1,
    totalTargetedPass: verification.totalTargetedPass,
    skip: 0,
    registration: '19/23',
    registrationP4: '2/6',
    registrationWorkPackages: '3/4',
  },
  files,
  historicalEvidence,
  verificationArtifacts,
};
verifyRecipientDeliveryEvidence({ read, receipt, base });
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
