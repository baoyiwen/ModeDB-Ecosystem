import type { EngineOperation } from '@mode-db/shared';
import { coerceImportCell } from './coerce-import-cell.js';

/** Catalog field name → engine DataType (`String`, `Int`, …). */
export type ImportFieldTypeMap = Readonly<Record<string, string>>;

/** @see {@link coerceImportCell} */
export const coerceImportValue = coerceImportCell;

/** Coerces all mapped fields in one import row. */
export function coerceImportRow(
  row: Record<string, unknown>,
  fieldTypes: ImportFieldTypeMap | undefined,
): Record<string, unknown> {
  if (!fieldTypes || Object.keys(fieldTypes).length === 0) {
    return row;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = coerceImportValue(value, fieldTypes[key]);
  }
  return out;
}

/** Coerces rows inside staged `insertMany` operations. */
export function coerceInsertManyOps(
  ops: readonly EngineOperation[],
  fieldTypes: ImportFieldTypeMap | undefined,
): EngineOperation[] {
  if (!fieldTypes || Object.keys(fieldTypes).length === 0) {
    return [...ops];
  }
  return ops.map((op) => {
    if (op.op !== 'insertMany') {
      return op;
    }
    return {
      ...op,
      rows: op.rows.map((row) => coerceImportRow(row, fieldTypes)),
    };
  });
}

/** Builds fieldTypes map defaulting unregistered props to `String`. */
export function importFieldTypesForProps(
  propFields: readonly string[],
  catalogFieldTypes: ImportFieldTypeMap | undefined,
): ImportFieldTypeMap {
  const out: Record<string, string> = {};
  for (const field of propFields) {
    out[field] = catalogFieldTypes?.[field] ?? 'String';
  }
  return out;
}
