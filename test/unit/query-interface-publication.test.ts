import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  appendExecutableReleaseHistory,
  assessQueryInterfaceReleaseImpact,
  customerOrdersQueryFixture,
  deprecateQueryInterfaceRelease,
  nextDraftInterface,
  publishQueryInterface,
  queryInterfacePublicationSignature,
} from '../../apps/model-designer/src/query-designer/index.js';
import type { EngineModelNode } from '../../apps/model-designer/src/types/engine-schema.js';
import type { PublishedQueryExecutionTemplate } from '@mode-db/sdk';

const now = '2026-07-21T10:00:00.000Z';
const models: EngineModelNode[] = [
  model('Customer', 'Customer', [field('name', 'name')]),
  model('Order', 'Order', [field('status', 'status')]),
];

describe('QueryInterface publication', () => {
  it('publishes a validated draft as an immutable active release', () => {
    const draft = structuredClone(customerOrdersQueryFixture);
    const signature = queryInterfacePublicationSignature(draft);
    const result = publishQueryInterface({
      queryInterface: draft,
      signature,
      executionTemplate: template(),
      models,
      now,
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.queryInterface.status, 'active');
    assert.equal(result.queryInterface.version.compatibility, 'compatible');
    assert.equal(result.queryInterface.lifecycle.publishedAt, now);
    assert.equal(result.release.version, '0.1.0');
    assert.notEqual(result.release.queryInterface, result.queryInterface);
  });

  it('rejects a callable name already used by another active release', () => {
    const draft = structuredClone(customerOrdersQueryFixture);
    const signature = queryInterfacePublicationSignature(draft);
    const first = publishQueryInterface({
      queryInterface: draft,
      signature,
      executionTemplate: template(),
      models,
      now,
    });
    assert.equal(first.ok, true);
    if (!first.ok) {
      return;
    }

    const result = publishQueryInterface({
      queryInterface: { ...draft, id: 'another_query' },
      signature,
      executionTemplate: template(),
      models,
      otherReleases: [first.release],
      now,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.issues.some((issue) => issue.code === 'publication_callable_name_conflict'),
        true,
      );
    }
  });

  it('keeps the published release while edits become a new draft version', () => {
    const original = structuredClone(customerOrdersQueryFixture);
    const first = publishQueryInterface({
      queryInterface: original,
      signature: queryInterfacePublicationSignature(original),
      executionTemplate: template(),
      models,
      now,
    });
    assert.equal(first.ok, true);
    if (!first.ok) {
      return;
    }
    const edited = {
      ...first.queryInterface,
      description: 'Adds an interface description.',
    };
    const draft = nextDraftInterface(edited, first.release, '2026-07-21T11:00:00.000Z');

    assert.equal(draft.status, 'draft');
    assert.equal(draft.version.current, '0.1.1');
    assert.equal(first.release.queryInterface.description, undefined);

    const republished = publishQueryInterface({
      queryInterface: draft,
      signature: queryInterfacePublicationSignature(draft),
      executionTemplate: template(),
      models,
      existingRelease: first.release,
      now: '2026-07-21T12:00:00.000Z',
    });
    assert.equal(republished.ok, true);
    if (republished.ok) {
      assert.equal(republished.release.version, '0.1.1');
      assert.deepEqual(
        republished.queryInterface.version.history?.map((entry) => entry.version),
        ['0.1.0'],
      );
    }
  });

  it('uses a minor version for additive optional parameters', () => {
    const published = publishFixture();
    const draft = nextDraftInterface(
      {
        ...published.queryInterface,
        contract: {
          ...published.queryInterface.contract,
          parameters: [
            ...published.queryInterface.contract.parameters,
            {
              id: 'parameter_region',
              name: 'region',
              type: 'string',
              required: false,
            },
          ],
        },
      },
      published.release,
      '2026-07-21T11:00:00.000Z',
    );

    const impact = assessQueryInterfaceReleaseImpact(draft, published.release);
    const result = publishQueryInterface({
      queryInterface: draft,
      signature: queryInterfacePublicationSignature(draft),
      executionTemplate: template(),
      models,
      existingRelease: published.release,
      now: '2026-07-21T12:00:00.000Z',
    });

    assert.equal(impact.level, 'minor');
    assert.equal(impact.recommendedVersion, '0.2.0');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.release.version, '0.2.0');
      assert.equal(result.queryInterface.version.compatibility, 'compatible');
    }
  });

  it('uses a major version and breaking marker for required input changes', () => {
    const published = publishFixture();
    const draft = nextDraftInterface(
      {
        ...published.queryInterface,
        contract: {
          ...published.queryInterface.contract,
          parameters: published.queryInterface.contract.parameters.map((parameter) => ({
            ...parameter,
            required: true,
          })),
        },
      },
      published.release,
      '2026-07-21T11:00:00.000Z',
    );

    const impact = assessQueryInterfaceReleaseImpact(draft, published.release);
    const result = publishQueryInterface({
      queryInterface: draft,
      signature: queryInterfacePublicationSignature(draft),
      executionTemplate: template(),
      models,
      existingRelease: published.release,
      now: '2026-07-21T12:00:00.000Z',
    });

    assert.equal(impact.level, 'major');
    assert.equal(impact.recommendedVersion, '1.0.0');
    assert.equal(
      impact.changes.some((change) => change.code === 'parameter_required'),
      true,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.release.version, '1.0.0');
      assert.equal(result.queryInterface.version.compatibility, 'breaking');
    }
  });

  it('reports removed nested output fields as breaking changes', () => {
    const published = publishFixture();
    const draft = structuredClone(published.queryInterface);
    draft.query.result.schema[1]!.children = [];

    const impact = assessQueryInterfaceReleaseImpact(draft, published.release);

    assert.equal(impact.level, 'major');
    assert.equal(impact.recommendedVersion, '1.0.0');
    assert.deepEqual(
      impact.changes.filter((change) => change.code === 'result_field_removed'),
      [{ code: 'result_field_removed', level: 'major', subject: 'orders.orderStatus' }],
    );
  });

  it('deprecates a release without deleting its snapshot', () => {
    const draft = structuredClone(customerOrdersQueryFixture);
    const published = publishQueryInterface({
      queryInterface: draft,
      signature: queryInterfacePublicationSignature(draft),
      executionTemplate: template(),
      models,
      now,
    });
    assert.equal(published.ok, true);
    if (!published.ok) {
      return;
    }

    const deprecated = deprecateQueryInterfaceRelease(
      published.release,
      '2026-07-21T13:00:00.000Z',
    );
    assert.equal(deprecated.queryInterface.status, 'deprecated');
    assert.equal(deprecated.queryInterface.lifecycle.deprecatedAt, '2026-07-21T13:00:00.000Z');
    assert.equal(deprecated.callableName, published.release.callableName);
  });

  it('archives complete executable releases without duplicating a version', () => {
    const draft = structuredClone(customerOrdersQueryFixture);
    const published = publishQueryInterface({
      queryInterface: draft,
      signature: queryInterfacePublicationSignature(draft),
      executionTemplate: template(),
      models,
      now,
    });
    assert.equal(published.ok, true);
    if (!published.ok) {
      return;
    }

    const history = appendExecutableReleaseHistory(
      appendExecutableReleaseHistory(undefined, published.release),
      published.release,
    );

    assert.equal(history.length, 1);
    assert.equal(history[0]?.version, '0.1.0');
    assert.notEqual(history[0], published.release);
    assert.equal(history[0]?.executionTemplate.format, 1);
  });

  it('rejects invalid interface rate-limit policies before publication', () => {
    const draft = structuredClone(customerOrdersQueryFixture);
    draft.contract.permissions = {
      mode: 'none',
      rateLimit: { maxRequests: 0, windowSeconds: 60 },
    };
    const result = publishQueryInterface({
      queryInterface: draft,
      signature: queryInterfacePublicationSignature(draft),
      executionTemplate: template(),
      models,
      now,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.issues.some((issue) => issue.code === 'invalid_interface_rate_limit_requests'),
        true,
      );
    }
  });
});

function model(
  id: string,
  name: string,
  props: EngineModelNode['props_objects_array'],
): EngineModelNode {
  return { id, model_name: name, parent_id: null, props_objects_array: props };
}

function field(
  id: string,
  name: string,
): EngineModelNode['props_objects_array'][number] {
  return { id, name, type: 'string', is_primary: false, encrypt_level: 0, metadata: {} };
}

function template(): PublishedQueryExecutionTemplate {
  return {
    format: 1,
    snapshot: {
      plan: {
        version: 2,
        originModel: 'Customer',
        start: { kind: 'all' },
        hops: [],
        trailing: { type: 'group', logic: 'AND', children: [] },
      },
      execute: {},
      analysis: { groupBy: null, compute: null },
    },
    parameters: [],
    resultAdapter: { kind: 'rows', rootNodeId: 'node_customer', fieldsByNode: {}, edgesBySource: {} },
    pagination: { mode: 'none' },
  };
}

function publishFixture(): Extract<
  ReturnType<typeof publishQueryInterface>,
  { ok: true }
> {
  const draft = structuredClone(customerOrdersQueryFixture);
  const result = publishQueryInterface({
    queryInterface: draft,
    signature: queryInterfacePublicationSignature(draft),
    executionTemplate: template(),
    models,
    now,
  });
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error('Expected fixture publication to succeed.');
  }
  return result;
}
