import type { EngineOperation } from '@mode-db/shared';

import type { IngestColumnSchema } from '../ingest/types.js';
import type { FieldLabelMap } from '../view-data/field-display-label.js';
import { normalizeColumnKey } from './auto-map.js';
import type { RelationBindingRule } from './import-profile.js';

/** Returns true when the join column should not be persisted on the import model. */
export function isBindOnlyRelationRule(
  rule: RelationBindingRule,
  columnMapping: Readonly<Record<string, string>>,
): boolean {
  if (rule.bindOnly === true) {
    return true;
  }
  if (rule.bindOnly === false) {
    return false;
  }
  return !Object.prototype.hasOwnProperty.call(columnMapping, rule.sourceColumn);
}

/** Minimal catalog relation row (from management API). */
export interface CatalogRelationRef {
  readonly forward: string;
  readonly reverse: string;
  readonly source: string;
  readonly target: string;
}

/** Catalog model row for field pickers / suggestions. */
export interface CatalogModelRef {
  readonly name: string;
  readonly fields: readonly string[];
  readonly fieldLabels?: FieldLabelMap;
  readonly fieldTypes?: Readonly<Record<string, string>>;
}

/** Resolved PROTOCOL `matchOn` for one import relation rule. */
export interface ProtocolBindMatch {
  readonly forward: string;
  readonly reverse: string;
  readonly sourceField: string;
  readonly targetField: string;
}

/** Relations where `importModel` participates as source or target. */
export function relationsForImportModel(
  importModel: string,
  relations: readonly CatalogRelationRef[],
): readonly CatalogRelationRef[] {
  return relations.filter((r) => r.source === importModel || r.target === importModel);
}

/** Returns the peer model on a relation relative to the import target model. */
export function relatedModelForImport(
  relation: CatalogRelationRef,
  importModel: string,
): string | null {
  if (relation.source === importModel) {
    return relation.target;
  }
  if (relation.target === importModel) {
    return relation.source;
  }
  return null;
}

/**
 * Resolves a {@link RelationBindingRule} to PROTOCOL field pairing on the registered relation.
 */
export function resolveProtocolBindMatch(
  rule: RelationBindingRule,
  relation: CatalogRelationRef,
  importModel: string,
  mappedImportField: string,
): ProtocolBindMatch | null {
  if (relation.forward !== rule.relation) {
    return null;
  }
  if (rule.targetModel !== relation.source && rule.targetModel !== relation.target) {
    return null;
  }

  if (importModel === relation.target && rule.targetModel === relation.source) {
    return {
      forward: relation.forward,
      reverse: relation.reverse,
      sourceField: rule.targetMatchColumn,
      targetField: mappedImportField,
    };
  }

  if (importModel === relation.source && rule.targetModel === relation.target) {
    return {
      forward: relation.forward,
      reverse: relation.reverse,
      sourceField: mappedImportField,
      targetField: rule.targetMatchColumn,
    };
  }

  return null;
}

/** Builds `bind` PROTOCOL ops to run after staged `insertMany` batches in the same commit. */
export function buildRelationBindOps(
  profile: {
    readonly targetModel: string;
    readonly columnMapping: Readonly<Record<string, string>>;
    readonly relationBindings?: readonly RelationBindingRule[];
  },
  relations: readonly CatalogRelationRef[],
): EngineOperation[] {
  if (!profile.relationBindings?.length) {
    return [];
  }

  const ops: EngineOperation[] = [];
  const seen = new Set<string>();

  for (const rule of profile.relationBindings) {
    if (isBindOnlyRelationRule(rule, profile.columnMapping)) {
      continue;
    }
    const relation = relations.find((r) => r.forward === rule.relation);
    if (!relation) {
      continue;
    }

    const mappedImportField = profile.columnMapping[rule.sourceColumn] ?? rule.sourceColumn;
    const match = resolveProtocolBindMatch(rule, relation, profile.targetModel, mappedImportField);
    if (!match) {
      continue;
    }

    const dedupeKey = `${match.forward}\0${match.sourceField}\0${match.targetField}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);

    ops.push({
      op: 'bind',
      forward: match.forward,
      strategy: 'PROTOCOL',
      matchOn: {
        sourceField: match.sourceField,
        targetField: match.targetField,
      },
    });
  }

  return ops;
}

/** Suggests relation bindings from CSV columns + catalog topology (normalized field name match). */
export function suggestRelationBindings(
  ingestColumns: readonly IngestColumnSchema[],
  importModel: string,
  relations: readonly CatalogRelationRef[],
  models: readonly CatalogModelRef[],
): RelationBindingRule[] {
  const suggestions: RelationBindingRule[] = [];
  const modelFields = new Map(models.map((m) => [m.name, m.fields]));

  for (const relation of relationsForImportModel(importModel, relations)) {
    const peer = relatedModelForImport(relation, importModel);
    if (!peer) {
      continue;
    }
    const peerFields = modelFields.get(peer) ?? [];

    for (const col of ingestColumns) {
      for (const peerField of peerFields) {
        if (normalizeColumnKey(col.name) !== normalizeColumnKey(peerField)) {
          continue;
        }
        suggestions.push({
          relation: relation.forward,
          sourceColumn: col.name,
          targetModel: peer,
          targetMatchColumn: peerField,
        });
      }
    }
  }

  return dedupeRelationBindings(suggestions);
}

/** Merges manual rules over auto-suggestions (manual wins on same relation+sourceColumn). */
export function mergeRelationBindings(
  base: readonly RelationBindingRule[],
  overrides: readonly RelationBindingRule[],
): RelationBindingRule[] {
  const map = new Map<string, RelationBindingRule>();
  for (const rule of base) {
    map.set(relationBindingKey(rule), rule);
  }
  for (const rule of overrides) {
    map.set(relationBindingKey(rule), rule);
  }
  return [...map.values()];
}

function relationBindingKey(rule: RelationBindingRule): string {
  return `${rule.relation}\0${rule.sourceColumn}`;
}

function dedupeRelationBindings(rules: readonly RelationBindingRule[]): RelationBindingRule[] {
  const map = new Map<string, RelationBindingRule>();
  for (const rule of rules) {
    map.set(relationBindingKey(rule), rule);
  }
  return [...map.values()];
}
