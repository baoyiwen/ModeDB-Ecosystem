import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RemoteModelDBClient, WireQueryChain } from '@mode-db/sdk';

const configPath = resolve(process.argv[2] ?? 'modeldb.config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
  host?: string;
  port?: number;
  connectToken?: string;
};
if (!config.connectToken) {
  throw new Error('ModelDB config does not contain connectToken.');
}

const host = config.host ?? '127.0.0.1';
const port = config.port ?? 9090;
const token = config.connectToken;
const executeMode = process.argv.includes('--execute');

if (executeMode) {
  const database = `__query_wire_check_${Date.now()}`;
  let client: RemoteModelDBClient | undefined;
  try {
    await RemoteModelDBClient.createDatabase({ host, port, token, name: database });
    client = await RemoteModelDBClient.connectNetwork({
      host,
      port,
      token,
      database,
      mode: 'short',
    });
    await client.registerModel('Item', {
      group: 'String',
      category: 'String',
      score: 'Int',
    });
    const inserted = await client.model('Item').insertMany(
      [
        { group: 'A', category: 'x', score: 2 },
        { group: 'A', category: 'x', score: 1 },
        { group: 'B', category: 'x', score: 10 },
        { group: 'B', category: 'y', score: 0 },
      ],
      { sync: true },
    );
    const result = (await client
      .model('Item')
      .query()
      .groupBy(['group'])
      .compute({ score: 'sum', category: 'countDistinct' })
      .having({ type: 'atom', field: 'score', op: 'gt', value: 4 })
      .execute()) as { kind?: string; rows?: readonly Record<string, unknown>[] };
    const rows = result.rows ?? [];
    if (
      inserted.successCount !== 4 ||
      result.kind !== 'analysis' ||
      rows.length !== 1 ||
      rows[0]?.group !== 'B' ||
      rows[0]?.score !== 10 ||
      rows[0]?.category !== 2
    ) {
      throw new Error(`Live execution mismatch: ${JSON.stringify({ inserted, result })}`);
    }
    const cursorFirst = (await client
      .model('Item')
      .query()
      .orderBy('score', 'desc')
      .cursor()
      .limit(2)
      .execute()) as {
      items?: Array<{ getData(): Record<string, unknown> }>;
      nextCursor?: string;
    };
    if (cursorFirst.items?.length !== 2 || !cursorFirst.nextCursor) {
      throw new Error(`Cursor first page mismatch: ${JSON.stringify(cursorFirst)}`);
    }
    const cursorSecond = (await client
      .model('Item')
      .query()
      .orderBy('score', 'desc')
      .cursor(cursorFirst.nextCursor)
      .limit(2)
      .execute()) as {
      items?: Array<{ getData(): Record<string, unknown> }>;
      nextCursor?: string;
    };
    const cursorScores = [...(cursorFirst.items ?? []), ...(cursorSecond.items ?? [])].map(
      (item) => item.getData().score,
    );
    if (
      cursorSecond.items?.length !== 2 ||
      cursorSecond.nextCursor !== undefined ||
      JSON.stringify(cursorScores) !== JSON.stringify([10, 2, 1, 0])
    ) {
      throw new Error(`Cursor continuation mismatch: ${JSON.stringify({ cursorScores })}`);
    }
    await client.registerModel('Parent', { name: 'String' });
    await client.registerModel('Order', { category: 'String', amount: 'Int' });
    await client.registerRelation('Parent', 'Order', 'orders', 'parent', 'one-to-many');
    const parent = await client.model('Parent').insertOne({ name: 'P' }, { sync: true });
    const orderA = await client
      .model('Order')
      .insertOne({ category: 'X', amount: 2 }, { sync: true });
    const orderB = await client
      .model('Order')
      .insertOne({ category: 'X', amount: 3 }, { sync: true });
    await client.bindRelation(parent, orderA, 'orders', 'parent');
    await client.bindRelation(parent, orderB, 'orders', 'parent');
    const related = (await client
      .model('Parent')
      .query()
      .relate('orders')
      .groupBy(['category'])
      .compute({ amount: 'sum' })
      .execute()) as { kind?: string; rows?: readonly Record<string, unknown>[] };
    if (
      related.kind !== 'analysis' ||
      related.rows?.length !== 1 ||
      related.rows[0]?.category !== 'X' ||
      related.rows[0]?.amount !== 5
    ) {
      throw new Error(`Related aggregation mismatch: ${JSON.stringify(related)}`);
    }
    console.log(
      JSON.stringify({
        ok: true,
        mode: 'execute',
        protocols: [5, 6, 7],
        rows,
        relatedRows: related.rows,
        cursorScores,
      }),
    );
  } finally {
    client?.close();
    await RemoteModelDBClient.deleteDatabase({ host, port, token, name: database }).catch(() => {});
  }
  process.exit(0);
}

const databases = await RemoteModelDBClient.listDatabases({ host, port, token });
const database =
  databases.find((entry) => entry.name === 'model_designer_workspace')?.name ?? databases[0]?.name;
if (!database) {
  throw new Error('ModelDB service has no database available for the protocol probe.');
}

const client = await RemoteModelDBClient.connectNetwork({ host, port, token, database });
const snapshots = [
  new WireQueryChain('__ProtocolProbeMissingModelV5__', { kind: 'all' })
    .groupBy(['group'])
    .compute({ score: 'sum' })
    .having({ type: 'atom', field: 'score', op: 'gt', value: 4 })
    .getRemoteExecuteSnapshot(),
  new WireQueryChain('__ProtocolProbeMissingModelV6__', { kind: 'all' })
    .groupBy(['group'])
    .compute({ score: 'countDistinct' })
    .getRemoteExecuteSnapshot(),
  new WireQueryChain('__ProtocolProbeMissingModelV7__', { kind: 'all' })
    .cursor()
    .limit(2)
    .getRemoteExecuteSnapshot(),
];

try {
  for (const snapshot of snapshots) {
    try {
      await client.apply({ op: 'executeQuery', snapshot });
      throw new Error('Protocol probe unexpectedly found its sentinel model.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes('Unsupported query plan version') ||
        !message.includes('not registered')
      ) {
        throw error;
      }
    }
  }
  console.log(JSON.stringify({ ok: true, protocols: [5, 6, 7], database }));
} finally {
  client.close();
}
