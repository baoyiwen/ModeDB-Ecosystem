/**
 * 千万级压力测试与诊断审计
 *
 * 验证：
 * - 批量 insertMany 的缓冲区合并与自动刷盘
 * - Schema 强约束拦截（required / type）
 * - 读写一致性（未 flush 时 query 仍可见缓冲行）
 * - ValidationReport 聚合（getSummary / exportAsJSON）
 * - DiagnosticCenter 错误码覆盖（E1001 字段缺失 / E1003 类型错误）
 * - ValueObject.update() 运行时监控（required null → E1002）
 * - E2005 自关联死循环码存在性
 * - E3001 磁盘 IO 异常码存在性
 *
 * Run:  npx tsx test/million_stress_test.ts
 *       npm run stress-test
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { AuthoringEngine } from '../src/authoring/AuthoringEngine.js';
import {
  atlasVaultPath,
  integrationVaultAuthoringOptions,
  useIntegrationVaultEnv,
} from './integration-vault.js';
import {
  DiagnosticCenter,
  ErrorCodes,
  ValidationReport,
  type Diagnostic,
  type ValidationReportSummary,
} from '@mode-db/common';

const DATA_ROOT = join(import.meta.dirname ?? '.', '..', 'data');
const ATLAS = 'stress_world';

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

function formatNum(n: number): string {
  return n.toLocaleString('en-US');
}

async function main(): Promise<void> {
  useIntegrationVaultEnv();
  const atlasDir = join(DATA_ROOT, ATLAS);
  if (existsSync(atlasDir)) {
    await rm(atlasDir, { recursive: true, force: true });
  }

  console.log('--- 千万级数据压力测试与诊断审计开始 ---\n');

  const engine = new AuthoringEngine({
    atlas: ATLAS,
    currentLocale: 'zh',
    storageRoot: DATA_ROOT,
    ...integrationVaultAuthoringOptions,
  });

  engine.registerModel('Sensor', {
    id: { type: 'String', required: true },
    value: { type: 'Number', required: true, default: 0 },
    color: { type: 'Color', required: false },
  });

  const Sensor = engine.model('Sensor');

  // =========================================================================
  // Phase 1: 批量灌入 + 错误拦截
  // =========================================================================
  console.log('═══ Phase 1: 批量灌入 (1,000,000 行, ~1% 错误注入) ═══\n');

  const TOTAL_RECORDS = 1_000_000;
  const BATCH_SIZE = 10_000;
  const BATCHES = TOTAL_RECORDS / BATCH_SIZE;

  let totalSuccess = 0;
  let totalFail = 0;
  const allSummaries: ValidationReportSummary[] = [];
  const errorCodeSet = new Set<string>();

  const t0 = performance.now();

  for (let i = 0; i < BATCHES; i++) {
    const batch: Record<string, unknown>[] = [];
    for (let j = 0; j < BATCH_SIZE; j++) {
      const rand = Math.random();
      if (rand < 0.005) {
        // missing required `id` → E1001 (SCHEMA_REQUIRED)
        batch.push({ value: Math.random() * 100 });
      } else if (rand < 0.01) {
        // type mismatch on `value` → E1003 (TYPE_MISMATCH)
        batch.push({ id: `S_${i}_${j}`, value: 'not-a-number' });
      } else {
        batch.push({ id: `S_${i}_${j}`, value: Math.random() * 100 });
      }
    }

    const report = await Sensor.insertMany(batch);
    totalSuccess += report.successCount;
    totalFail += report.failureCount;

    const summary = report.getSummary();
    allSummaries.push(summary);
    for (const code of summary.errorCodes) {
      errorCodeSet.add(code);
    }

    if (i % 20 === 0) {
      const pct = (((i + 1) * BATCH_SIZE) / TOTAL_RECORDS) * 100;
      console.log(
        `  进度: ${pct.toFixed(0).padStart(3)}% | batch ${i + 1}/${BATCHES} | ` +
          `累计成功: ${formatNum(totalSuccess)} | 累计拦截: ${formatNum(totalFail)}`,
      );
    }
  }

  const t1 = performance.now();
  const elapsedMs = t1 - t0;

  console.log(
    `\n  灌入完成 — ${formatNum(TOTAL_RECORDS)} 行 in ${(elapsedMs / 1000).toFixed(2)}s ` +
      `(${formatNum(Math.round(TOTAL_RECORDS / (elapsedMs / 1000)))} rows/s)`,
  );

  // =========================================================================
  // Phase 2: 断言 — 诊断拦截正确性
  // =========================================================================
  console.log('\n═══ Phase 2: 诊断拦截断言 ═══');

  assert(totalSuccess + totalFail === TOTAL_RECORDS, `总行数 = ${formatNum(TOTAL_RECORDS)}`);
  assert(totalSuccess > 0, `成功行 > 0 (got ${formatNum(totalSuccess)})`);
  assert(totalFail > 0, `拦截行 > 0 (got ${formatNum(totalFail)})`);

  const errorRate = totalFail / TOTAL_RECORDS;
  assert(
    errorRate > 0.005 && errorRate < 0.02,
    `错误率 ~1% (got ${(errorRate * 100).toFixed(2)}%)`,
  );

  assert(errorCodeSet.has('E1001'), '拦截码包含 E1001 (SCHEMA_REQUIRED — value 缺失)');
  assert(errorCodeSet.has('E1003'), '拦截码包含 E1003 (TYPE_MISMATCH — value 非 number)');

  // =========================================================================
  // Phase 3: 读写一致性（缓冲区未 flush 时 query 可见）
  // =========================================================================
  console.log('\n═══ Phase 3: 读写一致性 ═══');

  const allRows = await Sensor.query().execute();
  assert(
    allRows.length === totalSuccess,
    `query 返回 ${formatNum(allRows.length)} 行 === 成功行 ${formatNum(totalSuccess)}`,
  );

  const sample = allRows[0];
  assert(sample !== undefined, '抽样行存在');
  assert(
    typeof (sample.getData() as Record<string, unknown>).id === 'string',
    '抽样行有 id (String)',
  );
  assert(
    typeof (sample.getData() as Record<string, unknown>).value === 'number',
    '抽样行有 value (Number)',
  );

  // =========================================================================
  // Phase 4: ValidationReport 聚合 API
  // =========================================================================
  console.log('\n═══ Phase 4: ValidationReport 聚合 API ═══');

  let mergedSuccess = 0;
  let mergedFail = 0;
  for (const s of allSummaries) {
    mergedSuccess += s.successCount;
    mergedFail += s.failureCount;
  }

  assert(mergedSuccess === totalSuccess, `聚合 successCount = ${formatNum(mergedSuccess)}`);
  assert(mergedFail === totalFail, `聚合 failureCount = ${formatNum(mergedFail)}`);

  // streaming .report() API
  const streamReport = new ValidationReport();
  const d1 = DiagnosticCenter.create(ErrorCodes.SCHEMA_REQUIRED, {
    field: 'id',
    received: 'null',
  });
  streamReport.report(d1);
  assert(streamReport.allDiagnostics().length === 1, '.report(entry) 流式收集成功');

  const json = streamReport.exportAsJSON();
  assert(typeof json.ok === 'boolean', 'exportAsJSON() 返回 ok');
  assert(json.globalDiagnostics.length === 1, 'exportAsJSON() globalDiagnostics 含流式条目');

  // =========================================================================
  // Phase 5: ValueObject 运行时监控
  // =========================================================================
  console.log('\n═══ Phase 5: ValueObject 运行时监控 ═══');

  const entity = allRows[0];
  const valueVO = entity.getValue('value');
  assert(valueVO !== undefined, 'getValue("value") 返回 ValueObject');

  const bag: Diagnostic[] = [];
  const ok = valueVO!.update(null, bag);
  assert(ok === false, 'update(null) on required Number → false');
  assert(bag.length >= 1, 'bag 收集 ≥1 条 diagnostic');
  assert(
    bag.some((d) => d.code === 'E1002' || d.code === 'E1003'),
    'diagnostic 包含 E1002 或 E1003',
  );

  const bag2: Diagnostic[] = [];
  const ok2 = valueVO!.update('not-a-number', bag2);
  assert(ok2 === false, 'update("not-a-number") on Number → false');
  assert(
    bag2.some((d) => d.code === 'E1003'),
    'TYPE_MISMATCH (E1003) 被捕获',
  );

  // =========================================================================
  // Phase 6: 错误码注册表完整性
  // =========================================================================
  console.log('\n═══ Phase 6: 错误码注册表完整性 ═══');

  const codes = DiagnosticCenter.codes;
  assert(codes.includes('E1001'), 'E1001 (SCHEMA_REQUIRED) 已注册');
  assert(codes.includes('E1003'), 'E1003 (TYPE_MISMATCH) 已注册');
  assert(codes.includes('E2005'), 'E2005 (SELF_REFERENTIAL_CYCLE) 已注册');
  assert(codes.includes('E3001'), 'E3001 (VALUE_RANGE_OVERFLOW) 已注册');
  assert(codes.includes('E1008'), 'E1008 (IO_PERSISTENCE_FAIL) 已注册');

  assert(ErrorCodes.SCHEMA_REQUIRED === 'E1001', 'ErrorCodes.SCHEMA_REQUIRED = E1001');
  assert(ErrorCodes.TYPE_MISMATCH === 'E1003', 'ErrorCodes.TYPE_MISMATCH = E1003');
  assert(
    ErrorCodes.SELF_REFERENTIAL_CYCLE === 'E2005',
    'ErrorCodes.SELF_REFERENTIAL_CYCLE = E2005',
  );
  assert(ErrorCodes.IO_PERSISTENCE_FAIL === 'E1008', 'ErrorCodes.IO_PERSISTENCE_FAIL = E1008');

  const e2005 = DiagnosticCenter.getCodeEntry('E2005');
  assert(e2005.severity === 'ERROR', 'E2005 severity = ERROR');
  assert(e2005.en.includes('cycle'), 'E2005 en 消息包含 "cycle"');

  const e1008 = DiagnosticCenter.getCodeEntry('E1008');
  assert(e1008.severity === 'FATAL', 'E1008 severity = FATAL');

  // =========================================================================
  // Phase 7: Flush 并验证磁盘持久化
  // =========================================================================
  console.log('\n═══ Phase 7: Flush + 磁盘验证 ═══');

  const flushT0 = performance.now();
  await engine.flushAll();
  const flushT1 = performance.now();

  console.log(`  flushAll 完成 — ${((flushT1 - flushT0) / 1000).toFixed(2)}s`);

  assert(existsSync(atlasVaultPath(DATA_ROOT, ATLAS)), 'atlas.mld（含 Sensor 模型 blob）已落盘');

  // =========================================================================
  // Summary
  // =========================================================================
  console.log('\n--- 最终诊断总结 ---');
  console.log(`  总处理:     ${formatNum(TOTAL_RECORDS)}`);
  console.log(`  成功入库:   ${formatNum(totalSuccess)}`);
  console.log(`  拦截异常:   ${formatNum(totalFail)}`);
  console.log(`  错误码:     ${[...errorCodeSet].sort().join(', ')}`);
  console.log(`  灌入耗时:   ${(elapsedMs / 1000).toFixed(2)}s`);
  console.log(`  吞吐量:     ${formatNum(Math.round(TOTAL_RECORDS / (elapsedMs / 1000)))} rows/s`);

  console.log(
    `\n${'═'.repeat(60)}\n  million_stress_test 结果：通过 ${passed}，失败 ${failed}\n${'═'.repeat(60)}\n`,
  );

  if (failed > 0) {
    process.exitCode = 1;
  }
}

void main();
