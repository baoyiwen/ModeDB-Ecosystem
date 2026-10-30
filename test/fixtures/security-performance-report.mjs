import { method, digest, summarize } from '../../scripts/security-performance-contract.mjs';
export function performanceReportFixture() {
  const report = {
    format: 'modeldb.security-performance.v1',
    ok: true,
    phase: 'confirm',
    platform: 'win32',
    method: structuredClone(method),
    nodeVersion: 'v24.test',
    sourceSha256: 'a'.repeat(64),
    candidateSha256: 'b'.repeat(64),
    sourceUnchanged: true,
    candidateUnchanged: true,
    startedAt: '2026-10-28T02:00:00.000Z',
    blocks: method.order.map((group, block) => ({ group, block, completed: true })),
    samples: [],
    flood: {
      requests: 48,
      concurrency: 48,
      completed: 48,
      completedBeforeRepair: 1,
      unexpected: 0,
      localMutationSucceeded: true,
      networkPolicyRolledBack: true,
      localMutationMs: 100,
      pendingCapacity: 1000,
      capacityRejected: true,
      auditPresent: true,
      maxRequestMs: 100,
      nodeRssMiB: 100,
      proofBounds: {
        active: 4,
        queued: 32,
        overflowRejected: true,
        localMutationSucceeded: true,
        nativePerformance: false,
      },
    },
    scope: {
      temporarySyntheticOnly: true,
      liveMaterialRead: false,
      hardwareAuthenticatorTested: false,
      realTwoDeviceTested: false,
      productionCapacityClaimed: false,
      childProcessResourcesMeasured: false,
      frontendChanged: false,
    },
  };
  for (const [group, counts] of [
    ['A', method.baselineCounts],
    ['B', method.counts],
  ])
    for (const [scenario, count] of Object.entries(counts))
      for (let i = 0; i < count; i++)
        report.samples.push({
          id: group + scenario + i,
          group,
          block: group === 'A' ? (i < count / 2 ? 0 : 3) : i < count / 2 ? 1 : 2,
          scenario,
          ok: true,
          clientMs: 100,
          serverMs: 90,
          tlsMs: 2,
          queueMs: 0,
          protectionMs: 80,
          verificationMs: 1,
          nodeCpuMs: 2,
          nodeRssMiB: 100,
        });
  report.summary = summarize(report.samples);
  const registration = {
    format: 'modeldb.security-performance-registration.v1',
    methodSha256: digest(method),
    sourceSha256: report.sourceSha256,
    candidateSha256: report.candidateSha256,
    nodeVersion: report.nodeVersion,
    registeredAt: '2026-10-28T01:00:00.000Z',
    explorationSha256: 'c'.repeat(64),
    limits: Object.fromEntries(
      Object.keys(report.summary).map((k) => [k, { clientP95Ms: 500, serverP95Ms: 500 }]),
    ),
    nodeRssMiB: 1024,
    nodeCpuMaxMs: 10000,
    queueMaxMs: 1000,
    localRepairMaxMs: 15000,
    floodMaxRequestMs: 60000,
  };
  report.registrationSha256 = digest(registration);
  report.explorationSha256 = registration.explorationSha256;
  return { report, registration };
}
