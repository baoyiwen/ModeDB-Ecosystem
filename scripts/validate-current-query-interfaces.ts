import { RemoteModelDBClient } from '@mode-db/sdk';
import { listQueryInterfaceRegistry } from '../apps/model-designer/src/sync/query-interface-registry.js';

const token = process.env.MODEDB_TEST_TOKEN?.trim();
if (!token) {
  throw new Error('MODEDB_TEST_TOKEN is required');
}

const designerClient = await RemoteModelDBClient.connectNetwork({
  host: '127.0.0.1',
  port: 9091,
  token,
  database: 'model_designer_workspace',
  mode: 'short',
});
const businessClient = await RemoteModelDBClient.connectNetwork({
  host: '127.0.0.1',
  port: 9091,
  token,
  database: 'railway_operations_demo',
  mode: 'short',
});

try {
  const registry = await listQueryInterfaceRegistry(designerClient, 'railway_operations_demo');
  const results = [];
  for (const record of registry) {
    const release = record.publishedRelease;
    if (!release) {
      continue;
    }
    const response = await businessClient.invokeQueryInterface(release.callableName, {
      version: release.version,
      parameters: {},
    });
    results.push({
      name: record.name,
      callableName: release.callableName,
      version: response.version,
      rowCount: response.rows.length,
      firstRow: response.rows[0] ?? null,
      nextCursor: response.nextCursor ?? null,
    });
  }
  console.log(JSON.stringify({ ok: true, interfaces: results }, null, 2));
} finally {
  designerClient.close();
  businessClient.close();
}
