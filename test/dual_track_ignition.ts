/**
 * 双轨制压测点火器：通过 **`@mode-db/sdk`** 的 **`connectRemote`** + **`insertMany`** 向服务端灌数。
 *
 * 若本地尚无 **`Sensor`** 模型，会在**与服务端相同的存储根**上自动补齐（**`AuthoringEngine`** 注册 **`Sensor`** 并 **`writeAtlasManifest`** + **`flushAll`**）。
 * 磁盘布局仅为单文件 vault：**`<workspace>/<dbName>/atlas.mld`**；密钥由与服务端相同的 **`connectToken`** 派生。
 * 设置 **`IGNITION_SKIP_BOOTSTRAP=1`** 可关闭该行为。若 **`modeldb-server` 已在跑**，变更图谱后需**重启**。
 *
 * 环境变量：
 * - **`MODEL_DB_URL`** — 例如 `http://127.0.0.1:9090` 或 `ws://127.0.0.1:9090`
 * - **`MODEL_DB_CONNECT_TOKEN`** — 与 **`modeldb.config.json`** 中 **`connectToken`** 一致（同时派生 atlas vault 密钥）
 * - **`MODEL_DB_DB_NAME`** — 逻辑库名（**`dbName`**，优先；默认 **`world`**）
 * - **`MODEL_DB_ATLAS`** — 与 **`MODEL_DB_DB_NAME`** 同义（兼容旧环境变量）
 * - **`MODEL_DB_MODE`** — **`short`**（HTTP `/v2/action`）或 **`stream`**（默认 WebSocket）
 * - **`IGNITION_TOTAL`** — 总条数（默认 **100000**）
 * - **`IGNITION_BATCH`** — 每批行数（默认 **5000**，≤ **20000**）
 *
 * Run: `pnpm exec tsx test/dual_track_ignition.ts` 或 `pnpm run ignition`
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { connectRemote } from '@mode-db/sdk';
import { loadModelDBServerConfig } from '../packages/server/dist/index.js';
import {
  AuthoringEngine,
  configureModelDBStorageRoot,
  resolveModelDBStorageRoot,
} from '@mode-db/core';

const url = process.env.MODEL_DB_URL ?? 'http://127.0.0.1:9090';
const connectToken = process.env.MODEL_DB_CONNECT_TOKEN ?? 'dev-connect-token-change-in-production';
const logicalDb = process.env.MODEL_DB_DB_NAME ?? process.env.MODEL_DB_ATLAS ?? 'world';
const mode = (process.env.MODEL_DB_MODE === 'short' ? 'short' : 'stream') as 'short' | 'stream';
const skipBootstrap = process.env.IGNITION_SKIP_BOOTSTRAP === '1';

const TOTAL = Number(process.env.IGNITION_TOTAL ?? '100000');
const BATCH_SIZE = Math.min(Number(process.env.IGNITION_BATCH ?? '5000'), 20_000);

async function resolveStorageRootAlignedWithServer(): Promise<string> {
  try {
    const cfg = await loadModelDBServerConfig(undefined, {
      connectToken: process.env.MODEL_DB_CONNECT_TOKEN,
    });
    const root = cfg.workspace ?? cfg.storageRoot;
    configureModelDBStorageRoot({ storageRoot: root });
    return root;
  } catch {
    const root = resolveModelDBStorageRoot();
    configureModelDBStorageRoot({ storageRoot: root });
    return root;
  }
}

const IGNITION_MODEL = 'Sensor';

async function bootstrapLogicalDbIfNeeded(
  storageRoot: string,
  atlasName: string,
  wireConnectToken: string,
): Promise<void> {
  if (skipBootstrap) {
    console.log('IGNITION_SKIP_BOOTSTRAP=1 — not modifying disk.');
    return;
  }

  const atlasDir = join(storageRoot, atlasName);
  const nestedVaultPath = join(atlasDir, 'atlas.mld');
  const handshakeVaultOnDisk = existsSync(nestedVaultPath);

  const legacyModelsDir = join(atlasDir, 'models');
  const legacyManifestPath = join(atlasDir, 'atlas-manifest.json');
  const hasLegacySplitOnDisk =
    existsSync(legacyModelsDir) || (existsSync(legacyManifestPath) && !existsSync(nestedVaultPath));

  if (hasLegacySplitOnDisk) {
    throw new Error(
      `Ignition: legacy split atlas under "${atlasDir}" (models/ and/or standalone atlas-manifest.json). ` +
        `Only "${nestedVaultPath}" is supported. Remove "${atlasDir}" and re-run.`,
    );
  }

  const ct = wireConnectToken.trim();
  if (!ct) {
    throw new Error(
      'Ignition: set connectToken in modeldb.config.json or MODEL_DB_CONNECT_TOKEN (must match the server).',
    );
  }

  const engine = new AuthoringEngine({
    atlas: atlasName,
    storageRoot,
    connectToken: ct,
    engineLogger: true,
  });

  if (handshakeVaultOnDisk && engine.registry.getModel(IGNITION_MODEL)) {
    console.log(
      `Atlas "${atlasName}" already registers ${IGNITION_MODEL} in vault under ${storageRoot}; skip bootstrap.`,
    );
    return;
  }

  if (engine.registry.getModel(IGNITION_MODEL)) {
    console.log(`Atlas "${atlasName}" already registers ${IGNITION_MODEL}; skip bootstrap.`);
    return;
  }

  console.log(`Bootstrapping ${IGNITION_MODEL} for atlas "${atlasName}" under ${storageRoot} …`);
  engine.registerModel(IGNITION_MODEL, {
    id: { type: 'String', required: true },
    value: { type: 'Number', required: true },
    timestamp: { type: 'Number', required: true },
    location: { type: 'JSON', required: true },
  });
  await engine.writeAtlasManifest();
  await engine.flushAll();
  console.log(
    'Bootstrap done. Start modeldb-server if it is not running; if it was already running, restart it to reload the atlas catalog.',
  );
}

async function ignition(): Promise<void> {
  const storageRoot = await resolveStorageRootAlignedWithServer();
  const cfg = await loadModelDBServerConfig(undefined, {
    connectToken: process.env.MODEL_DB_CONNECT_TOKEN,
  });
  const serverConnectToken = cfg.connectToken.trim() || connectToken.trim();
  await bootstrapLogicalDbIfNeeded(storageRoot, logicalDb, serverConnectToken);

  const client = await connectRemote({
    url,
    connectToken: serverConnectToken,
    dbName: logicalDb,
    mode,
  });
  const Sensor = client.model('Sensor');

  console.log(
    `Starting injection: total=${TOTAL} batch=${BATCH_SIZE} mode=${mode} dbName=${logicalDb}`,
  );
  console.time('StressTest');

  const batches = Math.ceil(TOTAL / BATCH_SIZE);
  let inserted = 0;
  let failed = 0;

  for (let i = 0; i < batches; i++) {
    const n = Math.min(BATCH_SIZE, TOTAL - i * BATCH_SIZE);
    const sensors = Array.from({ length: n }, (_, j) => ({
      id: `SID_${i}_${j}`,
      value: Math.random() * 100,
      timestamp: Date.now(),
      location: [Math.random() * 180, Math.random() * 90, 0],
    }));

    const r = await Sensor.insertMany(sensors, { sync: false });
    inserted += r.successCount;
    failed += r.failureCount;

    if (i % 10 === 0) {
      const progress = (((i + 1) * BATCH_SIZE) / TOTAL) * 100;
      console.log(
        `Progress: ${Math.min(100, progress).toFixed(1)}% (ok=${inserted} fail=${failed})`,
      );
    }
  }

  console.timeEnd('StressTest');
  console.log(
    `Done. success=${inserted} failure=${failed}. Server will flush on schedule or SIGTERM.`,
  );
  client.close();
}

void ignition().catch((e) => {
  console.error(e);
  process.exit(1);
});
