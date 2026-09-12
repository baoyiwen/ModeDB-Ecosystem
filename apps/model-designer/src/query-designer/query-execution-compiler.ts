import {
  WireQueryChain,
  isQueryParameterPlaceholder,
  queryParameterPlaceholder,
  type AggregateOp,
  type AggregateInputEntry,
  type PredicateNode,
  type QueryExecuteOptions,
  type QueryOrderEntry,
  type RemoteModelDBClient,
  type RemoteExecuteSnapshot,
  type PublishedQueryExecutionTemplate,
} from '@mode-db/sdk';
import type { EngineModelNode, EngineRelationEdge } from '../types/engine-schema.js';
import {
  isQueryFilterGroup,
  isQueryRelationFilter,
  queryFilterExpressionCount,
  queryRelationFilterCount,
} from './query-filter-tree.js';
import type {
  DesignEdge,
  InterfaceParameter,
  QueryAggregateMetric,
  QueryFilter,
  QueryFilterExpression,
  QueryFilterGroup,
  QueryInterface,
} from './types.js';

export interface QueryExecutionDiagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  path?: string;
}

export interface QueryExecutionStage {
  id: 'scope' | 'filter' | 'traversal' | 'aggregation' | 'result';
  label: string;
  summary: string;
  status: 'ready' | 'inactive' | 'blocked';
}

interface CompiledEdge {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  relationName: string;
  kind: 'primary' | 'branch';
  targetPredicate: PredicateNode;
}

interface ProjectionFieldProgram {
  sourceField: string;
  outputName: string;
}

interface ProjectionProgram {
  fieldsByNode: Record<string, ProjectionFieldProgram[]>;
  edgesBySource: Record<string, CompiledEdge[]>;
}

interface AggregationProgram {
  groupBy: string[];
  compute: Record<string, AggregateInputEntry>;
  aliases: Array<{ metricId: string; wireKey: string; outputName: string }>;
  dimensions: Array<{ sourceField: string; outputName: string }>;
  having?: PredicateNode;
}

export interface QueryExecutionProgram {
  originModel: string;
  rootNodeId: string;
  primaryPath: string[];
  primaryEdges: CompiledEdge[];
  branchEdges: CompiledEdge[];
  nodePredicates: Record<string, PredicateNode>;
  projection?: ProjectionProgram;
  aggregation?: AggregationProgram;
  orderBy: QueryOrderEntry[];
  executeOptions: QueryExecuteOptions;
}

export interface QueryExecutionPlan {
  interfaceId: string;
  ready: boolean;
  program?: QueryExecutionProgram;
  snapshot?: RemoteExecuteSnapshot;
  stages: QueryExecutionStage[];
  diagnostics: QueryExecutionDiagnostic[];
}

export interface QueryPreviewResult {
  rows: Record<string, unknown>[];
  total?: number;
  page?: number;
  pageCount?: number;
  nextCursor?: string;
  rawKind: string;
}

export interface PublishedQueryTemplateCompilation {
  template?: PublishedQueryExecutionTemplate;
  diagnostics: QueryExecutionDiagnostic[];
}

export function compilePublishedQueryExecutionTemplate(input: {
  queryInterface: QueryInterface;
  models: readonly EngineModelNode[];
  relations: readonly EngineRelationEdge[];
}): PublishedQueryTemplateCompilation {
  const pagination = input.queryInterface.query.pagination ?? { mode: 'none' as const };
  const plan = compileQueryExecutionPlan({
    ...input,
    parameterMode: 'placeholders',
    previewLimit: pagination.defaultLimit ?? 20,
  });
  if (!plan.ready || !plan.snapshot || !plan.program) {
    return { diagnostics: plan.diagnostics };
  }
  const execute = { ...plan.snapshot.execute } as Record<string, unknown>;
  if (pagination.mode === 'none') {
    delete execute.limit;
    delete execute.page;
    delete execute.cursor;
  }
  const resultAdapter: PublishedQueryExecutionTemplate['resultAdapter'] = plan.program.aggregation
    ? {
        kind: 'aggregation',
        dimensions: plan.program.aggregation.dimensions.map((entry) => ({ ...entry })),
        metrics: plan.program.aggregation.aliases.map((entry) => ({
          wireKey: entry.wireKey,
          outputName: entry.outputName,
        })),
      }
    : {
        kind: 'rows',
        rootNodeId: plan.program.rootNodeId,
        fieldsByNode: Object.fromEntries(
          Object.entries(plan.program.projection?.fieldsByNode ?? {}).map(([nodeId, fields]) => [
            nodeId,
            fields.map((field) => ({ ...field })),
          ]),
        ),
        edgesBySource: Object.fromEntries(
          Object.entries(plan.program.projection?.edgesBySource ?? {}).map(([nodeId, edges]) => [
            nodeId,
            edges.map((edge) => ({
              toNodeId: edge.toNodeId,
              relationName: edge.relationName,
              outputName: edge.relationName,
            })),
          ]),
        ),
      };
  return {
    diagnostics: plan.diagnostics,
    template: {
      format: 1,
      snapshot: {
        ...plan.snapshot,
        execute: execute as unknown as RemoteExecuteSnapshot['execute'],
      },
      parameters: input.queryInterface.contract.parameters.map((parameter) => ({
        id: parameter.id,
        name: parameter.name,
        type: parameter.type,
        required: parameter.required,
        ...(parameter.defaultValue !== undefined ? { defaultValue: parameter.defaultValue } : {}),
      })),
      resultAdapter,
      pagination: {
        mode: pagination.mode,
        ...(pagination.defaultLimit !== undefined ? { defaultLimit: pagination.defaultLimit } : {}),
        ...(pagination.maxLimit !== undefined ? { maxLimit: pagination.maxLimit } : {}),
      },
    },
  };
}

export function compileQueryExecutionPlan(input: {
  queryInterface: QueryInterface;
  models: readonly EngineModelNode[];
  relations: readonly EngineRelationEdge[];
  parameterValues?: Readonly<Record<string, unknown>>;
  previewLimit?: number;
  parameterMode?: 'values' | 'placeholders';
}): QueryExecutionPlan {
  const { queryInterface, models } = input;
  const diagnostics: QueryExecutionDiagnostic[] = [];
  const seenDiagnostics = new Set<string>();
  const addDiagnostic = (diagnostic: QueryExecutionDiagnostic): void => {
    const key = `${diagnostic.code}:${diagnostic.path ?? ''}`;
    if (!seenDiagnostics.has(key)) {
      seenDiagnostics.add(key);
      diagnostics.push(diagnostic);
    }
  };
  const nodesById = new Map(queryInterface.designGraph.nodes.map((node) => [node.id, node]));
  const edgesById = new Map(queryInterface.designGraph.edges.map((edge) => [edge.id, edge]));
  const modelsById = new Map(models.map((model) => [model.id, model]));
  const rootNode = nodesById.get(queryInterface.designGraph.rootNodeId);
  const rootModel = rootNode ? modelsById.get(rootNode.modelId) : undefined;
  if (!rootNode || !rootModel?.model_name) {
    addDiagnostic({
      severity: 'error',
      code: 'execution_root_model_missing',
      message: 'The execution root model is not available in the current catalog.',
      path: 'designGraph.rootNodeId',
    });
  }

  const enabledFilterTree = queryInterface.query.filterTree;
  if (enabledFilterTree) {
    analyzeFilterTree(enabledFilterTree, addDiagnostic);
  }
  const parameterValues = input.parameterValues ?? {};
  const parameterMode = input.parameterMode ?? 'values';
  const parametersById = new Map(
    queryInterface.contract.parameters.map((parameter) => [parameter.id, parameter]),
  );
  for (const parameter of queryInterface.contract.parameters) {
    const supplied = parameterValues[parameter.id];
    const raw = supplied === undefined || supplied === '' ? parameter.defaultValue : supplied;
    if (parameterMode === 'values' && parameter.required && (raw === undefined || raw === '')) {
      addDiagnostic({
        severity: 'error',
        code: 'execution_parameter_value_missing',
        message: `Parameter "${parameter.name}" needs a preview value.`,
        path: `contract.parameters.${parameter.id}`,
      });
      continue;
    }
    if (parameterMode === 'values' && raw !== undefined && raw !== '') {
      try {
        coerceParameterValue(parameter, raw);
      } catch (error) {
        addDiagnostic({
          severity: 'error',
          code: 'execution_parameter_value_invalid',
          message: error instanceof Error ? error.message : String(error),
          path: `contract.parameters.${parameter.id}`,
        });
      }
    }
  }
  const nodePredicates: Record<string, PredicateNode> = {};
  for (const node of queryInterface.designGraph.nodes) {
    nodePredicates[node.id] = enabledFilterTree
      ? compileFilterGroupForNode({
          group: enabledFilterTree,
          nodeId: node.id,
          modelsById,
          edgesById,
          parametersById,
          parameterValues,
          parameterMode,
          addDiagnostic,
        })
      : emptyPredicate();
  }

  const primaryPath = [...queryInterface.query.traversal.primaryPath];
  const primaryEdges: CompiledEdge[] = [];
  const usedPrimaryEdgeIds = new Set<string>();
  for (let index = 0; index < primaryPath.length - 1; index += 1) {
    const fromNodeId = primaryPath[index]!;
    const toNodeId = primaryPath[index + 1]!;
    const candidates = queryInterface.designGraph.edges.filter(
      (edge) =>
        edge.fromNodeId === fromNodeId &&
        edge.toNodeId === toNodeId &&
        edge.purpose !== 'constraint',
    );
    const edge =
      candidates.find((candidate) => candidate.traversalRole === 'primary') ?? candidates[0];
    if (!edge) {
      addDiagnostic({
        severity: 'error',
        code: 'execution_primary_edge_missing',
        message: `No executable edge connects primary nodes "${fromNodeId}" and "${toNodeId}".`,
        path: 'query.traversal.primaryPath',
      });
      continue;
    }
    if (
      candidates.length > 1 &&
      !candidates.some((candidate) => candidate.traversalRole === 'primary')
    ) {
      addDiagnostic({
        severity: 'error',
        code: 'execution_primary_edge_ambiguous',
        message: `Multiple edges connect primary nodes "${fromNodeId}" and "${toNodeId}".`,
        path: 'query.traversal.primaryPath',
      });
    }
    usedPrimaryEdgeIds.add(edge.id);
    primaryEdges.push(compileEdge(edge, 'primary', nodePredicates[toNodeId] ?? emptyPredicate()));
  }

  const branchEdges: CompiledEdge[] = [];
  for (const edge of queryInterface.designGraph.edges) {
    if (edge.purpose === 'constraint') {
      addDiagnostic({
        severity: 'error',
        code: 'execution_constraint_edge_unsupported',
        message: `Constraint edge "${edge.alias}" cannot yet be serialized to the wire query plan.`,
        path: `designGraph.edges.${edge.id}`,
      });
      continue;
    }
    if (usedPrimaryEdgeIds.has(edge.id)) {
      continue;
    }
    branchEdges.push(
      compileEdge(edge, 'branch', nodePredicates[edge.toNodeId] ?? emptyPredicate()),
    );
  }

  const aggregation = compileAggregation({
    queryInterface,
    subjectNodeId: primaryPath.at(-1) ?? rootNode?.id,
    modelsById,
    parametersById,
    parameterValues,
    parameterMode,
    addDiagnostic,
  });
  const projection = aggregation
    ? undefined
    : compileProjection({ queryInterface, modelsById, addDiagnostic });
  if (aggregation) {
    const primaryNodeIds = new Set(primaryPath);
    for (const node of queryInterface.designGraph.nodes) {
      if (
        !primaryNodeIds.has(node.id) &&
        !isEmptyPredicate(nodePredicates[node.id] ?? emptyPredicate())
      ) {
        addDiagnostic({
          severity: 'error',
          code: 'execution_aggregation_branch_filter_unsupported',
          message: 'Aggregation cannot apply direct field filters from branch-only nodes.',
          path: `query.filterTree.${node.id}`,
        });
      }
    }
  }
  const orderBy = compileOrderBy({
    queryInterface,
    rowSubjectNodeId: primaryPath.at(-1) ?? rootNode?.id,
    modelsById,
    aggregation,
    addDiagnostic,
  });
  if (projection) {
    addDiagnostic({
      severity: 'warning',
      code: 'execution_projection_client_side',
      message:
        'The wire query returns complete records; the preview adapter applies the interface projection.',
      path: 'query.projection',
    });
  }

  const configuredLimit = queryInterface.query.pagination?.defaultLimit;
  const maxLimit = queryInterface.query.pagination?.maxLimit;
  const requestedLimit = Math.max(1, Math.floor(input.previewLimit ?? configuredLimit ?? 20));
  const limit = maxLimit ? Math.min(requestedLimit, maxLimit) : requestedLimit;
  const program: QueryExecutionProgram | undefined =
    rootNode && rootModel?.model_name
      ? {
          originModel: rootModel.model_name,
          rootNodeId: rootNode.id,
          primaryPath,
          primaryEdges,
          branchEdges,
          nodePredicates,
          projection,
          aggregation,
          orderBy,
          executeOptions: {
            limit,
            ...(queryInterface.query.pagination?.mode === 'cursor'
              ? { cursor: null }
              : { page: 0 }),
            includeRelates: !aggregation,
          },
        }
      : undefined;

  let snapshot: RemoteExecuteSnapshot | undefined;
  if (program && !diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    try {
      const chain = new WireQueryChain<Record<string, unknown>>(program.originModel, {
        kind: 'all',
      });
      applyProgramToChain(chain, program);
      snapshot = chain.getRemoteExecuteSnapshot(program.executeOptions);
    } catch (error) {
      addDiagnostic({
        severity: 'error',
        code: 'execution_snapshot_compile_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const relationFilters = enabledFilterTree ? queryRelationFilterCount(enabledFilterTree) : 0;
  const filterCount = enabledFilterTree ? queryFilterExpressionCount(enabledFilterTree) : 0;
  const modelCount = new Set(queryInterface.designGraph.nodes.map((node) => node.modelId)).size;
  const stages: QueryExecutionStage[] = [
    {
      id: 'scope',
      label: 'Data scope',
      summary: `${modelCount} models, ${queryInterface.designGraph.nodes.length} nodes, ${queryInterface.designGraph.edges.length} relations`,
      status: rootModel ? 'ready' : 'blocked',
    },
    {
      id: 'filter',
      label: 'Row filters',
      summary: `${filterCount} conditions, ${relationFilters} relation quantifiers`,
      status: filterCount > 0 ? 'ready' : 'inactive',
    },
    {
      id: 'traversal',
      label: 'Traversal',
      summary: `${primaryEdges.length} primary hops, ${branchEdges.length} branch hops`,
      status: primaryEdges.length + branchEdges.length > 0 ? 'ready' : 'inactive',
    },
    {
      id: 'aggregation',
      label: 'Aggregation',
      summary: aggregation
        ? `${aggregation.groupBy.length} dimensions, ${queryInterface.query.aggregation?.metrics.length ?? 0} metrics`
        : 'Not configured',
      status: aggregation ? 'ready' : 'inactive',
    },
    {
      id: 'result',
      label: 'Result',
      summary: `${queryInterface.query.result.schema.length} fields, ${orderBy.length} sorts, limit ${limit}`,
      status: queryInterface.query.result.schema.length > 0 ? 'ready' : 'inactive',
    },
  ];
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    for (const stage of stages) {
      if (stage.status === 'ready') {
        stage.status = 'blocked';
      }
    }
  }
  return {
    interfaceId: queryInterface.id,
    ready: Boolean(program && snapshot) && !diagnostics.some((item) => item.severity === 'error'),
    program,
    snapshot,
    stages,
    diagnostics,
  };
}

export async function executeQueryExecutionPlan(
  client: RemoteModelDBClient,
  plan: QueryExecutionPlan,
  cursor?: string,
): Promise<QueryPreviewResult> {
  if (!plan.ready || !plan.program) {
    throw new Error('QUERY_EXECUTION_PLAN_NOT_READY');
  }
  const chain = client.model(plan.program.originModel).query<Record<string, unknown>>();
  applyProgramToChain(chain, plan.program);
  const result = await chain.execute(
    cursor === undefined ? plan.program.executeOptions : { ...plan.program.executeOptions, cursor },
  );
  return normalizePreviewResult(result, plan.program);
}

function compileEdge(
  edge: DesignEdge,
  kind: CompiledEdge['kind'],
  targetPredicate: PredicateNode,
): CompiledEdge {
  return {
    edgeId: edge.id,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    relationName: edge.alias,
    kind,
    targetPredicate,
  };
}

function analyzeFilterTree(
  root: QueryFilterGroup,
  addDiagnostic: (diagnostic: QueryExecutionDiagnostic) => void,
): void {
  const visit = (expression: QueryFilterExpression, insideOr: boolean): Set<string> => {
    if (isQueryFilterGroup(expression)) {
      if (!expression.enabled) {
        return new Set();
      }
      const childScopes = expression.children.map((child) =>
        visit(child, insideOr || expression.combinator === 'or'),
      );
      const scopes = new Set(childScopes.flatMap((scope) => [...scope]));
      if (expression.combinator === 'or' && scopes.size > 1) {
        addDiagnostic({
          severity: 'error',
          code: 'execution_cross_node_or_unsupported',
          message:
            'OR groups spanning multiple query nodes cannot be split into wire hop predicates.',
          path: `query.filterTree.${expression.id}`,
        });
      }
      return scopes;
    }
    if (isQueryRelationFilter(expression)) {
      return expression.enabled ? new Set([expression.sourceNodeId]) : new Set();
    }
    if (!expression.enabled) {
      return new Set();
    }
    if ('nodeId' in expression.target) {
      return new Set([expression.target.nodeId]);
    }
    return new Set();
  };
  visit(root, false);
}

function compileFilterGroupForNode(input: {
  group: QueryFilterGroup;
  nodeId: string;
  modelsById: ReadonlyMap<string, EngineModelNode>;
  edgesById: ReadonlyMap<string, DesignEdge>;
  parametersById: ReadonlyMap<string, InterfaceParameter>;
  parameterValues: Readonly<Record<string, unknown>>;
  parameterMode: 'values' | 'placeholders';
  addDiagnostic: (diagnostic: QueryExecutionDiagnostic) => void;
}): PredicateNode {
  if (!input.group.enabled) {
    return emptyPredicate();
  }
  const children: PredicateNode[] = [];
  for (const child of input.group.children) {
    if (isQueryFilterGroup(child)) {
      const compiled = compileFilterGroupForNode({ ...input, group: child });
      if (!isEmptyPredicate(compiled)) {
        children.push(compiled);
      }
      continue;
    }
    if (isQueryRelationFilter(child)) {
      if (!child.enabled || child.sourceNodeId !== input.nodeId) {
        continue;
      }
      const edge = input.edgesById.get(child.target.edgeId);
      if (!edge || edge.fromNodeId !== child.sourceNodeId || edge.toNodeId !== child.targetNodeId) {
        input.addDiagnostic({
          severity: 'error',
          code: 'execution_relation_filter_edge_missing',
          message: `Relation filter edge "${child.target.edgeId}" is unavailable.`,
          path: `query.filterTree.${child.id}.target`,
        });
        continue;
      }
      const target = compileFilterGroupForNode({
        ...input,
        group: child.condition,
        nodeId: child.targetNodeId,
      });
      children.push({
        type: 'relation',
        relationName: edge.alias,
        quantifier: child.quantifier,
        target,
      });
      continue;
    }
    if (!child.enabled || !('nodeId' in child.target)) {
      continue;
    }
    if (child.target.nodeId !== input.nodeId) {
      continue;
    }
    const compiled = compileFilter(child, input);
    if (compiled) {
      children.push(compiled);
    }
  }
  return { type: 'group', logic: input.group.combinator.toUpperCase() as 'AND' | 'OR', children };
}

function compileFilter(
  filter: QueryFilter,
  context: {
    modelsById: ReadonlyMap<string, EngineModelNode>;
    parametersById: ReadonlyMap<string, InterfaceParameter>;
    parameterValues: Readonly<Record<string, unknown>>;
    parameterMode: 'values' | 'placeholders';
    addDiagnostic: (diagnostic: QueryExecutionDiagnostic) => void;
  },
): PredicateNode | undefined {
  if (!('nodeId' in filter.target)) {
    context.addDiagnostic({
      severity: 'error',
      code: 'execution_non_field_filter_unsupported',
      message: `Filter "${filter.id}" does not target a model field.`,
      path: `query.filters.${filter.id}`,
    });
    return undefined;
  }
  const target = filter.target;
  const model = context.modelsById.get(target.modelId);
  const field = model?.props_objects_array.find((prop) => prop.id === target.fieldId);
  if (!field?.name) {
    context.addDiagnostic({
      severity: 'error',
      code: 'execution_filter_field_missing',
      message: `Filter field "${target.fieldId}" is unavailable.`,
      path: `query.filters.${filter.id}.target`,
    });
    return undefined;
  }
  const operator = compileOperator(filter.operator);
  if (!operator) {
    context.addDiagnostic({
      severity: 'error',
      code: 'execution_filter_operator_unsupported',
      message: `Operator "${filter.operator}" is not supported by the wire query protocol.`,
      path: `query.filters.${filter.id}.operator`,
    });
    return undefined;
  }
  const value = resolveFilterValue(filter, context);
  if (!value.ok) {
    return undefined;
  }
  return {
    type: 'atom',
    field: field.name,
    op: operator,
    value:
      operator === 'in' && !isQueryParameterPlaceholder(value.value)
        ? normalizeListValue(value.value)
        : value.value,
  };
}

function resolveFilterValue(
  filter: QueryFilter,
  context: {
    parametersById: ReadonlyMap<string, InterfaceParameter>;
    parameterValues: Readonly<Record<string, unknown>>;
    parameterMode: 'values' | 'placeholders';
    addDiagnostic: (diagnostic: QueryExecutionDiagnostic) => void;
  },
  valuePath = `query.filters.${filter.id}.value`,
): { ok: true; value: unknown } | { ok: false } {
  if (!filter.value) {
    context.addDiagnostic({
      severity: 'error',
      code: 'execution_filter_value_missing',
      message: `Filter "${filter.id}" requires a preview value.`,
      path: valuePath,
    });
    return { ok: false };
  }
  if (filter.value.kind === 'literal') {
    return { ok: true, value: filter.value.value };
  }
  const parameter = context.parametersById.get(filter.value.parameterId);
  if (!parameter) {
    return { ok: false };
  }
  if (context.parameterMode === 'placeholders') {
    return { ok: true, value: queryParameterPlaceholder(parameter.id) };
  }
  const supplied = context.parameterValues[parameter.id];
  const raw = supplied === undefined || supplied === '' ? parameter.defaultValue : supplied;
  if (raw === undefined || raw === '') {
    context.addDiagnostic({
      severity: 'error',
      code: 'execution_parameter_value_missing',
      message: `Parameter "${parameter.name}" needs a preview value.`,
      path: `contract.parameters.${parameter.id}`,
    });
    return { ok: false };
  }
  try {
    return { ok: true, value: coerceParameterValue(parameter, raw) };
  } catch (error) {
    context.addDiagnostic({
      severity: 'error',
      code: 'execution_parameter_value_invalid',
      message: error instanceof Error ? error.message : String(error),
      path: `contract.parameters.${parameter.id}`,
    });
    return { ok: false };
  }
}

function compileAggregation(input: {
  queryInterface: QueryInterface;
  subjectNodeId: string | undefined;
  modelsById: ReadonlyMap<string, EngineModelNode>;
  parametersById: ReadonlyMap<string, InterfaceParameter>;
  parameterValues: Readonly<Record<string, unknown>>;
  parameterMode: 'values' | 'placeholders';
  addDiagnostic: (diagnostic: QueryExecutionDiagnostic) => void;
}): AggregationProgram | undefined {
  const aggregation = input.queryInterface.query.aggregation;
  if (!aggregation || (aggregation.groupBy.length === 0 && aggregation.metrics.length === 0)) {
    return undefined;
  }
  const fieldName = (
    ref: { nodeId: string; modelId: string; fieldId: string },
    path: string,
  ): string => {
    if (ref.nodeId !== input.subjectNodeId) {
      input.addDiagnostic({
        severity: 'error',
        code: 'execution_aggregation_subject_mismatch',
        message: 'Aggregation fields must belong to the primary path terminal node.',
        path,
      });
    }
    const model = input.modelsById.get(ref.modelId);
    const prop = model?.props_objects_array.find((item) => item.id === ref.fieldId);
    if (!prop?.name) {
      input.addDiagnostic({
        severity: 'error',
        code: 'execution_aggregation_field_missing',
        message: `Aggregation field "${ref.fieldId}" is unavailable.`,
        path,
      });
    }
    return prop?.name ?? ref.fieldId;
  };
  const groupBy = aggregation.groupBy.map((group) =>
    fieldName(group.source, `query.aggregation.groupBy.${group.id}`),
  );
  const dimensions = aggregation.groupBy.map((group, index) => ({
    sourceField: groupBy[index]!,
    outputName: group.outputName,
  }));
  const metricsByField = new Map<string, QueryAggregateMetric[]>();
  for (const metric of aggregation.metrics) {
    const sourceField = fieldName(metric.source, `query.aggregation.metrics.${metric.id}`);
    const entries = metricsByField.get(sourceField) ?? [];
    if (
      entries.some(
        (entry) =>
          entry.function === metric.function &&
          Boolean(entry.distinct) === Boolean(metric.distinct),
      )
    ) {
      input.addDiagnostic({
        severity: 'error',
        code: 'execution_duplicate_metric_operation',
        message: `Metric operation "${metric.function}" is duplicated for field "${sourceField}".`,
        path: `query.aggregation.metrics.${metric.id}`,
      });
    }
    entries.push(metric);
    metricsByField.set(sourceField, entries);
  }
  const compute: Record<string, AggregateInputEntry> = {};
  const aliases: AggregationProgram['aliases'] = [];
  for (const [sourceField, metrics] of metricsByField) {
    const operations = metrics.map(aggregateWireOperation);
    compute[sourceField] = operations.length === 1 ? operations[0]! : operations;
    for (const metric of metrics) {
      aliases.push({
        metricId: metric.id,
        wireKey:
          operations.length === 1
            ? sourceField
            : `${aggregateWireOperation(metric)}_${sourceField}`,
        outputName: metric.outputName,
      });
    }
  }
  const aliasesByMetricId = new Map(aliases.map((alias) => [alias.metricId, alias]));
  const having = aggregation.having
    ? compileHavingGroup({
        group: aggregation.having,
        aliasesByMetricId,
        parametersById: input.parametersById,
        parameterValues: input.parameterValues,
        parameterMode: input.parameterMode,
        addDiagnostic: input.addDiagnostic,
      })
    : undefined;
  return {
    groupBy,
    compute,
    aliases,
    dimensions,
    ...(having && !isEmptyPredicate(having) ? { having } : {}),
  };
}

function aggregateWireOperation(metric: QueryAggregateMetric): AggregateOp {
  if (!metric.distinct) {
    return metric.function;
  }
  return `${metric.function}Distinct` as AggregateOp;
}

function compileHavingGroup(input: {
  group: QueryFilterGroup;
  aliasesByMetricId: ReadonlyMap<string, { metricId: string; wireKey: string; outputName: string }>;
  parametersById: ReadonlyMap<string, InterfaceParameter>;
  parameterValues: Readonly<Record<string, unknown>>;
  parameterMode: 'values' | 'placeholders';
  addDiagnostic: (diagnostic: QueryExecutionDiagnostic) => void;
}): PredicateNode {
  if (!input.group.enabled) {
    return emptyPredicate();
  }
  const children: PredicateNode[] = [];
  for (const child of input.group.children) {
    if (isQueryFilterGroup(child)) {
      const nested = compileHavingGroup({ ...input, group: child });
      if (!isEmptyPredicate(nested)) {
        children.push(nested);
      }
      continue;
    }
    if (isQueryRelationFilter(child) || !child.enabled || !('metricId' in child.target)) {
      continue;
    }
    const path = `query.aggregation.having.${child.id}`;
    const alias = input.aliasesByMetricId.get(child.target.metricId);
    if (!alias) {
      input.addDiagnostic({
        severity: 'error',
        code: 'execution_having_metric_missing',
        message: `HAVING metric "${child.target.metricId}" is unavailable.`,
        path: `${path}.target`,
      });
      continue;
    }
    const operator = compileOperator(child.operator);
    if (!operator) {
      input.addDiagnostic({
        severity: 'error',
        code: 'execution_having_operator_unsupported',
        message: `HAVING operator "${child.operator}" is not supported by the wire query protocol.`,
        path: `${path}.operator`,
      });
      continue;
    }
    const value = resolveFilterValue(child, input, `${path}.value`);
    if (!value.ok) {
      continue;
    }
    children.push({
      type: 'atom',
      field: alias.wireKey,
      op: operator,
      value:
        operator === 'in' && !isQueryParameterPlaceholder(value.value)
          ? normalizeListValue(value.value)
          : value.value,
    });
  }
  return {
    type: 'group',
    logic: input.group.combinator.toUpperCase() as 'AND' | 'OR',
    children,
  };
}

function compileProjection(input: {
  queryInterface: QueryInterface;
  modelsById: ReadonlyMap<string, EngineModelNode>;
  addDiagnostic: (diagnostic: QueryExecutionDiagnostic) => void;
}): ProjectionProgram | undefined {
  const visibleFields = input.queryInterface.query.projection.fields.filter(
    (field) => field.visible,
  );
  if (visibleFields.length === 0) {
    return undefined;
  }
  const fieldsByNode: Record<string, ProjectionFieldProgram[]> = {};
  for (const field of visibleFields) {
    const model = input.modelsById.get(field.source.modelId);
    const prop = model?.props_objects_array.find((item) => item.id === field.source.fieldId);
    if (!prop?.name) {
      input.addDiagnostic({
        severity: 'error',
        code: 'execution_projection_field_missing',
        message: `Projection field "${field.source.fieldId}" is unavailable.`,
        path: `query.projection.fields.${field.id}`,
      });
      continue;
    }
    const entries = fieldsByNode[field.source.nodeId] ?? [];
    entries.push({ sourceField: prop.name, outputName: field.outputName });
    fieldsByNode[field.source.nodeId] = entries;
  }
  const edgesBySource: Record<string, CompiledEdge[]> = {};
  for (const edge of input.queryInterface.designGraph.edges) {
    if (edge.purpose === 'constraint') {
      continue;
    }
    const entries = edgesBySource[edge.fromNodeId] ?? [];
    entries.push(
      compileEdge(edge, edge.traversalRole === 'primary' ? 'primary' : 'branch', emptyPredicate()),
    );
    edgesBySource[edge.fromNodeId] = entries;
  }
  return { fieldsByNode, edgesBySource };
}

function compileOrderBy(input: {
  queryInterface: QueryInterface;
  rowSubjectNodeId: string | undefined;
  modelsById: ReadonlyMap<string, EngineModelNode>;
  aggregation: AggregationProgram | undefined;
  addDiagnostic: (diagnostic: QueryExecutionDiagnostic) => void;
}): QueryOrderEntry[] {
  const orderBy: QueryOrderEntry[] = [];
  const sorted = [...input.queryInterface.query.sorts].sort(
    (left, right) => left.priority - right.priority,
  );
  for (const sort of sorted) {
    if ('metricId' in sort.target) {
      const metricId = sort.target.metricId;
      const alias = input.aggregation?.aliases.find((candidate) => candidate.metricId === metricId);
      if (!alias) {
        input.addDiagnostic({
          severity: 'error',
          code: 'execution_sort_target_missing',
          message: `Sort metric "${metricId}" is unavailable.`,
          path: `query.sorts.${sort.id}.target`,
        });
        continue;
      }
      orderBy.push({ field: alias.wireKey, direction: sort.direction });
      continue;
    }
    const target = sort.target;
    if (!input.aggregation && target.nodeId !== input.rowSubjectNodeId) {
      input.addDiagnostic({
        severity: 'error',
        code: 'execution_sort_related_field_unsupported',
        message: 'Row sorting supports fields from the primary path terminal node only.',
        path: `query.sorts.${sort.id}.target`,
      });
      continue;
    }
    if (
      input.aggregation &&
      !input.queryInterface.query.aggregation?.groupBy.some(
        (group) =>
          group.source.nodeId === target.nodeId &&
          group.source.modelId === target.modelId &&
          group.source.fieldId === target.fieldId,
      )
    ) {
      input.addDiagnostic({
        severity: 'error',
        code: 'execution_sort_aggregate_field_unsupported',
        message: 'Aggregation sorting supports group dimensions and metrics only.',
        path: `query.sorts.${sort.id}.target`,
      });
      continue;
    }
    const model = input.modelsById.get(target.modelId);
    const prop = model?.props_objects_array.find((field) => field.id === target.fieldId);
    if (!prop?.name) {
      input.addDiagnostic({
        severity: 'error',
        code: 'execution_sort_target_missing',
        message: `Sort field "${target.fieldId}" is unavailable.`,
        path: `query.sorts.${sort.id}.target`,
      });
      continue;
    }
    orderBy.push({ field: prop.name, direction: sort.direction });
  }
  return orderBy;
}

function applyProgramToChain(
  chain: WireQueryChain<Record<string, unknown>, 'rows' | 'analysis'>,
  program: QueryExecutionProgram,
): void {
  const branchesBySource = new Map<string, CompiledEdge[]>();
  for (const edge of program.branchEdges) {
    const entries = branchesBySource.get(edge.fromNodeId) ?? [];
    entries.push(edge);
    branchesBySource.set(edge.fromNodeId, entries);
  }
  const applyBranches = (
    targetChain: WireQueryChain<Record<string, unknown>, 'rows' | 'analysis'>,
    sourceNodeId: string,
    visited: ReadonlySet<string>,
  ): void => {
    for (const edge of branchesBySource.get(sourceNodeId) ?? []) {
      if (visited.has(edge.edgeId)) {
        continue;
      }
      const nextVisited = new Set(visited);
      nextVisited.add(edge.edgeId);
      addChainPredicate(targetChain, program.nodePredicates[sourceNodeId]);
      targetChain.group(
        edge.relationName,
        (builder) => addBuilderPredicate(builder, edge.targetPredicate),
        (sub) => applyBranches(sub, edge.toNodeId, nextVisited),
      );
    }
  };

  if (!program.aggregation) {
    applyBranches(chain, program.rootNodeId, new Set());
  }
  let currentNodeId = program.rootNodeId;
  for (const edge of program.primaryEdges) {
    addChainPredicate(chain, program.nodePredicates[currentNodeId]);
    chain.relate(
      edge.relationName,
      (builder) => addBuilderPredicate(builder, edge.targetPredicate),
      program.aggregation
        ? undefined
        : (sub) => applyBranches(sub, edge.toNodeId, new Set([edge.edgeId])),
    );
    currentNodeId = edge.toNodeId;
  }
  if (program.primaryEdges.length === 0 && program.branchEdges.length === 0) {
    addChainPredicate(chain, program.nodePredicates[program.rootNodeId]);
  }
  if (program.aggregation) {
    chain.groupBy(program.aggregation.groupBy);
    if (Object.keys(program.aggregation.compute).length > 0) {
      chain.compute(program.aggregation.compute);
    }
    if (program.aggregation.having) {
      chain.having(program.aggregation.having);
    }
  }
  for (const order of program.orderBy) {
    chain.orderBy(order.field, order.direction);
  }
}

function addChainPredicate(
  chain: WireQueryChain<Record<string, unknown>, 'rows' | 'analysis'>,
  predicate: PredicateNode | undefined,
): void {
  if (predicate && !isEmptyPredicate(predicate)) {
    chain.matchAllNodes(() => [predicate]);
  }
}

function addBuilderPredicate(
  builder: { and(...inputs: PredicateNode[]): unknown },
  predicate: PredicateNode,
): void {
  if (!isEmptyPredicate(predicate)) {
    builder.and(predicate);
  }
}

function normalizePreviewResult(
  result: unknown,
  program: QueryExecutionProgram,
): QueryPreviewResult {
  if (isRecord(result) && 'items' in result) {
    const nested = normalizePreviewResult(result.items, program);
    return {
      ...nested,
      total: typeof result.total === 'number' ? result.total : undefined,
      page: typeof result.page === 'number' ? result.page : undefined,
      pageCount: typeof result.pageCount === 'number' ? result.pageCount : undefined,
      nextCursor: typeof result.nextCursor === 'string' ? result.nextCursor : undefined,
    };
  }
  if (isRecord(result) && result.kind === 'analysis' && Array.isArray(result.rows)) {
    return {
      rows: result.rows.filter(isRecord).map((row) => remapAggregationRow(row, program)),
      rawKind: 'analysis',
    };
  }
  if (isRecord(result) && result.kind === 'groups' && Array.isArray(result.groups)) {
    const rows = result.groups.filter(isRecord).map((group) => {
      const row: Record<string, unknown> = {};
      const values = Array.isArray(group.dimensionValues) ? group.dimensionValues : [];
      program.aggregation?.dimensions.forEach((dimension, index) => {
        row[dimension.outputName] = values[index];
      });
      if (isRecord(group.aggregates)) {
        Object.assign(row, remapAggregationRow(group.aggregates, program));
      }
      return row;
    });
    return { rows, rawKind: 'groups' };
  }
  if (Array.isArray(result)) {
    return {
      rows: result.map((item) => {
        if (isRecord(item) && typeof item.getData === 'function') {
          const data = item.getData();
          return isRecord(data) ? projectPreviewRow(data, program) : { value: data };
        }
        return isRecord(item) ? projectPreviewRow(item, program) : { value: item };
      }),
      rawKind: 'rows',
    };
  }
  return {
    rows: isRecord(result) ? [projectPreviewRow(result, program)] : [{ value: result }],
    rawKind: typeof result,
  };
}

function projectPreviewRow(
  row: Record<string, unknown>,
  program: QueryExecutionProgram,
): Record<string, unknown> {
  if (!program.projection) {
    return row;
  }
  return projectPreviewNode(row, program.rootNodeId, program.projection, new Set());
}

function projectPreviewNode(
  row: Record<string, unknown>,
  nodeId: string,
  projection: ProjectionProgram,
  path: ReadonlySet<Record<string, unknown>>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const field of projection.fieldsByNode[nodeId] ?? []) {
    output[field.outputName] = row[field.sourceField];
  }
  if (path.has(row)) {
    return output;
  }
  const nextPath = new Set(path);
  nextPath.add(row);
  const relates = isRecord(row.relates) ? row.relates : {};
  for (const edge of projection.edgesBySource[nodeId] ?? []) {
    const related = relates[edge.relationName];
    output[edge.relationName] = Array.isArray(related)
      ? related
          .filter(isRecord)
          .map((child) => projectPreviewNode(child, edge.toNodeId, projection, nextPath))
      : [];
  }
  return output;
}

function remapAggregationRow(
  row: Record<string, unknown>,
  program: QueryExecutionProgram,
): Record<string, unknown> {
  if (!program.aggregation) {
    return row;
  }
  const mapped: Record<string, unknown> = {};
  for (const dimension of program.aggregation.dimensions) {
    mapped[dimension.outputName] = row[dimension.sourceField];
  }
  for (const alias of program.aggregation.aliases) {
    mapped[alias.outputName] = row[alias.wireKey];
  }
  return mapped;
}

function compileOperator(
  operator: QueryFilter['operator'],
): 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | undefined {
  if (operator === 'contains') {
    return 'like';
  }
  if (['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in'].includes(operator)) {
    return operator as 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';
  }
  return undefined;
}

function coerceParameterValue(parameter: InterfaceParameter, value: unknown): unknown {
  if (parameter.type === 'number') {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      throw new Error(`Parameter "${parameter.name}" must be a number.`);
    }
    return number;
  }
  if (parameter.type === 'boolean') {
    if (typeof value === 'boolean') {
      return value;
    }
    if (value === 'true' || value === '1') {
      return true;
    }
    if (value === 'false' || value === '0') {
      return false;
    }
    throw new Error(`Parameter "${parameter.name}" must be true or false.`);
  }
  if (parameter.type === 'json' && typeof value === 'string') {
    return JSON.parse(value) as unknown;
  }
  return value;
}

function normalizeListValue(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [value];
}

function emptyPredicate(): PredicateNode {
  return { type: 'group', logic: 'AND', children: [] };
}

function isEmptyPredicate(predicate: PredicateNode): boolean {
  return predicate.type === 'group' && predicate.children.length === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
