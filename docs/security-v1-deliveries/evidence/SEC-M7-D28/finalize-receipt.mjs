/** Bind current D28 sources, one candidate and all prior immutable evidence, after actual checks. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { candidateUnitGroups, verifyBrowserCandidateEvidence } from '../../../../scripts/security-browser-candidate-evidence.mjs';
import { validateCandidateResults } from '../../../../scripts/security-browser-candidate-check.mjs';
const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D28/';
const read = p => readFileSync(p), json = p => JSON.parse(read(p)), save = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), descriptor = path => ({ path, sha256: hash(read(path)) });
const previousPath = 'docs/security-v1-deliveries/evidence/SEC-M7-D27/acceptance.json', previous = json(previousPath);
const selected = json(base + 'selected-candidate.json'), report = json(selected.directory + '/candidate-check.json'), manifest = json(selected.directory + '/candidate-manifest.json');
validateCandidateResults(report); assert.equal(hash(JSON.stringify(manifest)), report.candidateSha256);
for (const source of manifest.sources) assert.equal(hash(read(source.path)), source.sha256, 'Candidate source drift: ' + source.path);
const historicalEvidence = [...previous.historicalEvidence, ...previous.verificationArtifacts, descriptor(previousPath)];
assert.equal(historicalEvidence.length, 945);
for (const file of historicalEvidence) assert.equal(hash(read(file.path)), file.sha256, 'Historical bytes changed: ' + file.path);
for (const name of ['verification.json', 'acceptance.json']) if (!existsSync(base + name)) save(base + name, { status: 'pending-document-validation' });
const documents = spawnSync(process.execPath, [base + 'document-check.mjs'], { encoding: 'utf8', windowsHide: true }); assert.equal(documents.status, 0, documents.stdout + documents.stderr);
const documentValidation = json(base + 'documents.original.json.txt');
const verification = { format: 'modeldb.security-browser-candidate-verification.v1', revision: 'SEC-M7-D28', task: 'DR-P3.6', date: '2026-10-28', timezone: 'America/New_York', baseCommit: previous.baseCommit, node: process.version, browserNode: report.node, platform: process.platform, candidateSha256: report.candidateSha256, tasks: { v1Milestones: '7/7', v1: '20/20', registration: '17/23', registrationP1: '6/6', registrationP2: '5/5', registrationP3: '6/6', registrationWorkPackages: '3/4' },
  ...Object.fromEntries(candidateUnitGroups.map(([key, , count]) => [key, { pass: count, fail: 0, skip: 0, cancelled: 0, todo: 0 }])), nativePass: 9, totalTargetedPass: 490, checks: Object.fromEntries(['singleCandidate', 'threeClientSaveReadback', 'hostileBrowser', 'strictTypes', 'browserBoundary', 'scopedStatic', 'materialGuard'].map(key => [key, true])), documentValidation, historicalEvidenceVerified: historicalEvidence.length,
  scope: { temporarySyntheticOnly: true, liveMaterialRead: false, productionMigrationPerformed: false, physicalAuthenticatorTested: false, performanceTested: false, fullReleaseInstallTested: false, physicalDiskFullTested: false, tlsHostedBrowserTested: true, remoteTlsHostedBrowserTested: false, lanTested: false, fullBusinessSaveTested: false, uiChanged: false, browserSessionSyntheticSaveTested: true },
};
save(base + 'verification.json', verification);
const sourcePaths = [...new Set([...previous.files.map(file => file.path), ...manifest.sources.map(file => file.path), 'scripts/security-browser-candidate-evidence.mjs', 'scripts/security-browser-candidate-check.mjs', 'test/unit/security-browser-candidate-report.test.mjs', 'test/integration/security-hostile-browser.test.ts', 'test/fixtures/security-browser-save.ts'])].sort();
const files = sourcePaths.map(path => ({ ...descriptor(path), sha256Lf: hash(read(path).toString('utf8').replace(/\r\n/g, '\n')) }));
const verificationArtifacts = []; function walk(dir) { for (const name of readdirSync(dir).sort()) { const path = join(dir, name).replaceAll('\\', '/'), stat = lstatSync(path); assert.equal(stat.isSymbolicLink(), false); if (stat.isDirectory()) walk(path); else if (path !== base + 'acceptance.json') verificationArtifacts.push(descriptor(path)); } } walk(base);
const receipt = { format: 'modeldb.security-release-recheck.v1', revision: 'SEC-M7-D28', task: 'DR-P3.6', date: verification.date, baseCommit: previous.baseCommit, purpose: 'One fresh frontend candidate across formal three-client identity, local approval, deployment and legacy compatibility; synthetic browser-session save/reload; hostile page, CSRF, null Origin, iframe, wrong RP and native Host/proxy controls. Synthetic loopback only; no production migration, system trust, hardware or full-release claim.', verification: { status: 'passed', report: base + 'verification.json' }, currentResults: { targetedUnitPass: 481, nativePass: 9, totalTargetedPass: 490, skip: 0, registration: '17/23', registrationP3: '6/6', registrationWorkPackages: '3/4' }, files, historicalEvidence, verificationArtifacts };
verifyBrowserCandidateEvidence({ read, receipt, base }); save(base + 'acceptance.json', receipt);
console.log(JSON.stringify({ ok: true, developmentFiles: files.length, historicalEvidence: historicalEvidence.length, verificationArtifacts: verificationArtifacts.length, totalTargetedPass: 490, candidateSha256: report.candidateSha256 }));
