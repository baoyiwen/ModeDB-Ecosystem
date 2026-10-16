import type { QueryInterfaceRelease } from '../query-designer/query-interface-publication.js';
import type { QueryFieldRef } from '../query-designer/types.js';
import type { EngineModelNode, EngineRelationEdge } from '../types/engine-schema.js';
import type { PropObject } from '../types/prop-object.js';
import { isInheritRelation } from '../config/graph-edge-kinds.js';
import { resolveI18nForLocale } from '../utils/i18n-resolve.js';
import type { PivotModelFieldPolicy } from './sources/model-source.js';
import type { PivotDocument, PivotPathSegment } from './types.js';

export type PivotLanguageMode = 'current' | 'raw' | 'all';
export const DEFAULT_PIVOT_VIEW = 'table' as const;
export const DEFAULT_PIVOT_LANGUAGE = 'current' as const;

export interface PivotLabel {
  readonly name: string;
  readonly i18n?: Record<string, string>;
}

export interface PivotTableColumn {
  readonly id: string;
  readonly outputName: string;
  readonly label: PivotLabel;
  readonly type?: string;
}

export interface PivotTableRelation {
  readonly id: string;
  readonly toNodeId: string;
  readonly path: readonly string[];
  readonly label: PivotLabel;
}

export interface PivotTableNode {
  readonly id: string;
  readonly modelId: string;
  readonly label: PivotLabel;
  readonly columns: readonly PivotTableColumn[];
  readonly relations: readonly PivotTableRelation[];
}

export interface PivotTableSchema {
  readonly rootNodeId: string;
  readonly nodes: Readonly<Record<string, PivotTableNode>>;
}

export interface PivotTableData {
  readonly id: string;
  readonly node: PivotTableNode;
  readonly relation?: PivotTableRelation;
  readonly rows: readonly {
    readonly id: string;
    readonly raw: Readonly<Record<string, unknown>>;
    readonly values: readonly unknown[];
    readonly children: readonly PivotTableData[];
  }[];
}

export function collectPivotExpandableRowIds(table: PivotTableData): readonly string[] {
  return table.rows.flatMap((row) =>
    row.children.length > 0 ? [row.id, ...row.children.flatMap(collectPivotExpandableRowIds)] : [],
  );
}

/** Headers, values, and empty cells must share one alignment per column. */
export function resolvePivotColumnAlignment(
  table: PivotTableData,
  columnIndex: number,
): 'left' | 'right' {
  const type = table.node.columns[columnIndex]?.type?.toLowerCase();
  if (type) return type === 'number' || type === 'int' ? 'right' : 'left';
  const values = table.rows
    .map((row) => row.values[columnIndex])
    .filter((value) => value !== null && value !== undefined);
  return values.length > 0 && values.every((value) => typeof value === 'number') ? 'right' : 'left';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fieldColumn(id: string, outputName: string, prop?: PropObject): PivotTableColumn {
  return {
    id,
    outputName,
    label: { name: prop?.name || outputName, i18n: prop?.name_i18n },
    type: prop?.type,
  };
}

function findProp(
  models: readonly EngineModelNode[],
  source?: QueryFieldRef,
): PropObject | undefined {
  return models
    .find((model) => model.id === source?.modelId)
    ?.props_objects_array.find((prop) => prop.id === source?.fieldId);
}

function relationLabel(
  relation: EngineRelationEdge | undefined,
  direction: 'forward' | 'reverse',
  fallback: string,
): PivotLabel {
  return direction === 'forward'
    ? { name: relation?.forward_name || fallback, i18n: relation?.forward_name_i18n }
    : { name: relation?.reverse_name || fallback, i18n: relation?.reverse_name_i18n };
}

/** The published adapter defines the actual output keys; the graph supplies node identity. */
export function buildInterfacePivotSchema(
  release: QueryInterfaceRelease,
  models: readonly EngineModelNode[],
  relations: readonly EngineRelationEdge[],
): PivotTableSchema {
  const asset = release.queryInterface;
  const adapter = release.executionTemplate.resultAdapter;
  if (adapter.kind === 'aggregation') {
    const columns = [...adapter.dimensions, ...adapter.metrics].map((field, index) => {
      const resultField = asset.query.result.schema.find(
        (entry) => entry.name === field.outputName,
      );
      const column = fieldColumn(
        String(index),
        field.outputName,
        findProp(models, resultField?.source),
      );
      // Metric names describe calculations, not just the underlying source property.
      return adapter.metrics.some((metric) => metric.outputName === field.outputName)
        ? { ...column, label: { name: field.outputName } }
        : column;
    });
    return {
      rootNodeId: asset.query.rootNodeId,
      nodes: {
        [asset.query.rootNodeId]: {
          id: asset.query.rootNodeId,
          modelId: '',
          label: { name: asset.displayName || asset.name },
          columns,
          relations: [],
        },
      },
    };
  }
  const nodes: Record<string, PivotTableNode> = {};
  for (const node of asset.designGraph.nodes) {
    const model = models.find((item) => item.id === node.modelId);
    nodes[node.id] = {
      id: node.id,
      modelId: node.modelId,
      label: { name: model?.model_name || node.alias, i18n: model?.name_i18n },
      columns: (adapter.fieldsByNode[node.id] ?? []).map((field, index) => {
        const projection = asset.query.projection.fields.find(
          (entry) =>
            entry.visible &&
            entry.source.nodeId === node.id &&
            entry.outputName === field.outputName,
        );
        const prop =
          findProp(models, projection?.source) ??
          model?.props_objects_array.find((entry) => entry.name === field.sourceField);
        return fieldColumn(projection?.id || `${node.id}:${index}`, field.outputName, prop);
      }),
      relations: (adapter.edgesBySource[node.id] ?? []).map((edge, index) => {
        const graphEdge = asset.designGraph.edges.find(
          (entry) =>
            entry.fromNodeId === node.id &&
            entry.toNodeId === edge.toNodeId &&
            entry.alias === edge.relationName,
        );
        const relation = relations.find((entry) => entry.id === graphEdge?.relationId);
        return {
          id: graphEdge?.id || `${node.id}:${index}`,
          toNodeId: edge.toNodeId,
          path: [edge.outputName],
          label: relationLabel(relation, graphEdge?.traversal ?? 'forward', edge.outputName),
        };
      }),
    };
  }
  return { rootNodeId: adapter.rootNodeId, nodes };
}

/** Model browsing uses directional relation keys, independently at every model level. */
export function buildModelPivotSchema(
  modelId: string,
  models: readonly EngineModelNode[],
  relations: readonly EngineRelationEdge[],
): PivotTableSchema {
  const nodes: Record<string, PivotTableNode> = {};
  for (const model of models) {
    const edges: PivotTableRelation[] = [];
    for (const relation of relations) {
      if (isInheritRelation(relation.kind)) continue;
      for (const direction of ['forward', 'reverse'] as const) {
        const fromId =
          direction === 'forward' ? relation.source_model_id : relation.target_model_id;
        const toId = direction === 'forward' ? relation.target_model_id : relation.source_model_id;
        if (fromId !== model.id || !models.some((item) => item.id === toId)) continue;
        const names =
          direction === 'forward'
            ? [relation.engine_forward_name, relation.forward_name]
            : [relation.engine_reverse_name, relation.reverse_name];
        for (const name of new Set(names.filter((entry): entry is string => Boolean(entry)))) {
          edges.push({
            id: `${relation.id}:${direction}:${name}`,
            toNodeId: toId,
            path: ['relates', name],
            label: relationLabel(relation, direction, name),
          });
        }
      }
    }
    nodes[model.id] = {
      id: model.id,
      modelId: model.id,
      label: { name: model.model_name, i18n: model.name_i18n },
      columns: [...model.props_objects_array]
        .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
        .filter((prop) => Boolean(prop.name))
        .map((prop) => fieldColumn(prop.id, prop.name, prop)),
      relations: edges,
    };
  }
  return { rootNodeId: modelId, nodes };
}

export function buildPivotModelFieldPolicy(
  schema: PivotTableSchema,
): PivotModelFieldPolicy | undefined {
  const policies: Record<
    string,
    { fields: string[]; relatedPolicies: Record<string, PivotModelFieldPolicy> }
  > = {};
  for (const node of Object.values(schema.nodes)) {
    policies[node.id] = {
      fields: node.columns.map((column) => column.outputName),
      relatedPolicies: {},
    };
  }
  for (const node of Object.values(schema.nodes)) {
    for (const edge of node.relations) {
      const child = policies[edge.toNodeId];
      const key = edge.path[edge.path.length - 1];
      if (child && key) policies[node.id]!.relatedPolicies[key] = child;
    }
  }
  return policies[schema.rootNodeId];
}

function readPath(row: Readonly<Record<string, unknown>>, path: readonly string[]): unknown {
  let value: unknown = row;
  for (const key of path) value = isRecord(value) ? value[key] : undefined;
  return value;
}

/** Build composite tables without flattening relations, i18n maps, or JSON properties. */
export function buildPivotTable(
  document: PivotDocument,
  schema: PivotTableSchema,
): PivotTableData | undefined {
  const visit = (
    nodeId: string,
    rows: readonly Readonly<Record<string, unknown>>[],
    id: string,
    ancestors: ReadonlySet<unknown>,
    depth: number,
    relation?: PivotTableRelation,
  ): PivotTableData | undefined => {
    const node = schema.nodes[nodeId];
    if (!node) return undefined;
    return {
      id,
      node,
      relation,
      rows: rows.map((raw, index) => {
        const rowId = `${id}/row:${index}`;
        const path = new Set(ancestors);
        path.add(raw);
        const children: PivotTableData[] = [];
        if (depth < 64 && !ancestors.has(raw)) {
          for (const edge of node.relations) {
            const value = readPath(raw, edge.path);
            if (value === undefined) continue;
            const records = Array.isArray(value)
              ? value.filter(isRecord)
              : isRecord(value)
                ? [value]
                : [];
            const child = visit(
              edge.toNodeId,
              records,
              `${rowId}/${edge.id}`,
              path,
              depth + 1,
              edge,
            );
            if (child) children.push(child);
          }
        }
        return {
          id: rowId,
          raw,
          values: node.columns.map((column) => raw[column.outputName]),
          children,
        };
      }),
    };
  };
  return visit(schema.rootNodeId, document.rawRows, 'root', new Set(), 0);
}

export function resolvePivotLabel(label: PivotLabel, locale: string): string {
  return resolveI18nForLocale(label.i18n, locale, label.name);
}

/** Resolve field/relationship labels by query path, never by global property-name matching. */
export function resolvePivotPathLabel(
  schema: PivotTableSchema,
  path: readonly PivotPathSegment[],
  locale: string,
): string {
  let node = schema.nodes[schema.rootNodeId];
  const keys = path.filter((part) => part.kind === 'field').map((part) => part.key);
  if (keys.length === 0) return node ? resolvePivotLabel(node.label, locale) : '';
  for (let index = 0; index < keys.length && node; index++) {
    const edge = node.relations.find((item) =>
      item.path.every((key, offset) => key === keys[index + offset]),
    );
    if (edge) {
      index += edge.path.length - 1;
      if (index === keys.length - 1) return resolvePivotLabel(edge.label, locale);
      node = schema.nodes[edge.toNodeId];
      continue;
    }
    const column = node.columns.find((item) => item.outputName === keys[index]);
    if (column && index === keys.length - 1) return resolvePivotLabel(column.label, locale);
  }
  return path[path.length - 1]?.key ?? '';
}

export function isPivotI18nValue(value: unknown, type?: string): value is Record<string, string> {
  if (!isRecord(value) || !Object.values(value).every((entry) => typeof entry === 'string'))
    return false;
  if (type) return type.toUpperCase() === 'I18N';
  const keys = Object.keys(value);
  return (
    keys.length > 0 &&
    keys.some((key) => /^(zh|en|ja)(-|$)/i.test(key)) &&
    keys.every((key) => /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(key))
  );
}

export function formatPivotValue(
  value: unknown,
  locale: string,
  mode: PivotLanguageMode,
  type?: string,
): string {
  if (mode === 'current' && isPivotI18nValue(value, type)) {
    const baseLocale = locale.split('-')[0]!.toLowerCase();
    const languageKey = Object.keys(value).find(
      (key) => key.split('-')[0]!.toLowerCase() === baseLocale,
    );
    const matching =
      value[locale] || value[baseLocale] || (languageKey ? value[languageKey] : undefined);
    return matching?.trim() || resolveI18nForLocale(value, locale, Object.values(value)[0] ?? '');
  }
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value !== 'object') return String(value);
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
