import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { summarizeQueryInterfaceAuditRows } from '../../apps/model-designer/src/sync/query-interface-registry.js';

describe('QueryInterface audit summaries', () => {
  it('builds all-time totals, a fixed 24-hour trend and recent calls', () => {
    const summaries = summarizeQueryInterfaceAuditRows(
      [
        auditRow('2026-07-21T12:10:00.000Z', 'success', 10, { row_count: 4 }),
        auditRow('2026-07-21T10:05:00.000Z', 'error', 30, {
          error_code: 'INTERFACE_RATE_LIMITED',
        }),
        auditRow('2026-07-20T13:59:00.000Z', 'success', 50),
        auditRow('2026-07-21T11:00:00.000Z', 'success', 5, {
          callable_name: 'otherInterface',
        }),
      ],
      Date.parse('2026-07-21T12:30:00.000Z'),
    );

    const summary = summaries.get('itemsByCategory');
    assert.equal(summary?.callCount, 3);
    assert.equal(summary?.successCount, 2);
    assert.equal(summary?.errorCount, 1);
    assert.equal(summary?.averageDurationMs, 30);
    assert.equal(summary?.lastErrorCode, 'INTERFACE_RATE_LIMITED');
    assert.equal(summary?.trend.length, 12);
    assert.equal(summary?.trend.reduce((total, point) => total + point.callCount, 0), 2);
    assert.equal(summary?.trend.at(-1)?.callCount, 1);
    assert.equal(summary?.trend.at(-2)?.errorCount, 1);
    assert.deepEqual(
      summary?.recentCalls.map((call) => call.startedAt),
      [
        '2026-07-21T12:10:00.000Z',
        '2026-07-21T10:05:00.000Z',
        '2026-07-20T13:59:00.000Z',
      ],
    );
  });

  it('limits recent calls and keeps empty trend buckets stable', () => {
    const now = Date.parse('2026-07-21T12:30:00.000Z');
    const rows = Array.from({ length: 10 }, (_, index) =>
      auditRow(new Date(now - index * 1_000).toISOString(), 'success', index),
    );
    const summary = summarizeQueryInterfaceAuditRows(rows, now).get('itemsByCategory');

    assert.equal(summary?.recentCalls.length, 8);
    assert.equal(summary?.trend.length, 12);
    assert.equal(summary?.trend.filter((point) => point.callCount === 0).length, 11);
  });
});

function auditRow(
  startedAt: string,
  status: 'success' | 'error',
  durationMs: number,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    callable_name: 'itemsByCategory',
    requested_version: '1.0.0',
    resolved_version: '1.0.0',
    status,
    error_code: '',
    started_at: startedAt,
    duration_ms: durationMs,
    row_count: 0,
    pagination_mode: 'cursor',
    ...overrides,
  };
}
