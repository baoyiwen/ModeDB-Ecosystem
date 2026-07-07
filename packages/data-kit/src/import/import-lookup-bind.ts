import type { EngineOperation } from '@mode-db/shared';

import type { CatalogModelRef, CatalogRelationRef } from './relation-bind.js';
import type { RelationBindingRule } from './import-profile.js';
import { relationForImportBinding } from './relation-bind.js';
import { importLookupCanonicalKey } from './coerce-import-cell.js';
import { coerceImportValue } from './coerce-import-row.js';

/** Join values for one bind-only rule, aligned with rows in one insertMany batch. */
export interface BindOnlyJoinChunk {
  readonly rule: RelationBindingRule;
  readonly values: readonly unknown[];
}

/** Staging metadata for two-phase import commit (insert → lookup bind). */
export interface ImportBindOnlyStaging {
  readonly targetModel: string;
  readonly relations: readonly CatalogRelationRef[];
  /** Catalog models for resolving peer match field types during lookup bind. */
  readonly catalogModels?: readonly CatalogModelRef[];
  /** One entry per generated insertMany op (same order). */
  readonly chunks: readonly {
    readonly joinValues: readonly BindOnlyJoinChunk[];
  }[];
}

/** Resolves peer `targetMatchColumn` data type from catalog (defaults to `String`). */
export function peerMatchFieldTypeForRule(
  rule: RelationBindingRule,
  catalogModels: readonly CatalogModelRef[] | undefined,
): string {
  const model = catalogModels?.find((m) => m.name === rule.targetModel);
  return model?.fieldTypes?.[rule.targetMatchColumn] ?? 'String';
}

/**
 * Normalizes lookup keys for peer-field equality (string/number tolerant).
 * Prefer {@link coerceImportLookupKey} when the peer field type is known.
 */
export function normalizeImportLookupKey(value: unknown): string | null {
  return importLookupCanonicalKey(value, 'String');
}

/**
 * Coerces a lookup value toward the peer match field type, then builds a canonical key.
 */
export function coerceImportLookupKey(value: unknown, peerMatchFieldType?: string): string | null {
  return importLookupCanonicalKey(value, peerMatchFieldType);
}

/** Reads a join value from a raw ingest row (CSV column), with optional trim. */
export function readJoinValueFromIngestRow(
  row: Readonly<Record<string, unknown>>,
  sourceColumn: string,
): unknown {
  if (!Object.prototype.hasOwnProperty.call(row, sourceColumn)) {
    return undefined;
  }
  const raw = row[sourceColumn];
  if (typeof raw === 'string') {
    return raw.trim();
  }
  return raw;
}

/**
 * Builds `bindImportLookup` ops from insertMany outcomes and staged join values.
 */
export function buildBindImportLookupOps(
  staging: ImportBindOnlyStaging,
  insertOutcomes: readonly {
    readonly op: 'insertMany';
    readonly model: string;
    readonly records?: readonly Record<string, unknown>[];
  }[],
): EngineOperation[] {
  const ops: EngineOperation[] = [];

  for (let chunkIndex = 0; chunkIndex < staging.chunks.length; chunkIndex++) {
    const chunk = staging.chunks[chunkIndex]!;
    const outcome = insertOutcomes[chunkIndex];
    if (!outcome?.records?.length) {
      continue;
    }

    const importedIds = outcome.records
      .map((r) => r._id)
      .filter((id): id is string => typeof id === 'string');
    if (importedIds.length === 0) {
      continue;
    }

    for (const joinChunk of chunk.joinValues) {
      const rule = joinChunk.rule;
      const relation = relationForImportBinding(staging.relations, staging.targetModel, rule);
      if (!relation) {
        continue;
      }

      const peerMatchFieldType = peerMatchFieldTypeForRule(rule, staging.catalogModels);
      const pairs: { importedId: string; lookupValue: unknown }[] = [];
      const limit = Math.min(importedIds.length, joinChunk.values.length);
      for (let i = 0; i < limit; i++) {
        const lookupValue = joinChunk.values[i];
        const key = coerceImportLookupKey(lookupValue, peerMatchFieldType);
        if (key === null) {
          continue;
        }
        pairs.push({ importedId: importedIds[i]!, lookupValue });
      }
      if (pairs.length === 0) {
        continue;
      }

      ops.push({
        op: 'bindImportLookup',
        forward: relation.forward,
        reverse: relation.reverse,
        importModel: staging.targetModel,
        peerModel: rule.targetModel,
        ...(relation.source === relation.target
          ? { importSide: rule.importSide ?? ('target' as const) }
          : {}),
        peerMatchField: rule.targetMatchColumn,
        peerMatchFieldType,
        pairs,
      });
    }
  }

  return ops;
}

/** Coerces bind-only join values from ingest rows toward the peer match field type. */
export function coerceBindOnlyJoinValue(
  row: Readonly<Record<string, unknown>>,
  rule: RelationBindingRule,
  catalogModels: readonly CatalogModelRef[] | undefined,
): unknown {
  const raw = readJoinValueFromIngestRow(row, rule.sourceColumn);
  return coerceImportValue(raw, peerMatchFieldTypeForRule(rule, catalogModels));
}
