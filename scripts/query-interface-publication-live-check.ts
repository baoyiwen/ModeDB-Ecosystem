import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RemoteModelDBClient } from '@mode-db/sdk';
import {
  ensureDesignerCatalog,
  SYS_QUERY_INTERFACE,
} from '../apps/model-designer/src/bootstrap/designer-storage-init.js';
import {
  EMPTY_QUERY_CHAIN_STATE,
  customerOrdersQueryFixture,
  publishQueryInterface,
  queryInterfacePublicationSignature,
} from '../apps/model-designer/src/query-designer/index.js';
import type { EngineModelNode } from '../apps/model-designer/src/types/engine-schema.js';
import type { PublishedQueryExecutionTemplate } from '@mode-db/sdk';
import {
  listQueryInterfaceRegistry,
  upsertQueryInterfaceRegistry,
} from '../apps/model-designer/src/sync/query-interface-registry.js';

const configPath = resolve(process.argv[2] ?? 'modeldb.config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
  host?: string;
  port?: number;
  connectToken?: string;
};
if (!config.connectToken) {
  throw new Error('ModelDB config does not contain connectToken.');
}

const client = await RemoteModelDBClient.connectNetwork({
  host: config.host ?? '127.0.0.1',
  port: config.port ?? 9090,
  token: config.connectToken,
  database: 'model_designer_workspace',
  mode: 'short',
});
const id = `__query_publication_check_${Date.now()}`;
const libraryCode = id;
try {
  await ensureDesignerCatalog(client);
  await cleanupPublicationChecks();
  const draft = structuredClone(customerOrdersQueryFixture);
  draft.id = id;
  const publication = publishQueryInterface({
    queryInterface: draft,
    signature: queryInterfacePublicationSignature(draft),
    executionTemplate: template(),
    models: publicationModels(),
  });
  if (!publication.ok) {
    throw new Error(publication.issues.map((issue) => issue.message).join('; '));
  }
  assert.equal(publication.ok, true);
  await upsertQueryInterfaceRegistry(client, libraryCode, {
    id,
    name: 'Publication live check',
    queryInterface: publication.queryInterface,
    queryChain: EMPTY_QUERY_CHAIN_STATE,
    createdAt: publication.release.publishedAt,
    updatedAt: publication.release.publishedAt,
    publishedRelease: publication.release,
  });
  const restored = await listQueryInterfaceRegistry(client, libraryCode);
  assert.equal(restored.length, 1);
  assert.equal(restored[0]?.publishedRelease?.version, publication.release.version);
  assert.equal(restored[0]?.publishedRelease?.callableName, publication.release.callableName);
  assert.equal(restored[0]?.publishedRelease?.queryInterface.status, 'active');
  await upsertQueryInterfaceRegistry(client, libraryCode, {
    ...restored[0]!,
    name: 'Publication live check updated',
    updatedAt: new Date().toISOString(),
  });
  const updated = await listQueryInterfaceRegistry(client, libraryCode);
  assert.equal(updated.length, 1);
  assert.equal(updated[0]?.name, 'Publication live check updated');
  console.log(
    JSON.stringify({
      ok: true,
      database: 'model_designer_workspace',
      releaseVersion: restored[0]?.publishedRelease?.version,
      callableName: restored[0]?.publishedRelease?.callableName,
      logicalUpsert: true,
    }),
  );
} finally {
  await cleanupPublicationChecks().catch(() => undefined);
  client.close();
}

async function cleanupPublicationChecks(): Promise<void> {
  const raw = await client.model(SYS_QUERY_INTERFACE).query().execute();
  const deletes = (Array.isArray(raw) ? raw : [])
    .map((row) => {
      if (!row || typeof row !== 'object' || !('getData' in row)) {
        return undefined;
      }
      const getData = (row as { getData?: unknown }).getData;
      if (typeof getData !== 'function') {
        return undefined;
      }
      const data = getData.call(row) as Record<string, unknown>;
      return typeof data._id === 'string' &&
        typeof data.library_code === 'string' &&
        data.library_code.startsWith('__query_publication_check_')
        ? { model: SYS_QUERY_INTERFACE, id: data._id }
        : undefined;
    })
    .filter((entry): entry is { model: string; id: string } => Boolean(entry));
  if (deletes.length > 0) {
    await client.batchDelete(deletes, { sync: true });
  }
}

function publicationModels(): EngineModelNode[] {
  return [
    {
      id: 'Customer',
      model_name: 'Customer',
      parent_id: null,
      props_objects_array: [field('name')],
    },
    {
      id: 'Order',
      model_name: 'Order',
      parent_id: null,
      props_objects_array: [field('status')],
    },
  ];
}

function field(name: string): EngineModelNode['props_objects_array'][number] {
  return { id: name, name, type: 'string', is_primary: false, encrypt_level: 0, metadata: {} };
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
    resultAdapter: {
      kind: 'rows',
      rootNodeId: 'node_customer',
      fieldsByNode: {},
      edgesBySource: {},
    },
    pagination: { mode: 'none' },
  };
}
