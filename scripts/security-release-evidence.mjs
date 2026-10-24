/** Read-only acceptance integrity checks; never opens an instance or runtime directory. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const receiptPath = 'docs/security-v1-deliveries/evidence/SEC-M7-D03/acceptance.json';
const historicalRoot = 'docs/security-v1-deliveries/evidence/SEC-M7-D02/';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function readDevelopment(root, relative) {
  assert.ok(
    typeof relative === 'string' &&
      !relative.includes('\\') &&
      !relative.includes(':') &&
      relative.split('/').every((part) => part !== '' && part !== '.' && part !== '..') &&
      (/^(docs|scripts|test|apps|packages)\/.+\.(json|md|mjs|js|ts|tsx|css|txt)$/.test(relative) ||
        ['package.json', '.gitignore', '.gitattributes'].includes(relative)) &&
      !relative.split('/').includes('modeldb.config.json'),
    'EVIDENCE_DEVELOPMENT_PATH_REQUIRED',
  );
  let current = root;
  for (const part of relative.split('/')) {
    current = join(current, part);
    assert.ok(!lstatSync(current).isSymbolicLink(), 'EVIDENCE_LINK_REJECTED');
  }
  assert.ok(lstatSync(current).isFile(), 'EVIDENCE_FILE_REQUIRED');
  return readFileSync(current);
}

export function verifyReleaseEvidence(root = repository) {
  root = realpathSync(root);
  const read = (path) => readDevelopment(root, path);
  const json = (path) => JSON.parse(read(path).toString('utf8'));
  const receipt = json(receiptPath);
  assert.equal(receipt.format, 'modeldb.security-release-recheck.v1');
  assert.ok(receipt.files.length > 0 && receipt.historicalEvidence.length > 0);
  const seen = new Set();
  let normalizedFiles = 0;
  for (const file of receipt.files) {
    assert.ok(!seen.has(file.path), 'EVIDENCE_DUPLICATE_PATH');
    seen.add(file.path);
    const bytes = read(file.path);
    if (sha256(bytes) !== file.sha256) {
      assert.match(file.sha256Lf, /^[a-f0-9]{64}$/);
      assert.equal(
        sha256(bytes.toString('utf8').replace(/\r\n/g, '\n')),
        file.sha256Lf,
        `EVIDENCE_SOURCE_CHANGED: ${file.path}`,
      );
      normalizedFiles++;
    }
  }
  for (const file of receipt.historicalEvidence) {
    assert.ok(file.path.startsWith(historicalRoot), 'EVIDENCE_HISTORICAL_PATH_REQUIRED');
    assert.equal(sha256(read(file.path)), file.sha256, `EVIDENCE_REPORT_CHANGED: ${file.path}`);
  }

  const acceptance = json(historicalRoot + 'acceptance.json');
  const regression = json(historicalRoot + 'regression.json');
  const browser = json(historicalRoot + 'browser.json');
  const performance = json(historicalRoot + 'performance.json');
  const originalPerformance = json(historicalRoot + 'performance.original.json.txt');
  const equivalence = json(historicalRoot + 'equivalence.json');
  const originalCandidate = json(historicalRoot + 'release-candidate.original.json.txt');
  assert.deepEqual(json(historicalRoot + 'release-candidate.json'), originalCandidate);
  assert.deepEqual(performance, originalPerformance);
  assert.deepEqual(
    json(historicalRoot + 'performance-exploratory.json'),
    json(historicalRoot + 'performance-exploratory.original.json.txt'),
  );
  for (const descriptor of [
    equivalence.testedManifest,
    equivalence.deliveryManifest,
    equivalence.verificationReport,
  ]) {
    assert.equal(sha256(read(historicalRoot + descriptor.path)), descriptor.sha256);
  }
  assert.equal(performance.releaseManifestSha256, equivalence.testedManifest.sha256);
  assert.ok(Object.values(performance.checks).every((passed) => passed === true));
  assert.ok(Object.values(equivalence.checks).every((passed) => passed === true));
  assert.equal(acceptance.finalStaticChecks.status, 'passed');
  assert.equal(acceptance.finalStaticChecks.exitCode, 0);
  assert.equal(regression.unit.pass, 424);
  assert.equal(regression.unit.fail, 0);
  assert.equal(regression.unit.skip, 0);
  assert.equal(regression.unitFiles.length, 63);
  assert.equal(regression.results.length, 7);
  assert.ok(regression.results.every((result) => result.exitCode === 0));
  assert.equal(browser.pass, 2);
  assert.equal(browser.fail, 0);
  assert.equal(browser.skip, 0);
  assert.equal(originalCandidate.packages.length, 7);
  assert.equal(originalCandidate.apps.length, 3);
  for (const metric of Object.values(performance.metrics)) {
    assert.ok(metric.registry.samplesMs.length > 0 && metric.legacy.samplesMs.length > 0);
  }
  return {
    ok: true,
    developmentFiles: receipt.files.length,
    normalizedFiles,
    historicalEvidenceFiles: receipt.historicalEvidence.length,
    historicalUnitPass: regression.unit.pass,
    historicalBrowserPass: browser.pass,
    runtimeMaterialRead: false,
    scope: 'Recorded evidence and current development files; does not rerun functional acceptance.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 2, 'Usage: node scripts/security-release-evidence.mjs');
    process.stdout.write(JSON.stringify(verifyReleaseEvidence(), null, 2) + '\n');
  } catch (error) {
    process.stderr.write(String(error.message) + '\n');
    process.exitCode = 1;
  }
}
