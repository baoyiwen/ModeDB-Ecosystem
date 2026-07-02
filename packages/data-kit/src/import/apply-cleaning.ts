import type { CleaningRule } from './import-profile.js';
import type { IngestRow } from '../ingest/types.js';

/** Applies cleaning rules to one mapped row; returns null when the row should be dropped. */
export function applyCleaningRules(
  row: Record<string, unknown>,
  rules: readonly CleaningRule[] | undefined,
): Record<string, unknown> | null {
  if (!rules || rules.length === 0) {
    return row;
  }

  const out: Record<string, unknown> = { ...row };

  for (const rule of rules) {
    switch (rule.kind) {
      case 'trim': {
        const cols = rule.columns ?? Object.keys(out);
        for (const col of cols) {
          const value = out[col];
          if (typeof value === 'string') {
            out[col] = value.trim();
          }
        }
        break;
      }
      case 'drop_empty_rows': {
        const empty = Object.values(out).every((v) => v === null || v === undefined || v === '');
        if (empty) {
          return null;
        }
        break;
      }
      case 'coerce_type': {
        const raw = out[rule.column];
        out[rule.column] = coerceToDataType(raw, rule.dataType);
        break;
      }
      case 'default_value': {
        const current = out[rule.column];
        if (current === null || current === undefined || current === '') {
          out[rule.column] = rule.value;
        }
        break;
      }
      case 'regex_replace': {
        const raw = out[rule.column];
        if (typeof raw === 'string') {
          out[rule.column] = raw.replace(new RegExp(rule.pattern, 'g'), rule.replacement);
        }
        break;
      }
      default: {
        const _exhaustive: never = rule;
        return _exhaustive;
      }
    }
  }

  return out;
}

function coerceToDataType(value: unknown, dataType: string): unknown {
  if (value === null || value === undefined || value === '') {
    return value;
  }
  const dt = dataType.toUpperCase();
  if (dt.includes('INT') || dt === 'FLOAT64' || dt === 'FLOAT32' || dt === 'NUMBER') {
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
  if (dt === 'BOOL' || dt === 'BOOLEAN') {
    if (typeof value === 'boolean') {
      return value;
    }
    const s = String(value).toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
  }
  return String(value);
}

/** Maps ingest row keys to model prop keys using column mapping. */
export function mapIngestRow(
  row: IngestRow,
  columnMapping: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [sourceCol, targetField] of Object.entries(columnMapping)) {
    if (Object.prototype.hasOwnProperty.call(row, sourceCol)) {
      out[targetField] = row[sourceCol];
    }
  }
  return out;
}
