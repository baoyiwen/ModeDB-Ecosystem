/**
 * ModelDB WebSocket 服务与 `@mode-db/model-db-client-sdk` 联调。
 *
 * **前置**：`verify.ts` 已创建 Vault 图谱 `data/pipe/atlas.mld`（默认集成顺序中为首步）。
 * **单跑**：`npx tsx test/wire_server_audit.ts`（需已存在 `data/pipe` 与集成 Vault 密钥环境）。
 *
 * 说明见同目录 [README.md](./README.md)。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { configureModelDBStorageRoot } from '../common/storage-root-config.js';
import { ModelDBClient } from '../runtime/client.js';
import {
  getWebSocketServerListeningPort,
  startModelDBWebSocketServer,
} from '../server/modeldb-server.js';
import {
  atlasVaultPath,
  INTEGRATION_VAULT_SECRET,
  useIntegrationVaultEnv,
} from './integration-vault.js';
import { connectRemote, RemoteHydratedEntity } from '../packages/model-db-client-sdk/src/index.js';

const DATA_ROOT = join(process.cwd(), 'data');
const WIRE_TOKEN = 'wire-server-audit-token';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}`);
    failed++;
  }
}

function section(title: string): void {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

async function expectHandshakeDenied(wsUrl: string): Promise<void> {
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (e) => reject(e instanceof Error ? e : new Error(String(e))));
  });
  ws.send(JSON.stringify({ type: 'handshake', connectToken: 'wrong-token', atlas: 'pipe' }));
  const msg = await new Promise<Record<string, unknown>>((resolve, reject) => {
    ws.once('message', (d) => {
      resolve(JSON.parse(String(d)) as Record<string, unknown>);
    });
    setTimeout(() => reject(new Error('handshake deny: timeout waiting for message')), 5000);
  });
  if (msg.type !== 'error') {
    throw new Error(`expected type "error", got ${String(msg.type)}`);
  }
  ws.close();
}

useIntegrationVaultEnv();
configureModelDBStorageRoot({ storageRoot: DATA_ROOT });

const vaultPath = atlasVaultPath(DATA_ROOT, 'pipe');
if (!existsSync(vaultPath)) {
  console.error(
    `\nwire_server_audit: 缺少 ${vaultPath}。请先运行 npx tsx test/verify.ts 或完整 npm run test:integration。\n`,
  );
  process.exit(1);
}

section('0. 同进程预检 ModelDBClient.connect("pipe")');
await ModelDBClient.connect('pipe');
assert(true, '本地 Runtime 可打开 pipe Vault（与服务端将使用的存储根一致）');

section('1. 启动 WebSocket 服务（随机端口 + 集成 Vault 密钥）');
const wss = await startModelDBWebSocketServer({
  port: 0,
  storageRoot: DATA_ROOT,
  connectToken: WIRE_TOKEN,
  vaultSecret: INTEGRATION_VAULT_SECRET,
});
try {
  const port = getWebSocketServerListeningPort(wss);
  const wsUrl = `ws://127.0.0.1:${port}`;
  assert(port > 0, 'listening 端口已分配');

  section('2. SDK connectRemote + query().execute()');
  const remote = await connectRemote({
    url: wsUrl,
    connectToken: WIRE_TOKEN,
    atlas: 'pipe',
  });
  try {
    const rows = (await remote.model('Pump').query().execute()) as unknown[];
    assert(Array.isArray(rows), 'execute 返回数组');
    assert(rows.length >= 1, '至少一行 Pump');
    const first = rows[0];
    assert(
      first instanceof RemoteHydratedEntity && first.getModelName() === 'Pump',
      '行类型为 RemoteHydratedEntity 且 model 为 Pump',
    );
  } finally {
    remote.close();
  }

  section('3. 非法 ConnectToken → 服务端拒绝（独立第二条连接）');
  await expectHandshakeDenied(wsUrl);
  assert(true, '错误令牌收到 type=error 并关闭');
} finally {
  await new Promise<void>((resolve, reject) => {
    wss.close((err) => (err ? reject(err) : resolve()));
  });
}

console.log(`\nwire_server_audit: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
