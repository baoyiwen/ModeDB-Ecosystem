import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compilePublishedQueryExecutionTemplate,
  compileQueryExecutionPlan,
  type QueryInterface,
} from '../../apps/model-designer/src/query-designer/index.js';
import type {
  EngineModelNode,
  EngineRelationEdge,
} from '../../apps/model-designer/src/types/engine-schema.js';

const models: EngineModelNode[] = [
  model('model_a', 'Account', [field('field_name', 'name'), field('field_total', 'total', 'number')]),
  model('model_b', 'Order', [field('field_code', 'code'), field('field_amount', 'amount', 'number')]),
  model('model_c', 'Contact', [field('field_email', 'email')]),
];

const relations: EngineRelationEdge[] = [
  relation('relation_ab', 'model_a', 'model_b', 'hasOrders', 'belongsToAccount'),
  relation('relation_ac', 'model_a', 'model_c', 'hasContacts', 'belongsToAccount'),
];

describe('compileQueryExecutionPlan', () => {
  it('compiles root filters, a primary hop and a branch hop', () => {
    const queryInterface = baseInterface();
    queryInterface.contract.parameters = [
      {
        id: 'parameter_name',
        name: 'name',
        type: 'string',
        required: true,
      },
    ];
    queryInterface.query.filterTree = {
      id: 'filter_root',
      kind: 'group',
      combinator: 'and',
      enabled: true,
      children: [
        {
          id: 'filter_name',
          target: { nodeId: 'node_a', modelId: 'model_a', fieldId: 'field_name' },
          operator: 'eq',
          value: { kind: 'parameter', parameterId: 'parameter_name' },
          enabled: true,
        },
      ],
    };

    const plan = compileQueryExecutionPlan({
      queryInterface,
      models,
      relations,
      parameterValues: { parameter_name: 'Ada' },
    });

    assert.equal(plan.ready, true);
    assert.equal(plan.program?.primaryEdges.length, 1);
    assert.equal(plan.program?.branchEdges.length, 1);
    assert.equal(plan.snapshot?.plan.originModel, 'Account');
    assert.equal(plan.snapshot?.plan.hops[0]?.relationName, 'hasContacts');
    assert.equal(plan.snapshot?.plan.hops[0]?.lateral, true);
    assert.equal(plan.snapshot?.plan.hops[1]?.relationName, 'hasOrders');
  });

  it('serializes root aggregation dimensions and metrics', () => {
    const queryInterface = baseInterface();
    queryInterface.query.traversal.primaryPath = ['node_a'];
    queryInterface.query.aggregation = {
      groupBy: [
        {
          id: 'group_name',
          source: { nodeId: 'node_a', modelId: 'model_a', fieldId: 'field_name' },
          outputName: 'name',
        },
      ],
      metrics: [
        {
          id: 'metric_total',
          function: 'sum',
          source: { nodeId: 'node_a', modelId: 'model_a', fieldId: 'field_total' },
          outputName: 'totalSum',
        },
      ],
    };
    queryInterface.query.sorts = [
      {
        id: 'sort_total',
        target: { metricId: 'metric_total' },
        direction: 'desc',
        priority: 0,
      },
    ];

    const plan = compileQueryExecutionPlan({ queryInterface, models, relations });

    assert.equal(plan.ready, true);
    assert.deepEqual(plan.snapshot?.analysis.groupBy, ['name']);
    assert.deepEqual(plan.snapshot?.analysis.compute, { total: 'sum' });
    assert.deepEqual(plan.snapshot?.execute.orderBy, [{ field: 'total', direction: 'desc' }]);
  });

  it('compiles parameterized HAVING filters with metric wire keys', () => {
    const queryInterface = baseInterface();
    queryInterface.query.traversal.primaryPath = ['node_a'];
    queryInterface.contract.parameters = [
      {
        id: 'parameter_minimum',
        name: 'minimumTotal',
        type: 'number',
        required: true,
      },
    ];
    queryInterface.query.aggregation = {
      groupBy: [
        {
          id: 'group_name',
          source: { nodeId: 'node_a', modelId: 'model_a', fieldId: 'field_name' },
          outputName: 'accountName',
        },
      ],
      metrics: [
        {
          id: 'metric_total',
          function: 'sum',
          source: { nodeId: 'node_a', modelId: 'model_a', fieldId: 'field_total' },
          outputName: 'totalAmount',
        },
      ],
      having: {
        id: 'having_root',
        kind: 'group',
        combinator: 'and',
        enabled: true,
        children: [
          {
            id: 'having_total',
            target: { metricId: 'metric_total' },
            operator: 'gt',
            value: { kind: 'parameter', parameterId: 'parameter_minimum' },
            enabled: true,
          },
        ],
      },
    };

    const plan = compileQueryExecutionPlan({
      queryInterface,
      models,
      relations,
      parameterValues: { parameter_minimum: '5' },
    });

    assert.equal(plan.ready, true);
    assert.equal(plan.snapshot?.plan.version, 5);
    assert.deepEqual(plan.snapshot?.analysis.having, {
      type: 'group',
      logic: 'AND',
      children: [{ type: 'atom', field: 'total', op: 'gt', value: 5 }],
    });
  });

  it('compiles required parameters into published template placeholders', () => {
    const queryInterface = baseInterface();
    queryInterface.contract.parameters = [
      { id: 'parameter_name', name: 'name', type: 'string', required: true },
    ];
    queryInterface.query.filterTree = {
      id: 'filter_root',
      kind: 'group',
      combinator: 'and',
      enabled: true,
      children: [
        {
          id: 'filter_name',
          target: { nodeId: 'node_a', modelId: 'model_a', fieldId: 'field_name' },
          operator: 'eq',
          value: { kind: 'parameter', parameterId: 'parameter_name' },
          enabled: true,
        },
      ],
    };

    const compiled = compilePublishedQueryExecutionTemplate({ queryInterface, models, relations });

    assert.ok(compiled.template);
    assert.equal(compiled.template?.format, 1);
    assert.equal(compiled.template?.parameters[0]?.name, 'name');
    assert.equal(
      JSON.stringify(compiled.template?.snapshot).includes(
        '"$queryParameter":"parameter_name"',
      ),
      true,
    );
  });

  it('compiles regular and distinct metrics as sibling aggregate operations', () => {
    const queryInterface = baseInterface();
    queryInterface.query.traversal.primaryPath = ['node_a'];
    queryInterface.query.aggregation = {
      groupBy: [
        {
          id: 'group_name',
          source: { nodeId: 'node_a', modelId: 'model_a', fieldId: 'field_name' },
          outputName: 'name',
        },
      ],
      metrics: [
        {
          id: 'metric_count',
          function: 'count',
          source: { nodeId: 'node_a', modelId: 'model_a', fieldId: 'field_total' },
          outputName: 'totalCount',
        },
        {
          id: 'metric_unique_count',
          function: 'count',
          source: { nodeId: 'node_a', modelId: 'model_a', fieldId: 'field_total' },
          outputName: 'uniqueTotalCount',
          distinct: true,
        },
      ],
    };
    queryInterface.query.sorts = [
      {
        id: 'sort_unique_count',
        target: { metricId: 'metric_unique_count' },
        direction: 'desc',
        priority: 0,
      },
    ];

    const plan = compileQueryExecutionPlan({ queryInterface, models, relations });

    assert.equal(plan.ready, true);
    assert.equal(plan.snapshot?.plan.version, 6);
    assert.deepEqual(plan.snapshot?.analysis.compute, {
      total: ['count', 'countDistinct'],
    });
    assert.deepEqual(plan.snapshot?.execute.orderBy, [
      { field: 'countDistinct_total', direction: 'desc' },
    ]);
  });

  it('aggregates fields from the primary path terminal model and omits output branches', () => {
    const queryInterface = baseInterface();
    queryInterface.query.aggregation = {
      groupBy: [
        {
          id: 'group_order_code',
          source: { nodeId: 'node_b', modelId: 'model_b', fieldId: 'field_code' },
          outputName: 'orderCode',
        },
      ],
      metrics: [
        {
          id: 'metric_order_amount',
          function: 'sum',
          source: { nodeId: 'node_b', modelId: 'model_b', fieldId: 'field_amount' },
          outputName: 'amountSum',
        },
      ],
    };

    const plan = compileQueryExecutionPlan({ queryInterface, models, relations });

    assert.equal(plan.ready, true);
    assert.deepEqual(plan.snapshot?.plan.hops.map((hop) => hop.relationName), ['hasOrders']);
    assert.deepEqual(plan.snapshot?.analysis.groupBy, ['code']);
    assert.deepEqual(plan.snapshot?.analysis.compute, { amount: 'sum' });
  });

  it('serializes root field sorting by priority', () => {
    const queryInterface = baseInterface();
    queryInterface.query.traversal.primaryPath = ['node_a'];
    queryInterface.query.sorts = [
      {
        id: 'sort_total',
        target: { nodeId: 'node_a', modelId: 'model_a', fieldId: 'field_total' },
        direction: 'desc',
        priority: 1,
      },
      {
        id: 'sort_name',
        target: { nodeId: 'node_a', modelId: 'model_a', fieldId: 'field_name' },
        direction: 'asc',
        priority: 0,
      },
    ];

    const plan = compileQueryExecutionPlan({ queryInterface, models, relations });

    assert.equal(plan.ready, true);
    assert.equal(plan.snapshot?.plan.version, 3);
    assert.deepEqual(plan.snapshot?.execute.orderBy, [
      { field: 'name', direction: 'asc' },
      { field: 'total', direction: 'desc' },
    ]);
  });

  it('compiles cursor pagination as a protocol v7 first-page request', () => {
    const queryInterface = baseInterface();
    queryInterface.query.pagination = {
      mode: 'cursor',
      defaultLimit: 12,
      maxLimit: 50,
    };

    const plan = compileQueryExecutionPlan({
      queryInterface,
      models,
      relations,
      previewLimit: 20,
    });

    assert.equal(plan.ready, true);
    assert.equal(plan.snapshot?.plan.version, 7);
    assert.deepEqual(plan.snapshot?.execute, {
      limit: 20,
      cursor: null,
      includeRelates: true,
    });
  });

  it('serializes row sorting by primary-path terminal fields', () => {
    const queryInterface = baseInterface();
    queryInterface.query.sorts = [
      {
        id: 'sort_order_code',
        target: { nodeId: 'node_b', modelId: 'model_b', fieldId: 'field_code' },
        direction: 'asc',
        priority: 0,
      },
    ];

    const plan = compileQueryExecutionPlan({ queryInterface, models, relations });

    assert.equal(plan.ready, true);
    assert.deepEqual(plan.snapshot?.execute.orderBy, [{ field: 'code', direction: 'asc' }]);
  });

  it('blocks row sorting by branch-only node fields', () => {
    const queryInterface = baseInterface();
    queryInterface.query.sorts = [
      {
        id: 'sort_contact_email',
        target: { nodeId: 'node_c', modelId: 'model_c', fieldId: 'field_email' },
        direction: 'asc',
        priority: 0,
      },
    ];

    const plan = compileQueryExecutionPlan({ queryInterface, models, relations });

    assert.equal(plan.ready, false);
    assert.equal(
      plan.diagnostics.some(
        (diagnostic) => diagnostic.code === 'execution_sort_related_field_unsupported',
      ),
      true,
    );
  });

  it('requires contract parameters before execution even when they are not used by a filter', () => {
    const queryInterface = baseInterface();
    queryInterface.contract.parameters = [
      { id: 'parameter_scope', name: 'scope', type: 'string', required: true },
    ];

    const plan = compileQueryExecutionPlan({ queryInterface, models, relations });

    assert.equal(plan.ready, false);
    assert.equal(
      plan.diagnostics.some((diagnostic) => diagnostic.code === 'execution_parameter_value_missing'),
      true,
    );
  });

  it('serializes relation quantifiers into version 4 predicates', () => {
    const queryInterface = baseInterface();
    queryInterface.query.filterTree = {
      id: 'filter_root',
      kind: 'group',
      combinator: 'and',
      enabled: true,
      children: [
        {
          id: 'relation_filter',
          kind: 'relation',
          target: { edgeId: 'edge_ab', relationId: 'relation_ab' },
          sourceNodeId: 'node_a',
          targetNodeId: 'node_b',
          quantifier: 'any',
          enabled: true,
          condition: {
            id: 'relation_condition',
            kind: 'group',
            combinator: 'and',
            enabled: true,
            children: [
              {
                id: 'filter_order_code',
                target: { nodeId: 'node_b', modelId: 'model_b', fieldId: 'field_code' },
                operator: 'eq',
                value: { kind: 'literal', value: 'A-1' },
                enabled: true,
              },
            ],
          },
        },
      ],
    };

    const plan = compileQueryExecutionPlan({ queryInterface, models, relations });

    assert.equal(plan.ready, true);
    assert.equal(plan.snapshot?.plan.version, 4);
    assert.deepEqual(plan.snapshot?.plan.hops[0]?.source, {
      type: 'group',
      logic: 'AND',
      children: [
        {
          type: 'relation',
          relationName: 'hasOrders',
          quantifier: 'any',
          target: {
            type: 'group',
            logic: 'AND',
            children: [
              {
                type: 'atom',
                field: 'code',
                op: 'eq',
                value: 'A-1',
              },
            ],
          },
        },
      ],
    });
  });
});

function baseInterface(): QueryInterface {
  return {
    id: 'query_account',
    kind: 'query',
    name: 'AccountQuery',
    status: 'draft',
    version: { current: '0.1.0', compatibility: 'draft' },
    contract: {
      parameters: [],
      output: { shape: 'tree' },
      errors: [],
      invocation: { method: 'query', callableName: 'AccountQuery' },
    },
    designGraph: {
      rootNodeId: 'node_a',
      nodes: [
        { id: 'node_a', modelId: 'model_a', alias: 'Account', role: 'root' },
        { id: 'node_b', modelId: 'model_b', alias: 'Order', role: 'joined' },
        { id: 'node_c', modelId: 'model_c', alias: 'Contact', role: 'joined' },
      ],
      edges: [
        {
          id: 'edge_ab',
          relationId: 'relation_ab',
          fromNodeId: 'node_a',
          toNodeId: 'node_b',
          alias: 'hasOrders',
          required: false,
          cardinality: 'many',
          traversal: 'forward',
          purpose: 'traversal',
          traversalRole: 'primary',
        },
        {
          id: 'edge_ac',
          relationId: 'relation_ac',
          fromNodeId: 'node_a',
          toNodeId: 'node_c',
          alias: 'hasContacts',
          required: false,
          cardinality: 'many',
          traversal: 'forward',
          purpose: 'traversal',
          traversalRole: 'branch',
        },
      ],
    },
    query: {
      rootNodeId: 'node_a',
      traversal: {
        primaryPath: ['node_a', 'node_b'],
        branches: [{ id: 'branch_ac', fromNodeId: 'node_a', path: ['node_a', 'node_c'] }],
      },
      filters: [],
      sorts: [],
      projection: {
        shape: 'tree',
        fields: [
          {
            id: 'projection_name',
            source: { nodeId: 'node_a', modelId: 'model_a', fieldId: 'field_name' },
            outputName: 'name',
            visible: true,
          },
        ],
      },
      result: {
        shape: 'tree',
        schema: [{ name: 'name', type: 'string', nullable: true }],
        includesRecordRefs: true,
      },
    },
    dependencies: {
      models: ['model_a', 'model_b', 'model_c'],
      fields: ['model_a.field_name'],
      relations: ['relation_ab', 'relation_ac'],
    },
    lifecycle: {
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
    },
  };
}

function model(
  id: string,
  modelName: string,
  props: EngineModelNode['props_objects_array'],
): EngineModelNode {
  return { id, model_name: modelName, parent_id: null, props_objects_array: props };
}

function field(id: string, name: string, type = 'string'): EngineModelNode['props_objects_array'][number] {
  return { id, name, type, is_primary: false, encrypt_level: 0, metadata: {} };
}

function relation(
  id: string,
  sourceModelId: string,
  targetModelId: string,
  forwardName: string,
  reverseName: string,
): EngineRelationEdge {
  return {
    id,
    source_model_id: sourceModelId,
    target_model_id: targetModelId,
    forward_name: forwardName,
    reverse_name: reverseName,
    kind: 'node-link',
  };
}
