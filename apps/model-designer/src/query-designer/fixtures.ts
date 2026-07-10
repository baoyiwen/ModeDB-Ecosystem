import type { QueryInterface } from './types.js';

const now = '2026-07-09T00:00:00.000Z';

export const customerOrdersQueryFixture: QueryInterface = {
  id: 'query_customer_orders',
  kind: 'query',
  name: 'customerOrders',
  displayName: 'Customer Orders',
  status: 'draft',
  version: {
    current: '0.1.0',
    compatibility: 'draft',
  },
  contract: {
    parameters: [
      {
        id: 'param_status',
        name: 'status',
        type: 'string',
        required: false,
      },
    ],
    output: {
      shape: 'tree',
    },
    errors: [],
    invocation: {
      method: 'query',
      callableName: 'customerOrders',
    },
  },
  designGraph: {
    rootNodeId: 'node_customer',
    nodes: [
      {
        id: 'node_customer',
        modelId: 'Customer',
        alias: 'customer',
        role: 'root',
      },
      {
        id: 'node_order',
        modelId: 'Order',
        alias: 'orders',
        role: 'joined',
        cardinality: 'many',
      },
    ],
    edges: [
      {
        id: 'edge_customer_orders',
        relationId: 'Customer.orders',
        fromNodeId: 'node_customer',
        toNodeId: 'node_order',
        alias: 'orders',
        required: false,
        cardinality: 'many',
        traversal: 'forward',
      },
    ],
  },
  query: {
    rootNodeId: 'node_customer',
    traversal: {
      primaryPath: ['node_customer', 'node_order'],
      branches: [],
    },
    filters: [
      {
        id: 'filter_order_status',
        target: {
          nodeId: 'node_order',
          modelId: 'Order',
          fieldId: 'status',
        },
        operator: 'eq',
        value: {
          kind: 'parameter',
          parameterId: 'param_status',
        },
        enabled: true,
      },
    ],
    sorts: [],
    projection: {
      shape: 'tree',
      fields: [
        {
          id: 'field_customer_name',
          source: {
            nodeId: 'node_customer',
            modelId: 'Customer',
            fieldId: 'name',
          },
          outputName: 'customerName',
          visible: true,
        },
        {
          id: 'field_order_status',
          source: {
            nodeId: 'node_order',
            modelId: 'Order',
            fieldId: 'status',
          },
          outputName: 'orderStatus',
          visible: true,
        },
      ],
    },
    result: {
      shape: 'tree',
      includesRecordRefs: true,
      schema: [
        {
          name: 'customerName',
          type: 'string',
          nullable: false,
          source: {
            nodeId: 'node_customer',
            modelId: 'Customer',
            fieldId: 'name',
          },
        },
        {
          name: 'orders',
          type: 'json',
          nullable: false,
          children: [
            {
              name: 'orderStatus',
              type: 'string',
              nullable: true,
              source: {
                nodeId: 'node_order',
                modelId: 'Order',
                fieldId: 'status',
              },
            },
          ],
        },
      ],
    },
  },
  dependencies: {
    models: ['Customer', 'Order'],
    fields: ['Customer.name', 'Order.status'],
    relations: ['Customer.orders'],
  },
  lifecycle: {
    createdAt: now,
    updatedAt: now,
  },
};
