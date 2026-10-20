import type { TransferModel } from '@mode-db/data-kit';
import type { QueryInterfaceRelease } from '../query-designer/query-interface-publication.js';
import type { EngineModelNode, EngineRelationEdge } from '../types/engine-schema.js';
import { buildModelMap } from '../model-map/model-map.js';
import { resolveRelationForwardLabel, resolveRelationReverseLabel } from '../utils/i18n-resolve.js';
import { formatDateTimeForDisplay } from './date-time.js';

export interface PivotDisplayField {
  readonly key: string;
  readonly label: string;
  readonly type: string;
}
export interface PivotDisplayNode {
  readonly label: string;
  readonly fields: readonly PivotDisplayField[];
  readonly children: readonly { key: string; label: string; node: PivotDisplayNode }[];
}

/** Resolve each query occurrence independently, including aliases and self joins. */
export function buildPivotDisplay(input: {
  models: readonly EngineModelNode[];
  relations: readonly EngineRelationEdge[];
  schema: readonly TransferModel[];
  locale: string;
  modelId?: string;
  release?: QueryInterfaceRelease;
  aggregateLabels?: Readonly<Record<string, string>>;
}): PivotDisplayNode {
  const entries = buildModelMap(input.models, input.locale);
  const entryFor = (id: string) =>
    entries.find((item) => item.model.id === id || item.model.model_name === id);
  const fieldFor = (modelId: string, name: string, key = name): PivotDisplayField => {
    const entry = entryFor(modelId);
    const prop = entry?.fields.find((item) => item.prop.name === name || item.prop.id === name);
    const live = input.schema
      .find((item) => item.name === entry?.model.model_name)
      ?.fields.find((item) => item.name === (prop?.prop.name ?? name));
    return {
      key,
      label: live?.label ?? prop?.label ?? name,
      type: live?.type ?? prop?.prop.type ?? 'String',
    };
  };
  const release = input.release;
  if (release) {
    const adapter = release.executionTemplate.resultAdapter;
    const graph = release.queryInterface.designGraph;
    if (adapter.kind === 'aggregation')
      return {
        label: release.queryInterface.displayName || release.callableName,
        fields: [
          ...adapter.dimensions.map((field) => {
            const group = release.queryInterface.query.aggregation?.groupBy.find(
              (item) => item.outputName === field.outputName,
            );
            return group
              ? fieldFor(group.source.modelId, group.source.fieldId, field.outputName)
              : { key: field.outputName, label: field.outputName, type: 'String' };
          }),
          ...adapter.metrics.map((field) => {
            const metric = release.queryInterface.query.aggregation?.metrics.find(
              (item) => item.outputName === field.outputName,
            );
            if (!metric) return { key: field.outputName, label: field.outputName, type: 'Number' };
            const source = fieldFor(metric.source.modelId, metric.source.fieldId, field.outputName);
            return {
              ...source,
              type: ['min', 'max'].includes(metric.function) ? source.type : 'Number',
              label: `${source.label} · ${input.aggregateLabels?.[metric.function] ?? metric.function}${metric.distinct ? ` (${input.aggregateLabels?.distinct ?? 'distinct'})` : ''}`,
            };
          }),
        ],
        children: [],
      };
    const visit = (nodeId: string, depth: number): PivotDisplayNode => {
      const node = graph.nodes.find((item) => item.id === nodeId);
      const entry = entryFor(node?.modelId ?? '');
      return {
        label: entry?.label ?? node?.alias ?? nodeId,
        fields: (adapter.fieldsByNode[nodeId] ?? []).map((field) =>
          fieldFor(node?.modelId ?? '', field.sourceField, field.outputName),
        ),
        children:
          depth > 64
            ? []
            : (adapter.edgesBySource[nodeId] ?? []).map((edge) => {
                const designed = graph.edges.find(
                  (item) =>
                    item.fromNodeId === nodeId &&
                    item.toNodeId === edge.toNodeId &&
                    item.alias === edge.outputName,
                );
                const relation = input.relations.find((item) => item.id === designed?.relationId);
                const label = relation
                  ? designed?.traversal === 'reverse'
                    ? resolveRelationReverseLabel(relation, input.locale)
                    : resolveRelationForwardLabel(relation, input.locale)
                  : edge.outputName;
                return { key: edge.outputName, label, node: visit(edge.toNodeId, depth + 1) };
              }),
      };
    };
    return visit(adapter.rootNodeId, 0);
  }
  const visitModel = (id: string, depth: number): PivotDisplayNode => {
    const entry = entryFor(id);
    return {
      label: entry?.label ?? id,
      fields: (entry?.fields ?? [])
        .filter((field) => !field.prop.name.startsWith('_'))
        .map((field) => fieldFor(id, field.prop.name)),
      children:
        depth > 0
          ? []
          : input.relations
              .filter(
                (relation) =>
                  relation.kind !== 'modelInherits' &&
                  (relation.source_model_id === id || relation.target_model_id === id),
              )
              .flatMap((relation) => {
                const directions = [
                  ...(relation.source_model_id === id ? [false] : []),
                  ...(relation.target_model_id === id ? [true] : []),
                ];
                return directions.map((reverse) => ({
                  key: `relates.${reverse ? relation.engine_reverse_name || relation.reverse_name : relation.engine_forward_name || relation.forward_name}`,
                  label: reverse
                    ? resolveRelationReverseLabel(relation, input.locale)
                    : resolveRelationForwardLabel(relation, input.locale),
                  node: visitModel(
                    reverse ? relation.source_model_id : relation.target_model_id,
                    depth + 1,
                  ),
                }));
              }),
    };
  };
  return visitModel(input.modelId ?? '', 0);
}

/** Display only. Convert transport instants to local fields without mutating raw values. */
export function readableDate(value: unknown): string | undefined {
  return formatDateTimeForDisplay(value);
}

export function displayPivotValue(
  value: unknown,
  type: string,
  locale: string,
  mode: 'current' | 'raw' | 'all',
): string {
  if (value === undefined || value === null) return '—';
  if (mode !== 'raw') {
    if (type === 'DateTime') return readableDate(value) ?? String(value);
    if (
      mode === 'current' &&
      type === 'I18N' &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      const values = value as Record<string, unknown>;
      const selected = values[locale] ?? values[locale.split('-')[0]!] ?? Object.values(values)[0];
      return typeof selected === 'string' ? selected : JSON.stringify(value);
    }
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
