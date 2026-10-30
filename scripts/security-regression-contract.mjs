/** Required full-regression results; no application configuration or runtime material. */
import assert from 'node:assert/strict';
export const engineIntegrations = [
  'e2e-engine-workflow',
  'relate-conserved-forest',
  'children-tree-query',
  'group-lateral-attach',
  'multi-branch-network',
  'protocol-operations',
];
export function parseRequiredTap(tap, exitCode) {
  assert.equal(exitCode, 0, 'REGRESSION_PROCESS_FAILED');
  assert.doesNotMatch(tap, /^not ok |^ok .*# (?:SKIP|TODO)\b/m);
  const counts = Object.fromEntries(
    ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map((key) => {
      const matches = [...tap.matchAll(new RegExp('^# ' + key + ' (\\d+)\\s*$', 'gm'))];
      assert.equal(matches.length, 1, 'REGRESSION_SUMMARY_REQUIRED: ' + key);
      return [key, Number(matches[0][1])];
    }),
  );
  assert.ok(counts.pass > 0);
  assert.equal(counts.tests, counts.pass);
  for (const key of ['fail', 'cancelled', 'skipped', 'todo']) {
    assert.equal(counts[key], 0, 'REGRESSION_INCOMPLETE: ' + key);
  }
  return { tests: counts.tests, pass: counts.pass, fail: 0, cancelled: 0, skip: 0, todo: 0 };
}
export function assertRegressionReport(report) {
  assert.equal(report.format, 'modeldb.security-regression.v1');
  assert.equal(report.ok, true);
  assert.ok(
    report.unitFiles.length > 0 && new Set(report.unitFiles).size === report.unitFiles.length,
  );
  assert.deepEqual(report.integrationScripts, engineIntegrations);
  assert.deepEqual(
    report.results.map((r) => r.name),
    ['unit', ...engineIntegrations],
  );
  for (const r of report.results) {
    assert.equal(r.exitCode, 0);
    assert.equal(r.timedOut, false);
  }
  assert.ok(report.unit.pass > 0);
  assert.equal(report.unit.tests, report.unit.pass);
  for (const key of ['fail', 'skip', 'cancelled', 'todo']) {
    assert.equal(report.unit[key], 0);
  }
}
