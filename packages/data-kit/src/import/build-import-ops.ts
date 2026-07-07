import type { EngineOperation } from '@mode-db/shared';

import type { IngestHandle, IngestRow } from '../ingest/types.js';
import { applyCleaningRules, mapIngestRow } from './apply-cleaning.js';
import {
  coerceImportRow,
  coerceInsertManyOps,
  type ImportFieldTypeMap,
} from './coerce-import-row.js';
import type { ImportProfile, RelationBindingRule } from './import-profile.js';
import {
  buildRelationBindOps,
  isBindOnlyRelationRule,
  type CatalogRelationRef,
} from './relation-bind.js';
import {
  coerceBindOnlyJoinValue,
  readJoinValueFromIngestRow,
  type BindOnlyJoinChunk,
  type ImportBindOnlyStaging,
} from './import-lookup-bind.js';
import { pickPropFields } from '../binding/apply-outcome.js';
import type { CatalogModelRef } from './relation-bind.js';

/** Engine limit per {@link EngineOperation} insertMany batch. */
export const MAX_INSERT_MANY_BATCH = 20_000;

/** Default rows per staged insertMany operation. */
export const DEFAULT_IMPORT_CHUNK_SIZE = 500;

export interface BuildImportOpsResult {
  readonly ops: readonly EngineOperation[];
  readonly importedRowCount: number;
  readonly skippedRowCount: number;
  /** Present when any bind-only relation rules require lookup bind after insert. */
  readonly bindOnlyStaging?: ImportBindOnlyStaging;
}

export interface BuildImportOpsOptions {
  readonly chunkSize?: number;
  readonly maxRows?: number;
  readonly relations?: readonly CatalogRelationRef[];
  /** Schema prop names — only these keys are sent to insertMany. */
  readonly targetFields?: readonly string[];
  /** Target model field types for import coercion (catalog). */
  readonly fieldTypes?: ImportFieldTypeMap;
  /** Catalog models for peer lookup field types (bind-only relation binding). */
  readonly catalogModels?: readonly CatalogModelRef[];
  /** When set, import rows update existing records matched by these fields instead of duplicating. */
  readonly upsertMatchFields?: readonly string[];
}

interface PreparedImportRow {
  readonly insertRow: Record<string, unknown>;
  readonly joinValues: Map<RelationBindingRule, unknown>;
}

function activeBindOnlyRules(profile: ImportProfile): RelationBindingRule[] {
  return (profile.relationBindings ?? []).filter((rule) =>
    isBindOnlyRelationRule(rule, profile.columnMapping),
  );
}

function prepareImportRow(
  row: IngestRow,
  profile: ImportProfile,
  bindOnlyRules: readonly RelationBindingRule[],
  options: BuildImportOpsOptions,
): PreparedImportRow | null {
  const mapped = mapIngestRow(row, profile.columnMapping);
  const cleaned = applyCleaningRules(mapped, profile.transformRules);
  if (cleaned === null) {
    return null;
  }
  if (profile.strict === 'strict') {
    const missingRequired = Object.values(cleaned).some(
      (v) => v === null || v === undefined || v === '',
    );
    if (missingRequired) {
      return null;
    }
  }

  const joinValues = new Map<RelationBindingRule, unknown>();
  for (const rule of bindOnlyRules) {
    joinValues.set(
      rule,
      options.catalogModels
        ? coerceBindOnlyJoinValue(row, rule, options.catalogModels)
        : readJoinValueFromIngestRow(row, rule.sourceColumn),
    );
  }

  const coerced = coerceImportRow(cleaned, options.fieldTypes);
  const insertRow = options.targetFields?.length
    ? pickPropFields(coerced, options.targetFields)
    : coerced;

  return { insertRow, joinValues };
}

/**
 * Converts mapped ingest rows into staged `insertMany` engine operations.
 */
export function buildImportInsertOps(
  profile: ImportProfile,
  rows: readonly IngestRow[],
  options: BuildImportOpsOptions = {},
): BuildImportOpsResult {
  const chunkSize = Math.min(
    options.chunkSize ?? profile.chunkSize ?? DEFAULT_IMPORT_CHUNK_SIZE,
    MAX_INSERT_MANY_BATCH,
  );
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;
  const bindOnlyRules = activeBindOnlyRules(profile);
  const needsLookupBind = bindOnlyRules.length > 0 && (options.relations?.length ?? 0) > 0;

  const prepared: PreparedImportRow[] = [];
  let skippedRowCount = 0;

  for (const row of rows) {
    if (prepared.length >= maxRows) {
      break;
    }
    const item = prepareImportRow(row, profile, bindOnlyRules, options);
    if (item === null) {
      skippedRowCount += 1;
      continue;
    }
    prepared.push(item);
  }

  const ops: EngineOperation[] = [];
  const stagingChunks: Array<{ joinValues: BindOnlyJoinChunk[] }> = [];

  for (let i = 0; i < prepared.length; i += chunkSize) {
    const slice = prepared.slice(i, i + chunkSize);
    const batch = slice.map((p) => p.insertRow);
    if (batch.length === 0) {
      continue;
    }
    ops.push({
      op: 'insertMany',
      model: profile.targetModel,
      rows: batch,
      ...(needsLookupBind ? { returning: true } : {}),
      ...(options.upsertMatchFields?.length
        ? {
            upsert: {
              matchFields: [...new Set(options.upsertMatchFields)],
              updateExisting: true,
            },
          }
        : {}),
    });

    if (needsLookupBind) {
      const joinValues: BindOnlyJoinChunk[] = bindOnlyRules.map((rule) => ({
        rule,
        values: slice.map((p) => p.joinValues.get(rule)),
      }));
      stagingChunks.push({ joinValues });
    }
  }

  const coercedOps = coerceInsertManyOps(ops, options.fieldTypes);

  if (options.relations) {
    coercedOps.push(...buildRelationBindOps(profile, options.relations));
  }

  const bindOnlyStaging: ImportBindOnlyStaging | undefined =
    needsLookupBind && stagingChunks.length > 0
      ? {
          targetModel: profile.targetModel,
          relations: options.relations ?? [],
          catalogModels: options.catalogModels,
          chunks: stagingChunks,
        }
      : undefined;

  return {
    ops: coercedOps,
    importedRowCount: prepared.length,
    skippedRowCount,
    bindOnlyStaging,
  };
}

/**
 * Reads all rows from an ingest handle and builds import operations.
 */
export async function collectImportOpsFromHandle(
  handle: IngestHandle,
  profile: ImportProfile,
  options: BuildImportOpsOptions = {},
): Promise<BuildImportOpsResult> {
  const allRows: IngestRow[] = [];
  const readChunkSize = 1000;
  for (;;) {
    const chunk = await handle.readChunk(readChunkSize);
    if (!chunk || chunk.length === 0) {
      break;
    }
    allRows.push(...chunk);
    if (options.maxRows !== undefined && allRows.length >= options.maxRows) {
      break;
    }
  }
  return buildImportInsertOps(profile, allRows, options);
}

/** Creates an import profile from mapping + metadata. */
export function createImportProfile(
  targetModel: string,
  columnMapping: Readonly<Record<string, string>>,
  sourceFingerprint: string,
  options?: {
    readonly id?: string;
    readonly strict?: ImportProfile['strict'];
    readonly chunkSize?: number;
    readonly transformRules?: ImportProfile['transformRules'];
    readonly relationBindings?: ImportProfile['relationBindings'];
  },
): ImportProfile {
  return {
    id: options?.id ?? `import-${targetModel}-${Date.now()}`,
    sourceFingerprint,
    targetModel,
    columnMapping,
    relationBindings: options?.relationBindings,
    strict: options?.strict ?? 'lenient',
    chunkSize: options?.chunkSize ?? DEFAULT_IMPORT_CHUNK_SIZE,
    transformRules: options?.transformRules ?? [{ kind: 'trim' }, { kind: 'drop_empty_rows' }],
  };
}
