/** Freeze DR-P4.5 metadata after actual independent confirmation and documentation checks. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../../../../scripts/security-install-contract.mjs';
import { digest } from '../../../../scripts/security-performance-contract.mjs';
import { verifyPerformanceEvidence } from '../../../../scripts/security-performance-evidence.mjs';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D33/',
  previousPath = 'docs/security-v1-deliveries/evidence/SEC-M7-D32/acceptance.json';
const read = (path) => readFileSync(path),
  json = (path) => JSON.parse(read(path)),
  save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const descriptor = (path) => ({ path, sha256: sha256(read(path)) });
const previous = json(previousPath),
  report = json(base + 'confirmation/performance.json'),
  source = json(base + 'confirmation/source-manifest.json');
assert.equal(report.ok, true);
for (const file of source.sources)
  assert.equal(
    sha256(read(file.path)),
    file.sha256,
    'PERFORMANCE_FROZEN_SOURCE_CHANGED: ' + file.path,
  );
const historicalEvidence = [
  ...previous.historicalEvidence,
  ...previous.verificationArtifacts,
  descriptor(previousPath),
];
assert.equal(historicalEvidence.length, 1666);
assert.equal(new Set(historicalEvidence.map((f) => f.path)).size, historicalEvidence.length);
for (const file of historicalEvidence)
  assert.equal(sha256(read(file.path)), file.sha256, 'HISTORICAL_BYTES_CHANGED');
assert.match(read('docs/security-v1-milestones.md').toString(), /DR-P4\.5[^\r\n]+完成（D33）/);
const verification = {
  format: 'modeldb.performance-verification.v1',
  revision: 'SEC-M7-D33',
  task: 'DR-P4.5',
  date: '2026-10-28',
  timezone: 'Asia/Shanghai',
  sourceSha256: report.sourceSha256,
  confirmationSha256: digest(report),
  tasks: { registration: '22/23', registrationP4: '5/6', registrationWorkPackages: '3/4' },
  sampleCount: report.samples.length,
  historicalEvidenceVerified: historicalEvidence.length,
  scope: report.scope,
};
save(base + 'verification.json', verification);
const extra = ['docs/security-v1/performance-guide.md'];
const paths = [
  ...new Set([
    ...previous.files.map((f) => f.path),
    ...source.sources.map((f) => f.path),
    ...extra,
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
      stat = lstatSync(path);
    assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory()) walk(path);
    else if (path !== base + 'acceptance.json') verificationArtifacts.push(descriptor(path));
  }
}
walk(base);
const receipt = {
  format: 'modeldb.security-release-recheck.v1',
  revision: 'SEC-M7-D33',
  task: 'DR-P4.5',
  date: verification.date,
  baseCommit: previous.baseCommit,
  purpose:
    'Independent preregistered AB-BA performance, native pending-capacity flood and OS-local repair observations; no production or hardware claim.',
  verification: { status: 'passed', report: base + 'verification.json' },
  currentResults: { sampleCount: report.samples.length, ...verification.tasks },
  files,
  historicalEvidence,
  verificationArtifacts,
};
verifyPerformanceEvidence({ read, receipt, base });
save(base + 'acceptance.json', receipt);
process.stdout.write(
  JSON.stringify({
    ok: true,
    developmentFiles: files.length,
    historicalEvidence: historicalEvidence.length,
    verificationArtifacts: verificationArtifacts.length,
    sampleCount: report.samples.length,
  }) + '\n',
);
