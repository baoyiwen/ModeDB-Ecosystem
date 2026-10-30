import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyPerformanceEvidence } from '../../scripts/security-performance-evidence.mjs';
import { digest, summarize } from '../../scripts/security-performance-contract.mjs';
import { performanceReportFixture } from '../fixtures/security-performance-report.mjs';
function fixture() {
  const { report, registration } = performanceReportFixture();
  const explore = structuredClone(report);
  explore.phase = 'explore';
  explore.startedAt = '2026-10-28T00:00:00.000Z';
  const perBlock = {};
  explore.samples = explore.samples.filter((s) => {
    const k = s.block + s.scenario;
    perBlock[k] = (perBlock[k] ?? 0) + 1;
    return perBlock[k] <= (['query1000', 'login'].includes(s.scenario) ? 6 : 3);
  });
  explore.summary = summarize(explore.samples);
  registration.explorationSha256 = digest(explore);
  report.explorationSha256 = digest(explore);
  report.registrationSha256 = digest(registration);
  const data = new Map(),
    base = 'public/';
  const put = (name, value) =>
    data.set(base + name, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));
  const candidate = {
    files: [
      { path: 'index.html', sha256: digest(Buffer.from('<html>public</html>').toString('base64')) },
    ],
  };
  candidate.sha256 = digest(candidate.files);
  for (const r of [report, explore]) r.candidateSha256 = candidate.sha256;
  registration.candidateSha256 = report.candidateSha256;
  registration.explorationSha256 = digest(explore);
  report.explorationSha256 = digest(explore);
  report.registrationSha256 = digest(registration);
  for (const [phase, r] of [
    ['exploration', explore],
    ['confirmation', report],
  ]) {
    // The source inventory digest is verified independently of the receipt list.
    const sources = [{ path: 'scripts/synthetic.mjs', sha256: 'a'.repeat(64) }];
    r.sourceSha256 = digest(sources);
    put(phase + '/source-manifest.json', { sources });
    put(phase + '/candidate-manifest.json', candidate);
    put(phase + '/designer/index.html', '<html>public</html>');
    for (let i = 0; i < 4; i++)
      put(
        phase + '/block-' + i + '.json',
        r.samples.filter((s) => s.block === i),
      );
  }
  registration.sourceSha256 = report.sourceSha256;
  registration.explorationSha256 = digest(explore);
  report.explorationSha256 = digest(explore);
  report.registrationSha256 = digest(registration);
  put('exploration/performance.json', explore);
  put('confirmation/performance.json', report);
  put('registration.json', registration);
  put('verification.json', {
    revision: 'SEC-M7-D33',
    task: 'DR-P4.5',
    sourceSha256: report.sourceSha256,
    confirmationSha256: digest(report),
    tasks: { registration: '22/23', registrationP4: '5/6', registrationWorkPackages: '3/4' },
    scope: report.scope,
  });
  put('documents.json', { ok: true });
  const names = [
    'tools',
    'affected',
    'browser',
    'types',
    'lint',
    'format',
    'material-guard',
    'source-guard',
    'tools-final',
    'final-lint',
  ];
  put(
    'checks.json',
    names.map((name) => ({ name, exitCode: 0, timedOut: false, log: name + '.original.txt' })),
  );
  for (const name of names) {
    const count = name === 'affected' ? 187 : name === 'browser' ? 1 : 61;
    put(
      name + '.original.txt',
      `TAP version 13\n# tests ${count}\n# pass ${count}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`,
    );
  }
  put('types.original.txt', { ok: true });
  const receipt = {
    files: [{ path: 'scripts/synthetic.mjs', sha256: 'a'.repeat(64) }],
    verificationArtifacts: [...data.keys()].map((path) => ({ path })),
  };
  return {
    data,
    base,
    receipt,
    read: (path) => {
      assert.ok(data.has(path));
      return data.get(path);
    },
    put,
  };
}
test('public measurement evidence binds exploration, registration, raw blocks, source and candidate bytes', () => {
  assert.equal(verifyPerformanceEvidence(fixture()).task, 'DR-P4.5');
});
test('missing archived log or raw block cannot pass', () => {
  for (const name of ['lint.original.txt', 'confirmation/block-1.json', 'registration.json']) {
    const f = fixture();
    f.receipt.verificationArtifacts = f.receipt.verificationArtifacts.filter(
      (v) => v.path !== f.base + name,
    );
    assert.throws(() => verifyPerformanceEvidence(f));
  }
});
test('altered candidate bytes and source inventories are rejected', () => {
  for (const name of ['confirmation/designer/index.html', 'confirmation/source-manifest.json']) {
    const f = fixture();
    f.put(name, name.endsWith('json') ? { sources: [] } : 'changed');
    assert.throws(() => verifyPerformanceEvidence(f));
  }
});
test('raising a registered gate after confirmation is rejected even with a recomputed report digest', () => {
  const f = fixture();
  const registration = JSON.parse(f.read(f.base + 'registration.json'));
  registration.limits['B.login'].clientP95Ms = 999999;
  f.put('registration.json', registration);
  const report = JSON.parse(f.read(f.base + 'confirmation/performance.json'));
  report.registrationSha256 = digest(registration);
  f.put('confirmation/performance.json', report);
  assert.throws(() => verifyPerformanceEvidence(f));
});
test('raw blocks cannot discard a slow sample while keeping summary totals', () => {
  const f = fixture();
  f.put('confirmation/block-1.json', []);
  assert.throws(() => verifyPerformanceEvidence(f));
});
test('missing checks, timeouts or skipped test summaries fail even with successful process exit', () => {
  for (const change of [
    (f) =>
      f.put(
        'checks.json',
        JSON.parse(f.read(f.base + 'checks.json')).filter((c) => c.name !== 'types'),
      ),
    (f) => {
      const checks = JSON.parse(f.read(f.base + 'checks.json'));
      checks[0].timedOut = true;
      f.put('checks.json', checks);
    },
    (f) =>
      f.put(
        'affected.original.txt',
        f
          .read(f.base + 'affected.original.txt')
          .toString()
          .replace('# skipped 0', '# skipped 1'),
      ),
  ]) {
    const f = fixture();
    change(f);
    assert.throws(() => verifyPerformanceEvidence(f));
  }
});
