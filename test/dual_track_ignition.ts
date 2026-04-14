/**
 * 双轨制压测点火器：通过 **`@mode-db/sdk`** 的 **`connectRemote`** + **`insertMany`** 向服务端灌数。
 *
 * 若本地尚无 **`Sensor`** 模型（无 atlas、或仅有不含 **`Sensor`** 的 **`atlas-manifest.json`**、或加密 **`atlas.mld`** 内未注册），会在**与服务端相同的存储根**上自动补齐（**`AuthoringEngine`** 注册 **`Sensor`** 并 **`writeAtlasManifest`** + **`flushAll`**）。
 * 设置 **`IGNITION_SKIP_BOOTSTRAP=1`** 可关闭该行为（仅当你已自行建好图谱时）。更新 manifest 后若 **`modeldb-server` 已在跑**，需**重启**以重新加载目录签名与引擎缓存。
 *
 * 环境变量：
 * - **`MODEL_DB_URL`** — 例如 `http://127.0.0.1:9090` 或 `ws://127.0.0.1:9090`
 * - **`MODEL_DB_CONNECT_TOKEN`** — 与 **`modeldb.config.json`** 中 **`connectToken`** 一致
 * - **`MODEL_DB_ATLAS`** — atlas 名（默认 **`world`**）
 * - **`MODEL_DB_MODE`** — **`short`**（HTTP `/v2/action`）或 **`stream`**（默认 WebSocket）
 * - **`IGNITION_TOTAL`** — 总条数（默认 **100000**）
 * - **`IGNITION_BATCH`** — 每批行数（默认 **5000**，≤ **20000**）
 *
 * Run: `npx tsx test/dual_track_ignition.ts` 或 `npm run ignition`
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectRemote } from '@mode-db/sdk';
import { loadModelDBServerConfig } from '@mode-db/server';
import {
  AuthoringEngine,
  configureModelDBStorageRoot,
  fileLooksLikeAtlasSingleVault,
  resolveModelDBStorageRoot,
} from 'mode-db-engine';

const url = process.env.MODEL_DB_URL ?? 'http://127.0.0.1:9090';
const connectToken = process.env.MODEL_DB_CONNECT_TOKEN ?? 'dev-connect-token-change-in-production';
const atlas = process.env.MODEL_DB_ATLAS ?? 'world';
const mode = (process.env.MODEL_DB_MODE === 'short' ? 'short' : 'stream') as 'short' | 'stream';
const skipBootstrap = process.env.IGNITION_SKIP_BOOTSTRAP === '1';

const TOTAL = Number(process.env.IGNITION_TOTAL ?? '100000');
const BATCH_SIZE = Math.min(Number(process.env.IGNITION_BATCH ?? '5000'), 20_000);

async function resolveStorageRootAlignedWithServer(): Promise<string> {
  try {
    const cfg = await loadModelDBServerConfig(undefined, {
      connectToken: process.env.MODEL_DB_CONNECT_TOKEN,
    });
    configureModelDBStorageRoot({ storageRoot: cfg.storageRoot });
    return cfg.storageRoot;
  } catch {
    const root = resolveModelDBStorageRoot();
    configureModelDBStorageRoot({ storageRoot: root });
    return root;
  }
}

const IGNITION_MODEL = 'Sensor';

/** Fast path: standalone manifest lists the stress-test model. */
function splitManifestDefinesIgnitionModel(atlasDir: string): boolean | 'absent' {
  const manifestPath = join(atlasDir, 'atlas-manifest.json');
  if (!existsSync(manifestPath)) {
    return 'absent';
  }
  try {
    const j = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { models?: { name: string }[] };
    return Array.isArray(j.models) && j.models.some((m) => m.name === IGNITION_MODEL);
  } catch {
    return false;
  }
}

async function bootstrapAtlasIfNeeded(storageRoot: string, atlasName: string): Promise<void> {
  if (skipBootstrap) {
    console.log('IGNITION_SKIP_BOOTSTRAP=1 — not modifying disk.');
    return;
  }

  const atlasDir = join(storageRoot, atlasName);
  const manifestHint = splitManifestDefinesIgnitionModel(atlasDir);
  if (manifestHint === true) {
    console.log(
      `Atlas "${atlasName}" already defines ${IGNITION_MODEL} in atlas-manifest.json under ${storageRoot}; skip bootstrap.`,
    );
    return;
  }

  const cfg = await loadModelDBServerConfig(undefined, {
    connectToken: process.env.MODEL_DB_CONNECT_TOKEN,
  });
  const vaultPath = join(atlasDir, 'atlas.mld');
  const useVault = existsSync(vaultPath) && (await fileLooksLikeAtlasSingleVault(vaultPath));
  const vaultSecret =
    cfg.vaultSecret ??
    (typeof process !== 'undefined' ? process.env.MODEL_DB_VAULT_SECRET : undefined);

  if (useVault && (!vaultSecret || vaultSecret.length === 0)) {
    throw new Error(
      `Ignition: atlas "${atlasName}" uses encrypted atlas.mld; set "vaultSecret" in modeldb.config.json or MODEL_DB_VAULT_SECRET.`,
    );
  }

  const engine = useVault
    ? new AuthoringEngine({
        atlas: atlasName,
        storageRoot,
        singleFileVault: true,
        vaultSecret,
        engineLogger: true,
      })
    : new AuthoringEngine({
        atlas: atlasName,
        storageRoot,
        engineLogger: true,
      });

  if (engine.registry.getModel(IGNITION_MODEL)) {
    console.log(`Atlas "${atlasName}" already registers ${IGNITION_MODEL}; skip bootstrap.`);
    return;
  }

  console.log(
    `Bootstrapping ${IGNITION_MODEL} for atlas "${atlasName}" under ${storageRoot} (manifest was ${
      manifestHint === 'absent' ? 'missing' : 'present without ' + IGNITION_MODEL
    }) …`,
  );
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
  await bootstrapAtlasIfNeeded(storageRoot, atlas);

  const client = await connectRemote({ url, connectToken, atlas, mode });
  const Sensor = client.model('Sensor');

  console.log(`Starting injection: total=${TOTAL} batch=${BATCH_SIZE} mode=${mode} atlas=${atlas}`);
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
