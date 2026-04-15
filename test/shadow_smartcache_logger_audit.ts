/**
 * Single-file Vault 下内存指针（InternalVault）、SmartCache 失效、EngineLogger。
 * Vault 模式关闭磁盘 shadow 编码；敏感字段仅出现在密文包与内存 vault 中。
 */
import { join } from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { AuthoringEngine } from '../packages/core/authoring/engine.js';
import {
  DiagnosticCenter,
  ErrorCodes,
  type Diagnostic,
  EngineLogger,
  InternalVault,
} from '@mode-db/common';
import {
  atlasVaultPath,
  integrationVaultAuthoringOptions,
  useIntegrationVaultEnv,
} from './integration-vault.js';

const DATA_ROOT = join(process.cwd(), 'data');
const ATLAS = 'shadow_smartcache_audit';

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

async function main(): Promise<void> {
  useIntegrationVaultEnv();
  const atlasDir = join(DATA_ROOT, ATLAS);
  await rm(atlasDir, { recursive: true, force: true });

  const engine = new AuthoringEngine({
    atlas: ATLAS,
    storageRoot: DATA_ROOT,
    ...integrationVaultAuthoringOptions,
    memoryShadowHydration: true,
    enableSmartCache: true,
    engineLogger: { maxFileBytes: 1_000_000 },
  });

  engine.registerModel('Country', {
    国家: { type: 'String', required: true },
    population: { type: 'Number', required: true },
  });
  const Country = engine.model('Country');

  await Country.insert({ 国家: '中国', population: 1400 }, { sync: true });
  const vaultPath = atlasVaultPath(DATA_ROOT, ATLAS);
  assert(existsSync(vaultPath), 'atlas.mld should exist');
  const rawVault = await readFile(vaultPath);
  const asUtf8 = rawVault.toString('latin1');
  assert(!asUtf8.includes('中国'), 'vault file must not contain plaintext 中国');
  assert(rawVault.length > 200, 'vault file should be sizable opaque payload');

  const rows = await Country.query().execute();
  assert(rows.length === 1, 'expect one row');
  const entity = rows[0]!;
  const visible = entity.getData() as Record<string, unknown>;
  assert(InternalVault.isVaultPointer(visible['国家']), '国家 should be vault pointer (m_addr_*)');

  const mat = entity.materializeRow() as Record<string, unknown>;
  assert(mat['国家'] === '中国', 'materializeRow should decode 中国');

  const nameVo = entity.getValue('国家');
  assert(nameVo !== undefined && nameVo.getData() === '中国', 'getValue should resolve 中国');

  const q1 = await Country.query().execute();
  const q2 = await Country.query().execute();
  assert(q1.length === 1 && q2.length === 1, 'cached query should return same cardinality');

  await Country.insert({ 国家: '日本', population: 125 }, { sync: true });
  const q3 = await Country.query().execute();
  assert(q3.length === 2, 'after insert cache invalidation must see two countries');

  const bag: Diagnostic[] = [];
  DiagnosticCenter.report(
    ErrorCodes.SCHEMA_REQUIRED,
    { field: 'x', received: 'null' },
    'collect',
    bag,
  );
  assert(bag.length === 1, 'collect diagnostic');

  const logPath = join(atlasDir, 'logs', 'system.log');
  await new Promise((r) => setTimeout(r, 120));
  assert(existsSync(logPath), 'system.log should exist');
  const logText = await readFile(logPath, 'utf-8');
  assert(logText.includes('E1001'), 'log should capture diagnostic code');

  EngineLogger.instance.info('shadow_audit_ok');
  await new Promise((r) => setTimeout(r, 80));
  const log2 = await readFile(logPath, 'utf-8');
  assert(log2.includes('shadow_audit_ok'), 'info line appended');

  console.log('shadow_smartcache_logger_audit: OK');
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
