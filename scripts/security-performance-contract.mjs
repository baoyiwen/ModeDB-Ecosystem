/** Independent DR-P4.5 measurements. No instance/configuration inputs. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export const digest = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
export const method = Object.freeze({
  format: 'modeldb.security-performance-method.v1',
  order: ['A', 'B', 'B', 'A'],
  baseline: 'registry API credential',
  candidate: 'registry software WebAuthn and browser session',
  rows: 1000,
  batchRows: 10,
  concurrency: 1,
  warmupQueriesPerBlock: 2,
  counts: {
    registrationStart: 30,
    registrationProof: 30,
    login: 60,
    refresh: 30,
    query1000: 60,
    batchSave: 12,
    static: 30,
    revoke: 30,
    revocationProbe: 30,
  },
  baselineCounts: {
    credentialIssue: 30,
    query1000: 60,
    batchSave: 12,
    static: 30,
    revoke: 30,
    revocationProbe: 30,
  },
  floodRequests: 48,
  floodConcurrency: 48,
  pendingCapacity: 1000,
  publicRejectionAuditQueue: 64,
  tls: 'new verified loopback TLS connection per request; no TLS session reuse',
  resources:
    'server Node process CPU and peak RSS; DPAPI child wall time included, child CPU/RSS unmeasured',
  userVerification: 'software only; PIN/biometric/touch time excluded and unmeasured',
  audit: 'normal durable registry audit; no audit or OS protection bypass',
});
export function percentile(values, p) {
  assert.ok(values.length > 0);
  for (const value of values) {
    assert.ok(Number.isFinite(value) && value >= 0);
  }
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
}
export function summarize(samples) {
  const result = {};
  for (const group of ['A', 'B']) {
    for (const scenario of [
      ...new Set(samples.filter((s) => s.group === group).map((s) => s.scenario)),
    ]) {
      const rows = samples.filter((s) => s.group === group && s.scenario === scenario);
      result[group + '.' + scenario] = {
        count: rows.length,
        failures: rows.filter((s) => !s.ok).length,
        failureRate: rows.filter((s) => !s.ok).length / rows.length,
      };
      for (const key of [
        'clientMs',
        'serverMs',
        'tlsMs',
        'queueMs',
        'protectionMs',
        'verificationMs',
        'nodeCpuMs',
        'nodeRssMiB',
      ]) {
        const values = rows.map((s) => s[key]);
        result[group + '.' + scenario][key] = {
          p50: percentile(values, 0.5),
          p95: percentile(values, 0.95),
          max: Math.max(...values),
        };
      }
    }
  }
  return result;
}
export function assertMeasurements(report, size) {
  assert.equal(report.format, 'modeldb.security-performance.v1');
  assert.equal(report.ok, true);
  assert.equal(report.platform, 'win32');
  assert.deepEqual(report.method, method);
  assert.match(report.sourceSha256, /^[a-f0-9]{64}$/);
  assert.match(report.candidateSha256, /^[a-f0-9]{64}$/);
  assert.equal(report.sourceUnchanged, true);
  assert.equal(report.candidateUnchanged, true);
  assert.deepEqual(
    report.blocks.map((b) => b.group),
    method.order,
  );
  assert.deepEqual(
    report.blocks.map((b) => b.block),
    [0, 1, 2, 3],
  );
  assert.ok(report.blocks.every((b) => b.completed === true));
  const seen = new Set();
  for (const sample of report.samples) {
    assert.deepEqual(
      Object.keys(sample).sort(),
      [
        'id',
        'group',
        'block',
        'scenario',
        'ok',
        'clientMs',
        'serverMs',
        'tlsMs',
        'queueMs',
        'protectionMs',
        'verificationMs',
        'nodeCpuMs',
        'nodeRssMiB',
      ].sort(),
    );
    for (const key of [
      'clientMs',
      'serverMs',
      'tlsMs',
      'queueMs',
      'protectionMs',
      'verificationMs',
      'nodeCpuMs',
      'nodeRssMiB',
    ]) {
      assert.ok(Number.isFinite(sample[key]) && sample[key] >= 0);
    }
    assert.ok(!seen.has(sample.id));
    seen.add(sample.id);
    assert.equal(sample.ok, true);
    assert.equal(sample.group, method.order[sample.block]);
    assert.ok(sample.serverMs <= sample.clientMs + 5);
    assert.ok(sample.protectionMs <= sample.serverMs + 5);
  }
  for (const [group, counts] of [
    ['A', method.baselineCounts],
    ['B', method.counts],
  ]) {
    const actual = {};
    for (const sample of report.samples.filter((s) => s.group === group)) {
      actual[sample.scenario] = (actual[sample.scenario] ?? 0) + 1;
    }
    const expected = Object.fromEntries(
      Object.entries(counts).map(([key, value]) => [
        key,
        key === 'batchSave' ? Math.min(size, 6) * 2 : (value / 15) * size,
      ]),
    );
    assert.deepEqual(actual, expected, 'PERFORMANCE_REQUIRED_SAMPLES');
    for (const [block, blockGroup] of method.order.entries()) {
      if (blockGroup === group) {
        for (const [scenario, count] of Object.entries(expected)) {
          assert.equal(
            report.samples.filter((s) => s.block === block && s.scenario === scenario).length,
            count / 2,
            'PERFORMANCE_BLOCK_SAMPLES',
          );
        }
      }
    }
  }
  assert.deepEqual(report.summary, summarize(report.samples));
  assert.equal(report.flood.requests, method.floodRequests);
  assert.equal(report.flood.concurrency, method.floodConcurrency);
  assert.equal(report.flood.completed, method.floodRequests);
  assert.ok(
    report.flood.completedBeforeRepair >= 1 &&
      report.flood.completedBeforeRepair < method.floodRequests,
    'PERFORMANCE_FLOOD_MUST_OVERLAP_REPAIR',
  );
  assert.equal(report.flood.unexpected, 0);
  assert.equal(report.flood.localMutationSucceeded, true);
  assert.equal(report.flood.networkPolicyRolledBack, true);
  assert.equal(report.flood.pendingCapacity, method.pendingCapacity);
  assert.equal(report.flood.capacityRejected, true);
  assert.equal(report.flood.auditPresent, true);
  assert.equal(report.flood.proofBounds.active, 4);
  assert.equal(report.flood.proofBounds.queued, 32);
  assert.equal(report.flood.proofBounds.overflowRejected, true);
  assert.equal(report.flood.proofBounds.localMutationSucceeded, true);
  assert.equal(report.flood.proofBounds.nativePerformance, false);
  assert.equal(report.scope.temporarySyntheticOnly, true);
  for (const key of [
    'liveMaterialRead',
    'hardwareAuthenticatorTested',
    'realTwoDeviceTested',
    'productionCapacityClaimed',
    'childProcessResourcesMeasured',
    'frontendChanged',
  ]) {
    assert.equal(report.scope[key], false);
  }
}
export function assertPerformanceReport(report, registration) {
  assertMeasurements(report, 15);
  assert.equal(report.phase, 'confirm');
  assert.equal(registration.format, 'modeldb.security-performance-registration.v1');
  assert.equal(registration.methodSha256, digest(method));
  assert.equal(registration.sourceSha256, report.sourceSha256);
  assert.equal(registration.candidateSha256, report.candidateSha256);
  assert.equal(registration.nodeVersion, report.nodeVersion);
  assert.equal(report.registrationSha256, digest(registration));
  assert.ok(Date.parse(registration.registeredAt) < Date.parse(report.startedAt));
  assert.equal(report.explorationSha256, registration.explorationSha256);
  for (const [key, row] of Object.entries(report.summary)) {
    const threshold = registration.limits[key];
    assert.ok(threshold, 'PERFORMANCE_THRESHOLD_REQUIRED');
    assert.equal(row.failures, 0);
    assert.ok(row.clientMs.p95 <= threshold.clientP95Ms, 'PERFORMANCE_P95_EXCEEDED: ' + key);
    assert.ok(row.serverMs.p95 <= threshold.serverP95Ms, 'PERFORMANCE_SERVER_P95_EXCEEDED: ' + key);
    assert.ok(row.nodeRssMiB.max <= registration.nodeRssMiB);
    assert.ok(row.nodeCpuMs.max <= registration.nodeCpuMaxMs);
    assert.ok(row.queueMs.max <= registration.queueMaxMs);
  }
  assert.ok(report.flood.localMutationMs <= registration.localRepairMaxMs);
  assert.ok(report.flood.maxRequestMs <= registration.floodMaxRequestMs);
  assert.ok(report.flood.nodeRssMiB <= registration.nodeRssMiB);
}
