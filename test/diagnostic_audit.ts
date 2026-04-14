/**
 * DiagnosticCenter 审计：ErrorCodes 命名别名、ErrorRegistry、ValidationReport
 * (isAllSuccess / getSummary / exportAsJSON)、Severity 分级、国际化、
 * ValueObject 联动（required + type mismatch）、insertMany 批量报告、
 * 自动刷盘 emergency dump。
 *
 * Run:  npx tsx test/diagnostic_audit.ts
 *       npm run diagnostic-audit
 *       npm run test:integration（含本脚本；当前约 122 条断言）
 */

import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, rm, readFile, rename } from 'node:fs/promises';
import { AuthoringEngine } from '../src/authoring/AuthoringEngine.js';
import { integrationVaultAuthoringOptions, useIntegrationVaultEnv } from './integration-vault.js';
import {
  ValidationError,
  FileIOError,
  DiagnosticCenter,
  ValidationReport,
  ErrorCodes,
  type Diagnostic,
  validateFieldValue,
  type FieldTypeDef,
} from '@mode-db/common';

const DATA_ROOT = join(import.meta.dirname ?? '.', '..', 'data');
const ATLAS = 'diag_audit';

const VAULT_ENGINE_BASE = {
  atlas: ATLAS,
  currentLocale: 'zh' as const,
  storageRoot: DATA_ROOT,
  ...integrationVaultAuthoringOptions,
};

let passed = 0;
let failed = 0;

function assert(cond: boolean, label: string): void {
  if (cond) {
    passed++;
    console.log(`  \u2713 ${label}`);
  } else {
    failed++;
    console.error(`  \u2717 FAIL: ${label}`);
  }
}

// ---------------------------------------------------------------------------
// 1. ErrorCodes 命名别名
// ---------------------------------------------------------------------------
function auditErrorCodes(): void {
  console.log('\n═══ 1. ErrorCodes 命名别名 ═══');

  assert(ErrorCodes.SCHEMA_REQUIRED === 'E1001', 'SCHEMA_REQUIRED = E1001');
  assert(ErrorCodes.SCHEMA_REQUIRED_EMPTY === 'E1002', 'SCHEMA_REQUIRED_EMPTY = E1002');
  assert(ErrorCodes.TYPE_MISMATCH === 'E1003', 'TYPE_MISMATCH = E1003');
  assert(ErrorCodes.UNKNOWN_TYPE === 'E1004', 'UNKNOWN_TYPE = E1004');
  assert(ErrorCodes.I18N_MISSING_LOCALE === 'E1005', 'I18N_MISSING_LOCALE = E1005');
  assert(ErrorCodes.COLOR_AUTO_COERCED === 'E1006', 'COLOR_AUTO_COERCED = E1006');
  assert(ErrorCodes.VO_NO_SYNC === 'E1007', 'VO_NO_SYNC = E1007');
  assert(ErrorCodes.IO_PERSISTENCE_FAIL === 'E1008', 'IO_PERSISTENCE_FAIL = E1008');
  assert(ErrorCodes.MODEL_NOT_REGISTERED === 'E1009', 'MODEL_NOT_REGISTERED = E1009');
  assert(ErrorCodes.BATCH_ROW_FAIL === 'E1010', 'BATCH_ROW_FAIL = E1010');
  assert(ErrorCodes.DEFAULT_INJECTED === 'E1011', 'DEFAULT_INJECTED = E1011');
  assert(ErrorCodes.VALUE_RANGE_OVERFLOW === 'E3001', 'VALUE_RANGE_OVERFLOW = E3001');
  assert(ErrorCodes.PHYSICAL_ADDRESS_CORRUPT === 'E3002', 'PHYSICAL_ADDRESS_CORRUPT = E3002');
}

// ---------------------------------------------------------------------------
// 2. 错误码注册表
// ---------------------------------------------------------------------------
function auditCodeRegistry(): void {
  console.log('\n═══ 2. 错误码注册表 ═══');

  const codes = DiagnosticCenter.codes;
  assert(codes.length >= 13, `至少 13 个错误码 (got ${codes.length})`);
  assert(codes.includes('E1001'), '包含 E1001');
  assert(codes.includes('E3001'), '包含 E3001 (VALUE_RANGE_OVERFLOW)');
  assert(codes.includes('E3002'), '包含 E3002 (PHYSICAL_ADDRESS_CORRUPT)');

  const e1001 = DiagnosticCenter.getCodeEntry('E1001');
  assert(e1001.severity === 'ERROR', 'E1001 severity = ERROR');
  assert(typeof e1001.en === 'string' && e1001.en.length > 0, 'E1001 有英文消息');
  assert(typeof e1001.zh === 'string' && e1001.zh.length > 0, 'E1001 有中文消息');

  const e1008 = DiagnosticCenter.getCodeEntry('E1008');
  assert(e1008.severity === 'FATAL', 'E1008 severity = FATAL');

  const e3001 = DiagnosticCenter.getCodeEntry('E3001');
  assert(e3001.severity === 'ERROR', 'E3001 severity = ERROR');
  assert(e3001.en.includes('range'), 'E3001 en 消息包含 "range"');

  const e3002 = DiagnosticCenter.getCodeEntry('E3002');
  assert(e3002.severity === 'FATAL', 'E3002 severity = FATAL');
  assert(
    e3002.en.includes('vault') || e3002.en.includes('corrupt'),
    'E3002 en 消息含 vault/corrupt 语义',
  );
}

// ---------------------------------------------------------------------------
// 3. report throw vs collect
// ---------------------------------------------------------------------------
function auditReportModes(): void {
  console.log('\n═══ 3. report throw vs collect ═══');

  let threw = false;
  try {
    DiagnosticCenter.report(
      ErrorCodes.SCHEMA_REQUIRED,
      { field: 'name', received: 'null' },
      'throw',
    );
  } catch (err) {
    if (err instanceof ValidationError) {
      threw = true;
    }
  }
  assert(threw, 'throw 模式抛出 ValidationError');

  const bag: Diagnostic[] = [];
  const d = DiagnosticCenter.report(
    ErrorCodes.SCHEMA_REQUIRED,
    { field: 'name', received: 'null' },
    'collect',
    bag,
  );
  assert(bag.length === 1, 'collect 模式推入 bag');
  assert(d.code === 'E1001', 'collect 返回 Diagnostic');
  assert(d.severity === 'ERROR', 'Diagnostic severity = ERROR');
  assert(typeof d.timestamp === 'number', 'Diagnostic 有 timestamp');
}

// ---------------------------------------------------------------------------
// 4. report severity 覆盖
// ---------------------------------------------------------------------------
function auditSeverityOverride(): void {
  console.log('\n═══ 4. report severity 覆盖 ═══');

  const bag: Diagnostic[] = [];
  const d = DiagnosticCenter.report(
    ErrorCodes.TYPE_MISMATCH,
    { field: 'x', type: 'Int', received: 'string' },
    'collect',
    bag,
    'WARN',
  );
  assert(d.severity === 'WARN', 'severity 被覆盖为 WARN');
  assert(d.code === 'E1003', 'code 仍为 E1003');
}

// ---------------------------------------------------------------------------
// 5. DiagnosticCenter.create
// ---------------------------------------------------------------------------
function auditCreate(): void {
  console.log('\n═══ 5. DiagnosticCenter.create ═══');

  const d = DiagnosticCenter.create('E1003', { field: 'age', type: 'Int', received: 'string' });
  assert(d.code === 'E1003', 'create 返回 E1003');
  assert(d.severity === 'ERROR', 'severity = ERROR');
  assert(d.message.includes('age'), '消息包含字段名');
}

// ---------------------------------------------------------------------------
// 6. 国际化消息
// ---------------------------------------------------------------------------
function auditLocale(): void {
  console.log('\n═══ 6. 国际化消息 ═══');

  const origLocale = DiagnosticCenter.locale;

  DiagnosticCenter.locale = 'en';
  const en = DiagnosticCenter.create('E1001', { field: 'name', received: 'null' });
  assert(en.message.includes('required'), 'en 消息包含 "required"');

  DiagnosticCenter.locale = 'zh';
  const zh = DiagnosticCenter.create('E1001', { field: 'name', received: 'null' });
  assert(zh.message.includes('必填'), 'zh 消息包含 "必填"');

  DiagnosticCenter.locale = origLocale;
}

// ---------------------------------------------------------------------------
// 7. onDiagnostic 监听器
// ---------------------------------------------------------------------------
function auditListener(): void {
  console.log('\n═══ 7. onDiagnostic 监听器 ═══');

  const captured: Diagnostic[] = [];
  const unsub = DiagnosticCenter.onDiagnostic((d) => captured.push(d));

  const bag: Diagnostic[] = [];
  DiagnosticCenter.report(
    ErrorCodes.TYPE_MISMATCH,
    { field: 'x', type: 'Int', received: 'string' },
    'collect',
    bag,
  );
  assert(captured.length === 1, '监听器捕获 1 条 diagnostic');
  assert(captured[0].code === 'E1003', '监听器捕获正确 code');

  unsub();
  DiagnosticCenter.report(
    ErrorCodes.TYPE_MISMATCH,
    { field: 'y', type: 'Int', received: 'string' },
    'collect',
    bag,
  );
  assert(captured.length === 1, '取消订阅后不再捕获');
}

// ---------------------------------------------------------------------------
// 8. ValidationReport — 基础 API + isAllSuccess / getSummary / exportAsJSON
// ---------------------------------------------------------------------------
function auditValidationReport(): void {
  console.log('\n═══ 8. ValidationReport 基础 API ═══');

  const report = new ValidationReport<{ id: string }>();

  report.addRow({ index: 0, success: true, data: { id: 'a' }, diagnostics: [] });
  report.addRow({
    index: 1,
    success: false,
    diagnostics: [DiagnosticCenter.create('E1001', { field: 'name', received: 'null' })],
  });
  report.addRow({
    index: 2,
    success: true,
    data: { id: 'c' },
    diagnostics: [DiagnosticCenter.create('E1006', { field: 'color' })],
  });

  assert(report.rows.length === 3, 'rows.length = 3');
  assert(report.successCount === 2, 'successCount = 2');
  assert(report.failureCount === 1, 'failureCount = 1');
  assert(report.totalSucceeded === 2, 'totalSucceeded (deprecated) = 2');
  assert(report.totalFailed === 1, 'totalFailed (deprecated) = 1');
  assert(report.ok === false, 'ok = false (有失败行)');
  assert(report.isAllSuccess() === false, 'isAllSuccess() = false');
  assert(report.hasWarnings === true, 'hasWarnings = true');
  assert(report.succeeded.length === 2, 'succeeded.length = 2');
  assert(report.failed.length === 1, 'failed.length = 1');
  assert(report.errors().length === 1, 'errors().length = 1');
  assert(report.warnings().length === 1, 'warnings().length = 1');
  assert(report.allDiagnostics().length === 2, 'allDiagnostics().length = 2');

  const summary = report.getSummary();
  assert(summary.total === 3, 'getSummary().total = 3');
  assert(summary.successCount === 2, 'getSummary().successCount = 2');
  assert(summary.failureCount === 1, 'getSummary().failureCount = 1');
  assert(summary.errorCodes.includes('E1001'), 'getSummary().errorCodes 包含 E1001');
  assert(summary.hasFatal === false, 'getSummary().hasFatal = false');

  const json = report.exportAsJSON();
  assert(json.ok === false, 'exportAsJSON().ok = false');
  assert(json.rows.length === 3, 'exportAsJSON().rows.length = 3');
  assert(json.summary.successCount === 2, 'exportAsJSON().summary.successCount = 2');
  assert(json.globalDiagnostics.length === 0, 'exportAsJSON().globalDiagnostics 为空');
}

// ---------------------------------------------------------------------------
// 9. validateFieldValue — collect 模式
// ---------------------------------------------------------------------------
function auditValidateCollect(): void {
  console.log('\n═══ 9. validateFieldValue collect 模式 ═══');

  const def: FieldTypeDef = { type: 'Int', required: true };
  const bag: Diagnostic[] = [];

  const ok = validateFieldValue('age', 42, def, { diagnostics: bag });
  assert(ok === true, '合法值返回 true');
  assert(bag.length === 0, '无 diagnostic');

  const fail1 = validateFieldValue('age', 'abc', def, { diagnostics: bag });
  assert(fail1 === false, '非法值返回 false');
  assert(bag.length === 1, 'bag 收集 1 条');
  assert(bag[0].code === 'E1003', 'code = E1003 (TYPE_MISMATCH)');

  const fail2 = validateFieldValue('age', null, def, { diagnostics: bag });
  assert(fail2 === false, 'null required 返回 false');
  assert(bag.length === 2, 'bag 收集 2 条');
  assert(bag[1].code === 'E1001', 'code = E1001 (SCHEMA_REQUIRED)');
}

// ---------------------------------------------------------------------------
// 10. validateFieldValue — throw 向后兼容
// ---------------------------------------------------------------------------
function auditValidateThrowCompat(): void {
  console.log('\n═══ 10. validateFieldValue throw 向后兼容 ═══');

  const def: FieldTypeDef = { type: 'String', required: true };

  let threw = false;
  try {
    validateFieldValue('name', null, def, 'zh');
  } catch (err) {
    if (err instanceof ValidationError) {
      threw = true;
    }
  }
  assert(threw, '传 string locale 仍然 throw');

  threw = false;
  try {
    validateFieldValue('name', null, def);
  } catch (err) {
    if (err instanceof ValidationError) {
      threw = true;
    }
  }
  assert(threw, '无第四参数仍然 throw');
}

// ---------------------------------------------------------------------------
// 11. insertMany — 批量校验报告
// ---------------------------------------------------------------------------
async function auditInsertMany(): Promise<void> {
  console.log('\n═══ 11. insertMany 批量校验报告 ═══');

  const engine = new AuthoringEngine({ ...VAULT_ENGINE_BASE });

  engine.registerModel('BatchModel', {
    name: { type: 'String', required: true },
    age: { type: 'Int' },
  });
  const m = engine.model('BatchModel');

  const report = await m.insertMany([
    { name: 'Alice', age: 25 },
    { name: '', age: 30 },
    { age: 10 },
    { name: 'Bob', age: 42 },
    { name: 'Charlie', age: 'not-a-number' },
  ]);

  assert(report.successCount === 2, 'insertMany: 2 行成功');
  assert(report.failureCount === 3, 'insertMany: 3 行失败');
  assert(report.isAllSuccess() === false, 'insertMany: isAllSuccess() = false');

  const failedRows = report.failed;
  assert(failedRows[0].index === 1, '失败行 0: index = 1 (空 name)');
  assert(failedRows[1].index === 2, '失败行 1: index = 2 (缺 name)');
  assert(failedRows[2].index === 4, '失败行 2: index = 4 (age 类型错误)');

  const successRows = report.succeeded;
  assert(successRows[0].index === 0, '成功行 0: index = 0');
  assert(successRows[1].index === 3, '成功行 1: index = 3');
  assert(successRows[0].data !== undefined, '成功行有 data');
  assert((successRows[0].data as Record<string, unknown>)._id !== undefined, '成功行 data 有 _id');

  const results = await m.query().execute();
  assert(results.length === 2, 'query 返回 2 行（仅成功行进入缓冲区）');

  const json = report.exportAsJSON();
  assert(json.rows.length === 5, 'exportAsJSON rows = 5');
  assert(json.summary.failureCount === 3, 'exportAsJSON summary.failureCount = 3');

  await engine.flushAll();
}

// ---------------------------------------------------------------------------
// 12. insertMany — 全部成功
// ---------------------------------------------------------------------------
async function auditInsertManyAllOk(): Promise<void> {
  console.log('\n═══ 12. insertMany 全部成功 ═══');

  const engine = new AuthoringEngine({ ...VAULT_ENGINE_BASE });

  engine.registerModel('BatchOk', {
    x: { type: 'Int' },
  });
  const m = engine.model('BatchOk');

  const report = await m.insertMany([{ x: 1 }, { x: 2 }, { x: 3 }]);
  assert(report.isAllSuccess() === true, 'isAllSuccess() = true');
  assert(report.successCount === 3, 'successCount = 3');
  assert(report.failureCount === 0, 'failureCount = 0');
  assert(report.errors().length === 0, 'errors 为空');

  await engine.flushAll();
}

// ---------------------------------------------------------------------------
// 13. ValueObject.update() — DiagnosticCenter 联动 (required + type mismatch)
// ---------------------------------------------------------------------------
async function auditVODiagnostic(): Promise<void> {
  console.log('\n═══ 13. ValueObject.update() DiagnosticCenter 联动 ═══');

  const engine = new AuthoringEngine({ ...VAULT_ENGINE_BASE });

  engine.registerModel('VODiag', {
    name: { type: 'String', required: true },
    tag: 'String',
    count: { type: 'Int' },
  });
  const m = engine.model('VODiag');
  await m.insert({ name: 'test', tag: 'a', count: 10 });

  const entities = await m.query().execute();
  const entity = entities[0]!;

  const nameVO = entity.getValue('name')!;
  assert(nameVO._diagCtx !== undefined, 'ValueObject 有 _diagCtx');
  assert(nameVO._diagCtx!.model === 'VODiag', '_diagCtx.model = "VODiag"');
  assert(nameVO._diagCtx!.recordId !== undefined, '_diagCtx.recordId 存在');

  // required empty → E1002
  const bag: Diagnostic[] = [];
  const ok = nameVO.update('', bag);
  assert(ok === false, 'update("") required → false');
  assert(bag.length === 1, 'bag 收集 1 条');
  assert(bag[0].code === 'E1002', 'code = E1002 (SCHEMA_REQUIRED_EMPTY)');
  assert(bag[0].context.model === 'VODiag', 'context.model = "VODiag"');

  // type mismatch → E1003
  const countVO = entity.getValue('count')!;
  const bag3: Diagnostic[] = [];
  const ok3 = countVO.update('not-a-number', bag3);
  assert(ok3 === false, 'update("not-a-number") on Int → false');
  assert(bag3.length === 1, 'bag3 收集 1 条');
  assert(bag3[0].code === 'E1003', 'code = E1003 (TYPE_MISMATCH)');

  // non-required update("") → success
  const tagVO = entity.getValue('tag')!;
  const bag2: Diagnostic[] = [];
  const ok2 = tagVO.update('', bag2);
  assert(ok2 === true, '非 required update("") → true');
  assert(bag2.length === 0, '无 diagnostic');

  await engine.flushAll();
}

// ---------------------------------------------------------------------------
// 14. Severity 分级
// ---------------------------------------------------------------------------
function auditSeverity(): void {
  console.log('\n═══ 14. Severity 分级 ═══');

  const fatal = DiagnosticCenter.create(ErrorCodes.IO_PERSISTENCE_FAIL, { detail: 'disk full' });
  assert(fatal.severity === 'FATAL', 'IO_PERSISTENCE_FAIL = FATAL');

  const error = DiagnosticCenter.create(ErrorCodes.SCHEMA_REQUIRED, {
    field: 'x',
    received: 'null',
  });
  assert(error.severity === 'ERROR', 'SCHEMA_REQUIRED = ERROR');

  const warn = DiagnosticCenter.create(ErrorCodes.COLOR_AUTO_COERCED, { field: 'color' });
  assert(warn.severity === 'WARN', 'COLOR_AUTO_COERCED = WARN');

  const range = DiagnosticCenter.create(ErrorCodes.VALUE_RANGE_OVERFLOW, {
    field: 'score',
    received: '999',
  });
  assert(range.severity === 'ERROR', 'VALUE_RANGE_OVERFLOW = ERROR');
}

// ---------------------------------------------------------------------------
// 15. DiagnosticCenter.toError
// ---------------------------------------------------------------------------
function auditToError(): void {
  console.log('\n═══ 15. DiagnosticCenter.toError ═══');

  const d1 = DiagnosticCenter.create('E1001', { field: 'x', received: 'null' });
  const e1 = DiagnosticCenter.toError(d1);
  assert(e1 instanceof ValidationError, 'ERROR → ValidationError');

  const d2 = DiagnosticCenter.create('E1008', { detail: 'disk full', filePath: '/tmp/x.mld' });
  const e2 = DiagnosticCenter.toError(d2);
  assert(e2 instanceof FileIOError, 'FATAL + filePath → FileIOError');
}

// ---------------------------------------------------------------------------
// 16. ValidationReport.globalDiagnostics
// ---------------------------------------------------------------------------
function auditGlobalDiag(): void {
  console.log('\n═══ 16. ValidationReport.globalDiagnostics ═══');

  const report = new ValidationReport();
  report.addGlobal(
    DiagnosticCenter.create(ErrorCodes.IO_PERSISTENCE_FAIL, { detail: 'disk full' }),
  );
  report.addRow({ index: 0, success: true, diagnostics: [] });

  assert(report.globalDiagnostics.length === 1, 'globalDiagnostics.length = 1');
  assert(report.ok === false, 'FATAL global → ok = false');
  assert(report.isAllSuccess() === false, 'FATAL global → isAllSuccess() = false');
  assert(report.allDiagnostics().length === 1, 'allDiagnostics 包含 global');

  const summary = report.getSummary();
  assert(summary.hasFatal === true, 'getSummary().hasFatal = true');
}

// ---------------------------------------------------------------------------
// 17. ValidationReport — 全成功场景
// ---------------------------------------------------------------------------
function auditReportAllSuccess(): void {
  console.log('\n═══ 17. ValidationReport 全成功场景 ═══');

  const report = new ValidationReport<{ id: string }>();
  report.addRow({ index: 0, success: true, data: { id: 'a' }, diagnostics: [] });
  report.addRow({ index: 1, success: true, data: { id: 'b' }, diagnostics: [] });

  assert(report.isAllSuccess() === true, 'isAllSuccess() = true');
  assert(report.ok === true, 'ok = true');
  assert(report.successCount === 2, 'successCount = 2');
  assert(report.failureCount === 0, 'failureCount = 0');

  const json = report.exportAsJSON();
  assert(json.ok === true, 'exportAsJSON().ok = true');
  assert(
    json.rows.every((r) => r.success),
    'exportAsJSON 所有行 success',
  );
}

// ---------------------------------------------------------------------------
// 18. Emergency dump on flush failure
// ---------------------------------------------------------------------------
async function auditEmergencyDump(): Promise<void> {
  console.log('\n═══ 18. Emergency dump on flush failure ═══');

  const engine = new AuthoringEngine({ ...VAULT_ENGINE_BASE });

  engine.registerModel('DumpTest', { val: 'Int' });
  const m = engine.model('DumpTest');
  await m.insert({ val: 1 });
  await m.insert({ val: 2 });

  const mldPath = engine.paths.modelDataPath('DumpTest');
  const primaryDump = join(dirname(mldPath), 'DumpTest.dump');
  const fallbackDump = join(dirname(dirname(mldPath)), 'DumpTest.dump');

  for (const p of [primaryDump, fallbackDump]) {
    if (existsSync(p)) {
      await rm(p, { force: true });
    }
  }

  // Sabotage: replace atlas.mld with a directory so vault saveSync fails
  const vaultPath = engine.paths.atlasSingleVaultPath();
  const vaultBackup = `${vaultPath}.bak_integrity`;
  await rename(vaultPath, vaultBackup);
  await mkdir(vaultPath);

  let flushThrew = false;
  try {
    await engine.persistence.flushModelToDisk('DumpTest');
  } catch {
    flushThrew = true;
  }
  assert(flushThrew, 'flush 失败抛出异常');

  await rm(vaultPath, { recursive: true, force: true });
  await rename(vaultBackup, vaultPath);

  // The dump file should exist (primary or fallback location)
  const dumpExists = existsSync(primaryDump) || existsSync(fallbackDump);
  assert(dumpExists, '.dump 文件已创建（primary 或 fallback）');
  const dumpPath = existsSync(primaryDump) ? primaryDump : fallbackDump;
  if (dumpExists) {
    const content = await readFile(dumpPath, 'utf-8');
    const lines = content.trim().split('\n');
    assert(lines.length === 2, '.dump 包含 2 行缓冲数据');
    const row0 = JSON.parse(lines[0]) as Record<string, unknown>;
    assert(row0.val === 1, '.dump 第一行 val = 1');
  }

  for (const p of [primaryDump, fallbackDump]) {
    if (existsSync(p)) {
      await rm(p, { force: true });
    }
  }
  await engine.flushAll();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  useIntegrationVaultEnv();
  const atlasDir = join(DATA_ROOT, ATLAS);
  if (existsSync(atlasDir)) {
    await rm(atlasDir, { recursive: true, force: true });
  }

  auditErrorCodes();
  auditCodeRegistry();
  auditReportModes();
  auditSeverityOverride();
  auditCreate();
  auditLocale();
  auditListener();
  auditValidationReport();
  auditValidateCollect();
  auditValidateThrowCompat();
  await auditInsertMany();
  await auditInsertManyAllOk();
  await auditVODiagnostic();
  auditSeverity();
  auditToError();
  auditGlobalDiag();
  auditReportAllSuccess();
  await auditEmergencyDump();

  console.log(
    `\n${'═'.repeat(60)}\n  diagnostic_audit 结果：通过 ${passed}，失败 ${failed}\n${'═'.repeat(60)}\n`,
  );

  if (failed > 0) {
    process.exitCode = 1;
  }
}

void main();
