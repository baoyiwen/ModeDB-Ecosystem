import {
  TRANSFER_FORMAT,
  TRANSFER_MAX_ROWS,
  TRANSFER_MAX_EDGES,
  TransferError,
  transferRecordKey,
  transferRelationKey,
  type TransferPackage,
  type TransferModel,
  type TransferRelation,
  type TransferIssue,
} from '@mode-db/data-kit';
import type { QueryInterfaceRelease } from '../query-designer/query-interface-publication.js';
import type { EngineModelNode, EngineRelationEdge } from '../types/engine-schema.js';
import type { PivotDocument } from '../pivot/types.js';
import { buildModelMap } from '../model-map/model-map.js';
import { normalizeLegacyPropType } from '../config/engine-prop-types.js';
import { transferSheetName } from './sheet-name.js';
import { buildPivotDisplay } from '../pivot/display.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function interfaceResultHasRecordRefs(
  release: QueryInterfaceRelease,
  document: PivotDocument,
): boolean {
  const adapter = release.executionTemplate.resultAdapter;
  if (adapter.kind !== 'rows' || !release.queryInterface.query.result.includesRecordRefs)
    return false;
  const visit = (value: unknown, nodeId: string, depth: number): boolean => {
    if (!record(value) || depth > 64) return false;
    const ref = value.$recordRef;
    if (!record(ref) || ref.nodeId !== nodeId || typeof ref.id !== 'string' || !ref.id)
      return false;
    return (adapter.edgesBySource[nodeId] ?? []).every((edge) => {
      const children = value[edge.outputName];
      return (
        children === undefined ||
        children === null ||
        (Array.isArray(children) &&
          children.every((child) => visit(child, edge.toNodeId, depth + 1)))
      );
    });
  };
  return document.rawRows.every((row) => visit(row, adapter.rootNodeId, 0));
}

/** The published projection is the sole field source; no database queries are made here. */
export function buildInterfaceTransfer(input: {
  readonly database: string;
  readonly release: QueryInterfaceRelease;
  readonly models: readonly EngineModelNode[];
  readonly relations: readonly EngineRelationEdge[];
  readonly schema?: readonly TransferModel[];
  readonly locale: string;
  readonly document?: PivotDocument;
  readonly template?: boolean;
  readonly aggregateLabels?: Readonly<Record<string, string>>;
}): TransferPackage {
  const { release } = input;
  const adapter = release.executionTemplate.resultAdapter;
  const source = {
    callableName: release.callableName,
    version: release.version,
    signature: release.signature,
    scope: 'returned-result' as const,
  };
  const base = {
    format: TRANSFER_FORMAT,
    database: input.database,
    createdAt: new Date().toISOString(),
    interfaceSource: source,
  };
  if (adapter.kind === 'aggregation') {
    if (input.template) throw new TransferError('reportOnly');
    const names = [...adapter.dimensions, ...adapter.metrics].map((field) => field.outputName);
    const model: TransferModel = {
      name: 'Result',
      label: release.queryInterface.displayName || release.callableName,
      sheet: 'Result',
      fields: buildPivotDisplay({ ...input, schema: input.schema ?? [] }).fields.map((field) => ({
        name: field.key,
        label: field.label,
        type: field.type,
      })),
    };
    const raw = input.document?.rawRows ?? [];
    if (raw.length > TRANSFER_MAX_ROWS) throw new TransferError('limit');
    return {
      manifest: { ...base, kind: 'report', models: [model], relations: [] },
      rows: raw.map((value, index) => ({
        model: model.name,
        sheet: model.sheet,
        row: index + 3,
        key: `r${index + 1}`,
        values: Object.fromEntries(
          names.filter((name) => Object.hasOwn(value, name)).map((name) => [name, value[name]]),
        ),
      })),
      edges: [],
      paths: [],
    };
  }
  const entries = buildModelMap(input.models, input.locale);
  const used = new Set(['history', '_modedb', '_relations', '_paths']);
  const models = new Map<string, TransferModel>();
  const nodeModels = new Map<string, TransferModel>();
  for (const node of release.queryInterface.designGraph.nodes) {
    if (
      !Object.hasOwn(adapter.fieldsByNode, node.id) &&
      node.id !== adapter.rootNodeId &&
      !Object.values(adapter.edgesBySource).some((edges) =>
        edges.some((edge) => edge.toNodeId === node.id),
      )
    )
      continue;
    const entry = entries.find(
      (item) => item.model.id === node.modelId || item.model.model_name === node.modelId,
    );
    if (!entry || entry.inheritanceIssue) throw new TransferError('model', undefined, node.modelId);
    const live = input.schema?.find((model) => model.name === entry.model.model_name);
    if (input.schema && !live) throw new TransferError('model', undefined, entry.model.model_name);
    const current = models.get(entry.model.model_name);
    const fields = [...(current?.fields ?? [])];
    for (const field of adapter.fieldsByNode[node.id] ?? []) {
      const prop = entry.fields.find((item) => item.prop.name === field.sourceField);
      const liveField = live?.fields.find((item) => item.name === field.sourceField);
      if (!prop || field.sourceField.startsWith('_'))
        throw new TransferError('field', undefined, field.sourceField);
      if (live && !liveField) throw new TransferError('field', undefined, field.sourceField);
      if (!fields.some((item) => item.name === field.sourceField))
        fields.push({
          name: field.sourceField,
          label: liveField?.label ?? prop.label,
          type: liveField?.type ?? normalizeLegacyPropType(prop.prop.type),
          required: Boolean(liveField?.required ?? prop.prop.is_required),
        });
    }
    const model = {
      name: entry.model.model_name,
      label: entry.label,
      sheet: current?.sheet ?? transferSheetName(entry.model.model_name, used),
      fields,
    };
    models.set(model.name, model);
    nodeModels.set(node.id, model);
  }
  const relations = new Map<string, TransferRelation>();
  const edgeDefinitions = new Map<string, { relation: TransferRelation; reverse: boolean }>();
  for (const [from, edges] of Object.entries(adapter.edgesBySource))
    for (const edge of edges) {
      const designed = release.queryInterface.designGraph.edges.find(
        (item) =>
          item.fromNodeId === from &&
          item.toNodeId === edge.toNodeId &&
          item.alias === edge.outputName,
      );
      const relation = input.relations.find((item) => item.id === designed?.relationId);
      if (!designed || !relation) throw new TransferError('relation', undefined, edge.outputName);
      const sourceModel = input.models.find((item) => item.id === relation.source_model_id);
      const targetModel = input.models.find((item) => item.id === relation.target_model_id);
      if (!sourceModel || !targetModel) throw new TransferError('relation');
      const definition: TransferRelation = {
        source: sourceModel.model_name,
        target: targetModel.model_name,
        forward: relation.engine_forward_name || relation.forward_name || '',
        reverse: relation.engine_reverse_name || relation.reverse_name || '',
        selfLoopPolicy: relation.self_loop_policy === 'allow' ? 'allow' : 'deny',
      };
      const reverse = designed.traversal === 'reverse';
      if (
        nodeModels.get(from)?.name !== (reverse ? definition.target : definition.source) ||
        nodeModels.get(edge.toNodeId)?.name !== (reverse ? definition.source : definition.target)
      )
        throw new TransferError('inheritedRelation');
      relations.set(transferRelationKey(definition), definition);
      edgeDefinitions.set(JSON.stringify([from, edge.outputName]), {
        relation: definition,
        reverse,
      });
    }
  const rows: TransferPackage['rows'][number][] = [];
  const paths: NonNullable<TransferPackage['paths']>[number][] = [];
  const edges: TransferPackage['edges'][number][] = [];
  const identities = new Map<string, (typeof rows)[number]>();
  const edgeKeys = new Set<string>();
  const counts = new Map<string, number>();
  let report = !release.queryInterface.query.result.includesRecordRefs;
  const visit = (
    value: unknown,
    nodeId: string,
    path: (string | number)[],
    parentPath: string,
  ): (typeof rows)[number] => {
    if (!record(value) || path.length > 129) throw new TransferError('result');
    const model = nodeModels.get(nodeId);
    if (!model) throw new TransferError('model');
    const ref = value.$recordRef;
    const id =
      record(ref) &&
      ref.nodeId === nodeId &&
      ref.model === model.name &&
      typeof ref.id === 'string' &&
      ref.id
        ? ref.id
        : undefined;
    if (!id) report = true;
    const pathText = JSON.stringify(path);
    const identity = transferRecordKey(model.name, id ?? pathText);
    const values = Object.fromEntries(
      (adapter.fieldsByNode[nodeId] ?? [])
        .filter((field) => Object.hasOwn(value, field.outputName))
        .map((field) => [field.sourceField, value[field.outputName]]),
    );
    let row = identities.get(identity);
    if (row) {
      for (const [field, next] of Object.entries(values))
        if (
          Object.hasOwn(row.values, field) &&
          JSON.stringify(row.values[field]) !== JSON.stringify(next)
        )
          throw new TransferError('interfaceConflict', {
            sheet: model.sheet,
            row: row.row,
            column: field,
          });
      Object.assign(row.values, values);
    } else {
      const index = counts.get(model.name) ?? 0;
      counts.set(model.name, index + 1);
      row = {
        model: model.name,
        sheet: model.sheet,
        row: index + 3,
        key: `r${index + 1}`,
        ...(id ? { id } : {}),
        values,
      };
      identities.set(identity, row);
      rows.push(row);
      if (rows.length > TRANSFER_MAX_ROWS) throw new TransferError('limit');
    }
    paths.push({ path: pathText, parentPath, nodeId, model: model.name, key: row.key });
    if (paths.length > 100_000) throw new TransferError('limit');
    for (const edge of adapter.edgesBySource[nodeId] ?? []) {
      const children = value[edge.outputName];
      if (children === null || children === undefined) continue;
      if (!Array.isArray(children)) throw new TransferError('result');
      const definition = edgeDefinitions.get(JSON.stringify([nodeId, edge.outputName]));
      if (!definition) throw new TransferError('relation');
      children.forEach((child, index) => {
        const target = visit(child, edge.toNodeId, [...path, edge.outputName, index], pathText);
        const refOf = (item: typeof row): string => (item.id ? `id:${item.id}` : `row:${item.key}`);
        const sourceRef = refOf(definition.reverse ? target : row!);
        const targetRef = refOf(definition.reverse ? row! : target);
        const key = JSON.stringify([
          transferRelationKey(definition.relation),
          sourceRef,
          targetRef,
        ]);
        if (!edgeKeys.has(key)) {
          edgeKeys.add(key);
          edges.push({
            ...definition.relation,
            sourceRef,
            targetRef,
            sheet: '_relations',
            row: edges.length + 3,
          });
          if (edges.length > TRANSFER_MAX_EDGES) throw new TransferError('limit');
        }
      });
    }
    return row;
  };
  if (!input.template)
    input.document?.rawRows.forEach((row, index) => visit(row, adapter.rootNodeId, [index], ''));
  return {
    manifest: {
      ...base,
      kind: input.template ? 'template' : report ? 'report' : 'data',
      models: [...models.values()],
      relations: [...relations.values()],
    },
    rows,
    edges,
    paths,
  };
}

/** File metadata never widens the fields or relationships allowed by this release. */
export function interfaceTransferIssues(
  data: TransferPackage,
  allowed: TransferPackage,
  release: QueryInterfaceRelease,
  models: readonly EngineModelNode[],
): TransferIssue[] {
  const issues: TransferIssue[] = [];
  const source = data.manifest.interfaceSource;
  if (
    !source ||
    source.callableName !== release.callableName ||
    source.version !== release.version ||
    source.signature !== release.signature ||
    source.scope !== 'returned-result'
  )
    issues.push({ code: 'interfaceSource', sheet: '_modedb', row: 2 });
  for (const model of data.manifest.models) {
    const current = allowed.manifest.models.find((item) => item.name === model.name);
    if (!current) issues.push({ code: 'model', sheet: model.sheet, row: 1 });
    for (const field of model.fields)
      if (!current?.fields.some((item) => item.name === field.name))
        issues.push({ code: 'field', sheet: model.sheet, row: 2, column: field.name });
  }
  const relations = new Set(allowed.manifest.relations.map(transferRelationKey));
  for (const edge of data.edges)
    if (!relations.has(transferRelationKey(edge))) issues.push({ code: 'relation', ...edge });
  const adapter = release.executionTemplate.resultAdapter;
  if (adapter.kind !== 'rows') return [...issues, { code: 'reportOnly', sheet: '_modedb', row: 2 }];
  const locations = new Map<string, NonNullable<TransferPackage['paths']>[number]>();
  const allPaths = new Set((data.paths ?? []).map((item) => item.path));
  const rowIndex = new Map(data.rows.map((row) => [transferRecordKey(row.model, row.key), row]));
  const represented = new Set<string>();
  for (const [index, path] of (data.paths ?? []).entries()) {
    let valid = !locations.has(path.path);
    let segments: unknown;
    try {
      segments = JSON.parse(path.path);
    } catch {
      valid = false;
    }
    let nodeId = adapter.rootNodeId;
    if (
      !Array.isArray(segments) ||
      !segments.length ||
      segments.length % 2 !== 1 ||
      !Number.isSafeInteger(segments[0]) ||
      segments[0] < 0
    )
      valid = false;
    else {
      for (let step = 1; step < segments.length; step += 2) {
        const edge = adapter.edgesBySource[nodeId]?.find(
          (item) => item.outputName === segments[step],
        );
        if (!edge || !Number.isSafeInteger(segments[step + 1]) || segments[step + 1] < 0) {
          valid = false;
          break;
        }
        nodeId = edge.toNodeId;
      }
      if (path.parentPath !== (segments.length > 1 ? JSON.stringify(segments.slice(0, -2)) : ''))
        valid = false;
    }
    const node = release.queryInterface.designGraph.nodes.find((item) => item.id === nodeId);
    const row = rowIndex.get(transferRecordKey(path.model, path.key));
    const expectedModel = models.find(
      (model) => model.id === node?.modelId || model.model_name === node?.modelId,
    );
    if (
      path.nodeId !== nodeId ||
      !expectedModel ||
      path.model !== expectedModel.model_name ||
      !row ||
      !allowed.manifest.models.some((item) => item.name === path.model)
    )
      valid = false;
    // Parent paths must be real occurrences, even if a workbook reordered the path rows.
    if (path.parentPath && !allPaths.has(path.parentPath)) valid = false;
    if (!valid) issues.push({ code: 'interfacePath', sheet: '_paths', row: index + 3 });
    locations.set(path.path, path);
    represented.add(transferRecordKey(path.model, path.key));
  }
  if (data.manifest.kind === 'data')
    for (const row of data.rows)
      if (!represented.has(transferRecordKey(row.model, row.key)))
        issues.push({ code: 'interfacePath', sheet: row.sheet, row: row.row });
  return issues;
}
