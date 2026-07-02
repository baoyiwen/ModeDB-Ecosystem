import type { IngestAmbiguity, IngestAutoMapResult, IngestColumnSchema } from '../ingest/types.js';

/** Normalizes column names for fuzzy matching (case, spaces, underscores). */
export function normalizeColumnKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

export interface AutoMapIngestOptions {
  /** Target model prop field names from catalog. */
  readonly targetFields: readonly string[];
  /** When set, unmapped required fields become ambiguities. */
  readonly requiredFields?: readonly string[];
}

/**
 * Maps ingest column names to model prop fields by exact / fuzzy name match.
 * Surfaces ambiguities when multiple targets match or required fields stay unmapped.
 */
export function autoMapIngestColumns(
  ingestColumns: readonly IngestColumnSchema[],
  options: AutoMapIngestOptions,
): IngestAutoMapResult {
  const { targetFields, requiredFields = [] } = options;
  const mappedColumns: Record<string, string> = {};
  const ambiguities: IngestAmbiguity[] = [];
  const usedTargets = new Set<string>();

  const availableTargets = (): readonly string[] => targetFields.filter((f) => !usedTargets.has(f));

  for (const col of ingestColumns) {
    const normalized = normalizeColumnKey(col.name);
    if (normalized.length === 0) {
      continue;
    }

    const exact = targetFields.find((f) => normalizeColumnKey(f) === normalized);
    if (exact && !usedTargets.has(exact)) {
      mappedColumns[col.name] = exact;
      usedTargets.add(exact);
      continue;
    }

    const fuzzy = availableTargets().filter((f) => {
      const nf = normalizeColumnKey(f);
      return nf.includes(normalized) || normalized.includes(nf);
    });

    if (fuzzy.length === 1) {
      const target = fuzzy[0]!;
      mappedColumns[col.name] = target;
      usedTargets.add(target);
      continue;
    }

    if (fuzzy.length > 1) {
      ambiguities.push({
        id: `column-${col.name}`,
        kind: 'column_mapping',
        message: `Multiple model fields match ingest column "${col.name}".`,
        column: col.name,
        candidates: fuzzy,
      });
      continue;
    }

    ambiguities.push({
      id: `unmapped-${col.name}`,
      kind: 'column_mapping',
      message: `No model field matches ingest column "${col.name}" (column will be ignored).`,
      column: col.name,
    });
  }

  for (const required of requiredFields) {
    if (!usedTargets.has(required)) {
      ambiguities.push({
        id: `required-${required}`,
        kind: 'required_field',
        message: `Required model field "${required}" has no ingest column mapping.`,
        candidates: ingestColumns.map((c) => c.name),
      });
    }
  }

  return {
    mappedColumns,
    ambiguities,
    quarantinedRowCount: 0,
  };
}

/** Merges manual mapping overrides onto an auto-map result. */
export function mergeColumnMapping(
  base: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, string>>,
): Record<string, string> {
  return { ...base, ...overrides };
}
