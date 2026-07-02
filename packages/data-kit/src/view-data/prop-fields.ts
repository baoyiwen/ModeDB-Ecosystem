import type { ColumnDef } from './view-data-shape.js';

/** Engine row keys that are not user-defined props (hidden from data views by default). */
export const SYSTEM_ROW_FIELD_KEYS: ReadonlySet<string> = new Set([
  '_id',
  '_rev',
  '_deleted',
  '_tombstone',
  '_version',
]);

/** Returns true when the key is an engine/system field rather than a schema prop. */
export function isSystemRowField(key: string): boolean {
  return SYSTEM_ROW_FIELD_KEYS.has(key) || key.startsWith('_');
}

/**
 * Normalizes catalog model fields to displayable prop names (schema props only).
 * Falls back to excluding {@link isSystemRowField} keys when catalog is empty.
 */
export function propFieldsFromCatalogFields(fields: readonly string[]): readonly string[] {
  const props = fields.filter((f) => !isSystemRowField(f));
  return props.length > 0 ? props : fields.filter((f) => f !== '_id');
}

/** Restrict inferred columns to schema prop fields (preserves catalog order). */
export function applyPropFieldColumns(
  columns: ColumnDef[],
  propFields: readonly string[] | undefined,
): ColumnDef[] {
  if (!propFields || propFields.length === 0) {
    return columns.filter((c) => !isSystemRowField(c.key));
  }
  const existing = new Map(columns.map((c) => [c.key, c]));
  return propFields.map((key) => {
    const found = existing.get(key);
    if (found) {
      return found;
    }
    return { key, readOnly: false };
  });
}
