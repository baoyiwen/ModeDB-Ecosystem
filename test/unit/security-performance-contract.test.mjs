import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  summarize,
  assertMeasurements,
  assertPerformanceReport,
  percentile,
} from '../../scripts/security-performance-contract.mjs';
import { performanceReportFixture as fixture } from '../fixtures/security-performance-report.mjs';
test('complete independent observations are accepted and nearest-rank p95 retains slow samples', () => {
  const f = fixture();
  assertPerformanceReport(f.report, f.registration);
  assert.equal(
    percentile(
      Array.from({ length: 30 }, (_, i) => i + 1),
      0.95,
    ),
    29,
  );
});
test('missing or duplicated samples and changed summaries fail even when the report says ok', () => {
  for (const edit of [
    (r) => r.samples.pop(),
    (r) => r.samples.push(r.samples[0]),
    (r) => (r.summary['B.login'].clientMs.p95 = 0),
  ]) {
    const f = fixture();
    edit(f.report);
    assert.throws(() => assertPerformanceReport(f.report, f.registration));
  }
});
test('NaN, infinity, negative, missing metrics and hidden payload fields fail', () => {
  for (const edit of [
    (s) => (s.clientMs = NaN),
    (s) => (s.nodeRssMiB = Infinity),
    (s) => (s.queueMs = -1),
    (s) => delete s.protectionMs,
    (s) => (s.cookie = 'synthetic-forbidden'),
  ]) {
    const f = fixture();
    edit(f.report.samples[0]);
    assert.throws(() => assertPerformanceReport(f.report, f.registration));
  }
});
test('failed operations cannot be removed or relabelled as expected errors', () => {
  const f = fixture();
  f.report.samples[0].ok = false;
  f.report.summary = summarize(f.report.samples);
  assert.throws(() => assertPerformanceReport(f.report, f.registration));
});
test('slow samples, resource peaks, queue delay and repair starvation fail registered limits', () => {
  for (const edit of [
    (r) => {
      for (const s of r.samples.filter((s) => s.scenario === 'login')) s.clientMs = 501;
    },
    (r) => (r.samples[0].nodeRssMiB = 1025),
    (r) => (r.samples[0].nodeCpuMs = 10001),
    (r) => (r.samples[0].queueMs = 1001),
    (r) => (r.flood.localMutationMs = 15001),
    (r) => (r.flood.maxRequestMs = 60001),
  ]) {
    const f = fixture();
    edit(f.report);
    f.report.summary = summarize(f.report.samples);
    assert.throws(() => assertPerformanceReport(f.report, f.registration));
  }
});
test('late registration, candidate, source, runtime and method drift fail', () => {
  for (const edit of [
    (r) => (r.sourceSha256 = 'd'.repeat(64)),
    (r) => (r.candidateSha256 = 'd'.repeat(64)),
    (r) => (r.nodeVersion = 'another'),
    (r) => (r.method.concurrency = 8),
    (r) => (r.startedAt = '2026-10-28T00:00:00.000Z'),
    (r) => (r.registrationSha256 = 'd'.repeat(64)),
    (r) => (r.explorationSha256 = 'd'.repeat(64)),
  ]) {
    const f = fixture();
    edit(f.report);
    assert.throws(() => assertPerformanceReport(f.report, f.registration));
  }
});
test('ABBA, native flood, capacity, queue overflow and local mutation evidence are mandatory', () => {
  for (const edit of [
    (r) => r.blocks.reverse(),
    (r) => (r.flood.requests = 47),
    (r) => (r.flood.unexpected = 1),
    (r) => (r.flood.capacityRejected = false),
    (r) => (r.flood.localMutationSucceeded = false),
    (r) => (r.flood.auditPresent = false),
    (r) => (r.flood.proofBounds.overflowRejected = false),
    (r) => (r.flood.proofBounds.nativePerformance = true),
  ]) {
    const f = fixture();
    edit(f.report);
    assert.throws(() => assertPerformanceReport(f.report, f.registration));
  }
});
test('hardware, production, complete process resource or frontend claims cannot be inferred', () => {
  for (const key of [
    'hardwareAuthenticatorTested',
    'realTwoDeviceTested',
    'productionCapacityClaimed',
    'childProcessResourcesMeasured',
    'liveMaterialRead',
    'frontendChanged',
  ]) {
    const f = fixture();
    f.report.scope[key] = true;
    assert.throws(() => assertPerformanceReport(f.report, f.registration));
  }
});
test('exploration uses a separate small sample contract and cannot qualify as confirmation', () => {
  const f = fixture();
  f.report.phase = 'explore';
  assertMeasurements(f.report, 15);
  assert.throws(() => assertPerformanceReport(f.report, f.registration));
});
