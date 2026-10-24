/** Verify installed local tarballs and compare security modes on synthetic data. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { arch, cpus, release, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import type * as ServerPackage from '@mode-db/server';
import type * as CorePackage from '@mode-db/core';
import type * as SdkPackage from '@mode-db/sdk';
import type * as LocalChannel from '../packages/server/src/security/local-management-channel.js';
import type { SecurityProtectionPreview, SecurityProtectionState } from '@mode-db/shared';
import type { TransferModel } from '@mode-db/data-kit';
import { collectModelTransfer } from '../apps/model-designer/src/data-transfer/model-transfer.js';
import {
  readTransferWorkbook,
  writeTransferWorkbook,
} from '../apps/model-designer/src/data-transfer/workbook.js';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const reportPath = resolve(process.argv[2] ?? '');
assert.equal(process.argv.length, 3, 'Usage: security-release-verify.ts <release-candidate.json>');
assert.equal(process.platform, 'win32', 'Windows DPAPI acceptance is required');
const releaseRoot = realpathSync(dirname(reportPath));
function artifact(root: string, path: string): string {
  assert.ok(
    typeof path === 'string' &&
      path.length > 0 &&
      !path.includes('\\') &&
      !path.includes(':') &&
      path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'RELEASE_UNSAFE_MANIFEST_PATH',
  );
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    assert.ok(!lstatSync(current).isSymbolicLink(), 'RELEASE_ARTIFACT_LINK');
  }
  assert.ok(lstatSync(current).isFile(), 'RELEASE_ARTIFACT_FILE');
  return current;
}
const descriptor = JSON.parse(readFileSync(reportPath, 'utf8')) as {
  format: string;
  packages: {
    name: string;
    archive: string;
    sha256: string;
    files: { path: string; sha256: string }[];
  }[];
  apps: { name: string; files: { path: string; sha256: string }[] }[];
  documentation: { path: string; sha256: string }[];
};
assert.equal(descriptor.format, 'modeldb.security-release-candidate.v1');
assert.deepEqual(
  descriptor.packages.map((pkg) => pkg.name).sort(),
  ['common', 'core', 'data-kit', 'data-ui', 'sdk', 'server', 'shared'].map(
    (name) => '@mode-db/' + name,
  ),
);
const consumer = join(releaseRoot, 'consumer');
for (const pkg of descriptor.packages) {
  assert.equal(sha256(readFileSync(artifact(releaseRoot, pkg.archive))), pkg.sha256);
  const installed = realpathSync(join(consumer, 'node_modules', pkg.name));
  assert.ok(
    installed.startsWith(consumer + sep),
    'Installed package must belong to the isolated consumer',
  );
  for (const file of pkg.files) {
    assert.equal(
      sha256(readFileSync(artifact(installed, file.path))),
      file.sha256,
      `${pkg.name}/${file.path}`,
    );
  }
}
assert.deepEqual(descriptor.apps.map((app) => app.name).sort(), [
  'data-studio',
  'model-designer',
  'web',
]);
for (const app of descriptor.apps) {
  for (const file of app.files) {
    assert.equal(
      sha256(readFileSync(artifact(releaseRoot, `apps/${app.name}/${file.path}`))),
      file.sha256,
    );
  }
}
for (const file of descriptor.documentation) {
  assert.equal(sha256(readFileSync(artifact(releaseRoot, file.path))), file.sha256);
}
const serverRoot = join(consumer, 'node_modules/@mode-db/server');
const server = (await import(
  pathToFileURL(join(serverRoot, 'dist/index.js')).href
)) as typeof ServerPackage;
const { AuthoringEngine } = (await import(
  pathToFileURL(join(consumer, 'node_modules/@mode-db/core/dist/index.js')).href
)) as typeof CorePackage;
const { RemoteModelDBClient } = (await import(
  pathToFileURL(join(consumer, 'node_modules/@mode-db/sdk/dist/index.js')).href
)) as typeof SdkPackage;
const { callLocalSecurity } = (await import(
  pathToFileURL(join(serverRoot, 'dist/security/local-management-channel.js')).href
)) as typeof LocalChannel;
const root = mkdtempSync(join(tmpdir(), 'ModeDB-Release-Verify-'));
const outcomes: Record<string, boolean> = {
  installedPackageHashes: true,
  frontendAndDocumentHashes: true,
};
type App = Awaited<ReturnType<typeof server.buildDualTrackFastify>>;
type Client = Awaited<ReturnType<typeof RemoteModelDBClient.connect>>;
const model: TransferModel = {
  name: 'Item',
  label: 'Item',
  sheet: 'Items',
  fields: [
    { name: 'code', label: 'code', type: 'String' },
    { name: 'score', label: 'score', type: 'Int' },
  ],
};
const samples: Record<string, Record<string, number[]>> = { legacy: {}, registry: {} };
// Registered after the first S7.2 exploratory baseline, before the isolated
// confirmation run. Local regression bounds only; not a production SLA.
const p95LimitsMs: Record<string, number> = {
  startup: 10000,
  query1000: 4000,
  durableWrite: 4000,
  excelExport1010: 5000,
};
// Disable SDK interaction tracing in both modes. Durable registry audit and
// normal server logging remain enabled.
(
  globalThis as unknown as { __MODEDB_SILENCE_INTERACTION_LOGS: boolean }
).__MODEDB_SILENCE_INTERACTION_LOGS = true;
function measure(mode: string, metric: string, value: number): void {
  (samples[mode]![metric] ??= []).push(value);
}

async function run(mode: 'legacy' | 'registry', round: number): Promise<void> {
  const home = join(root, `${mode}-${round}`);
  const config = server.ensureModelDbLayoutAtRoot(home);
  const raw = JSON.parse(readFileSync(config, 'utf8')) as Record<string, unknown>;
  let token = randomBytes(32).toString('hex');
  let credentialId = '';
  if (mode === 'legacy') {
    delete raw.security;
    raw.connectToken = token;
  }
  writeFileSync(config, JSON.stringify(raw));
  const cfg = await server.loadModelDBServerConfig(config, { port: 0, host: '127.0.0.1' });
  if (mode === 'registry') {
    const registry = server.SecurityRegistry.open(join(home, 'security'));
    try {
      const principal = registry.createPrincipal('synthetic-acceptance', 'application');
      const issued = registry.createCredential(principal.id, 'synthetic-acceptance', [
        {
          database: 'bench',
          resource: '*',
          actions: [
            'model.read',
            'model.write',
            'schema.manage',
            'database.manage',
            'backup.manage',
            'transfer.export',
            'transfer.import',
          ],
        },
      ]);
      token = issued.token;
      credentialId = issued.credential.id;
    } finally {
      registry.close();
    }
  }
  const seed = new AuthoringEngine({
    atlas: 'bench',
    storageRoot: cfg.workspace,
    keyProvider: new server.LocalVaultKeyProvider(join(home, 'security')),
  });
  try {
    seed.registerModel('Item', { code: 'String', score: 'Int' });
    for (let i = 0; i < 1000; i++) {
      await seed.insert('Item', { code: `synthetic-${i}`, score: i });
    }
    await seed.flushAll();
  } finally {
    await seed.close();
  }
  let app: App | undefined;
  let client: Client | undefined;
  try {
    const started = performance.now();
    app = await server.buildDualTrackFastify(cfg);
    measure(mode, 'startup', performance.now() - started);
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    assert.notEqual(address.port, 9091);
    const url = `http://127.0.0.1:${address.port}`;
    client = await RemoteModelDBClient.connect({ url, dbName: 'bench', token, mode: 'short' });
    for (let i = 0; i < 5; i++) {
      assert.equal(((await client.model('Item').query().execute()) as unknown[]).length, 1000);
    }
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      const rows = (await client.model('Item').query().execute()) as unknown[];
      measure(mode, 'query1000', performance.now() - start);
      assert.equal(rows.length, 1000);
    }
    process.stdout.write(`${mode} ${round + 1}: query samples complete\n`);
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      await client.model('Item').insertOne({ code: `write-${i}`, score: i }, { sync: true });
      measure(mode, 'durableWrite', performance.now() - start);
    }
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      const data = await collectModelTransfer({
        client,
        database: 'bench',
        model,
        relations: [],
        filters: [],
      });
      const bytes = await writeTransferWorkbook(data, (key) => key);
      measure(mode, 'excelExport1010', performance.now() - start);
      assert.equal((await readTransferWorkbook(bytes.buffer)).rows.length, 1010);
    }
    process.stdout.write(`${mode} ${round + 1}: durable writes and Excel complete\n`);
    if (mode === 'registry' && round === 0) {
      await assert.rejects(server.buildDualTrackFastify(cfg), { code: 'SECURITY_INSTANCE_BUSY' });
      outcomes.exclusiveInstalledStartup = true;
      const call = async (path: string, body?: object) => {
        const response = await fetch(url + path, {
          method: body ? 'POST' : 'GET',
          headers: {
            authorization: `Bearer ${token}`,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        return { status: response.status, body: (await response.json()) as unknown };
      };
      assert.equal((await call('/api/v1/management/databases/other/catalog')).status, 403);
      outcomes.crossDatabaseDenied = true;
      const origin = 'http://127.0.0.1:5175';
      const pairing = (await callLocalSecurity(join(home, 'security'), {
        action: 'session.pair',
        credentialId,
        origin,
        lifetimeMinutes: 5,
      })) as { code: string };
      const pair = await fetch(url + '/api/v1/security/pair', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ code: pairing.code }),
      });
      assert.equal(pair.status, 200);
      const cookie = pair.headers.get('set-cookie');
      assert.ok(cookie?.includes('HttpOnly'));
      const replay = await fetch(url + '/api/v1/security/pair', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ code: pairing.code }),
      });
      assert.notEqual(replay.status, 200);
      outcomes.oneTimePairingHttpOnly = true;
      const state = (await callLocalSecurity(join(home, 'security'), {
        action: 'network.status',
      })) as SecurityProtectionState;
      const locked = { ...state.config, data: { allowListEnabled: true, allow: [] } };
      const preview = (await callLocalSecurity(join(home, 'security'), {
        action: 'network.preview',
        config: locked,
      })) as SecurityProtectionPreview;
      const applied = (await callLocalSecurity(join(home, 'security'), {
        action: 'network.apply',
        config: locked,
        revision: preview.revision,
        previewId: preview.id,
      })) as SecurityProtectionState;
      assert.equal((await call('/api/v1/security/context?database=bench')).status, 403);
      await callLocalSecurity(join(home, 'security'), {
        action: 'network.rollback',
        revision: applied.revision,
      });
      assert.equal((await call('/api/v1/security/context?database=bench')).status, 200);
      outcomes.localNetworkRepair = true;
      const backup = await call('/api/v1/management/databases/bench/backup', {
        name: 'synthetic-release-acceptance',
      });
      assert.equal(backup.status, 200);
      await client.model('Item').insertOne({ code: 'after-backup', score: -1 }, { sync: true });
      const restored = await call('/api/v1/management/databases/bench/restore', {
        backupFile: (backup.body as { backup: { fileName: string } }).backup.fileName,
      });
      assert.equal(restored.status, 200);
      assert.equal(((await client.model('Item').query().execute()) as unknown[]).length, 1010);
      outcomes.backupRestore = true;
      await callLocalSecurity(join(home, 'security'), { action: 'master.rotate', confirm: true });
      assert.equal(((await client.model('Item').query().execute()) as unknown[]).length, 1010);
      outcomes.masterRotation = true;
      await callLocalSecurity(join(home, 'security'), {
        action: 'credential.revoke',
        id: credentialId,
      });
      await assert.rejects(client.model('Item').query().execute());
      const revokedSession = await fetch(url + '/api/v1/security/session', {
        headers: { origin, cookie: cookie!.split(';')[0]! },
      });
      assert.notEqual(revokedSession.status, 200);
      outcomes.credentialAndSessionRevoked = true;
    }
  } finally {
    client?.close();
    await app?.close();
  }
  process.stdout.write(`Verified ${mode} round ${round + 1}\n`);
}

function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    medianMs: sorted[Math.floor(sorted.length / 2)]!,
    p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!,
    samplesMs: values,
  };
}

try {
  for (let round = 0; round < 3; round++) {
    for (const mode of (round % 2 ? ['registry', 'legacy'] : ['legacy', 'registry']) as (
      | 'legacy'
      | 'registry'
    )[]) {
      await run(mode, round);
    }
  }
  assert.ok(Object.values(outcomes).every(Boolean));
  const metrics = Object.fromEntries(
    Object.keys(samples.legacy!).map((metric) => {
      const before = summary(samples.legacy![metric]!);
      const after = summary(samples.registry![metric]!);
      return [
        metric,
        { legacy: before, registry: after, medianRatio: after.medianMs / before.medianMs },
      ];
    }),
  );
  const report = join(root, 'verification.json');
  const performanceChecks = Object.fromEntries(
    Object.entries(metrics).map(([metric, result]) => [
      metric,
      { p95LimitMs: p95LimitsMs[metric], passed: result.registry.p95Ms <= p95LimitsMs[metric]! },
    ]),
  );
  outcomes.performanceWithinBaseline = Object.values(performanceChecks).every(
    (check) => check.passed,
  );
  writeFileSync(
    report,
    JSON.stringify(
      {
        format: 'modeldb.security-release-verification.v1',
        timestampUtc: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        osRelease: release(),
        architecture: arch(),
        cpu: cpus()[0]?.model,
        releaseManifestSha256: sha256(readFileSync(reportPath)),
        checks: outcomes,
        workload: {
          rows: 1000,
          durableWrites: 10,
          exportRows: 1010,
          rounds: 3,
          order: 'AB-BA-AB',
          queryWarmupsPerRound: 5,
          transport: 'loopback HTTP SDK short',
          startup: 'existing initialized instance; key generation/seed excluded',
          comparison:
            'same current release: legacy bearer vs registry authorization and durable audit; not historical binary or production benchmark',
        },
        metrics,
        performanceChecks,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  process.stdout.write(
    `${outcomes.performanceWithinBaseline ? 'SUCCESS' : 'PERFORMANCE_BASELINE_EXCEEDED'}: ${report}\n`,
  );
  if (!outcomes.performanceWithinBaseline) {
    process.exitCode = 1;
  }
} catch (error) {
  // Error text can include request details. Keep terminal/report free of credentials.
  process.stderr.write(
    `RELEASE_VERIFICATION_FAILED: ${error instanceof Error && 'code' in error ? String(error.code) : error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'unexpected-error'}\nRun retained: ${root}\n`,
  );
  process.exitCode = 1;
}
