/** Freeze completed DR-P4.4 reports and development hashes; no runtime inputs. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../../../../scripts/security-install-contract.mjs';
import { verifyFullEvidence } from '../../../../scripts/security-full-evidence.mjs';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D32/',
  previousPath = 'docs/security-v1-deliveries/evidence/SEC-M7-D31/acceptance.json';
const read = (path) => readFileSync(path),
  json = (path) => JSON.parse(read(path)),
  save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const descriptor = (path) => ({ path, sha256: sha256(read(path)) });
const previous = json(previousPath),
  full = json(base + 'native/full-check.json'),
  source = json(base + 'native/source-manifest.json');
assert.equal(full.ok, true);
for (const file of source.sources)
  assert.equal(sha256(read(file.path)), file.sha256, 'Frozen source changed: ' + file.path);
const milestones = read('docs/security-v1-milestones.md').toString('utf8');
assert.match(milestones, /DR-P4\.4[^\r\n]+完成（D32）/);
assert.match(milestones, /下一项开发任务 \| DR-P4\.5/);
const historicalEvidence = [
  ...previous.historicalEvidence,
  ...previous.verificationArtifacts,
  descriptor(previousPath),
];
assert.equal(new Set(historicalEvidence.map((f) => f.path)).size, historicalEvidence.length);
for (const file of historicalEvidence)
  assert.equal(sha256(read(file.path)), file.sha256, 'Historical bytes changed: ' + file.path);
const verification = {
  format: 'modeldb.full-verification.v1',
  revision: 'SEC-M7-D32',
  task: 'DR-P4.4',
  date: '2026-10-28',
  timezone: 'Asia/Shanghai',
  sourceSha256: full.sourceSha256,
  candidateSha256: full.browser.candidateSha256,
  tasks: { registration: '21/23', registrationP4: '4/6', registrationWorkPackages: '3/4' },
  unitFiles: full.regression.unitFiles.length,
  unitPass: full.regression.unit.pass,
  nativePass: 22,
  totalPass: full.totalPass,
  engineFlows: 6,
  historicalEvidenceVerified: historicalEvidence.length,
  scope: full.scope,
};
save(base + 'verification.json', verification);
const paths = [
  ...new Set([...previous.files.map((f) => f.path), ...source.sources.map((f) => f.path)]),
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
  revision: 'SEC-M7-D32',
  task: 'DR-P4.4',
  date: verification.date,
  baseCommit: previous.baseCommit,
  purpose:
    'Full safety/business regression, frozen fresh browser candidate and native recovery/authentication acceptance; no live, hardware, production or performance claim.',
  verification: { status: 'passed', report: base + 'verification.json' },
  currentResults: {
    unitPass: verification.unitPass,
    nativePass: 22,
    totalPass: full.totalPass,
    skip: 0,
    ...verification.tasks,
  },
  files,
  historicalEvidence,
  verificationArtifacts,
};
verifyFullEvidence({ read, receipt, base });
save(base + 'acceptance.json', receipt);
process.stdout.write(
  JSON.stringify({
    ok: true,
    developmentFiles: files.length,
    historicalEvidence: historicalEvidence.length,
    verificationArtifacts: verificationArtifacts.length,
    totalPass: full.totalPass,
    sourceSha256: full.sourceSha256,
  }) + '\n',
);
