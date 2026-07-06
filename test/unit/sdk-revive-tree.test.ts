import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { RemoteHydratedEntity, RemoteModelDBClient } from '@mode-db/sdk';
import { deriveWireSessionKey, encodeWirePayload, type WireExecuteResultJson } from '@mode-db/shared';

const originalFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = originalFetch;
});

describe('RemoteModelDBClient tree revive', () => {
  it('keeps wire relates when chain.execute() revives rows', async () => {
    const token = 'tree-token';
    const dbName = 'tree-db';
    const sessionKey = deriveWireSessionKey(token, dbName);
    const wireResult: WireExecuteResultJson = {
      kind: 'rows',
      rows: [
        {
          model: 'Node',
          data: { _id: 'root', _createdAt: '2026-07-03T00:00:00.000Z', code: 'root' },
          relates: {
            children: [
              {
                model: 'Node',
                data: {
                  _id: 'child',
                  _createdAt: '2026-07-03T00:00:00.000Z',
                  code: 'child',
                },
              },
            ],
          },
        },
      ],
    };

    const jsonResponse = (body: unknown, ok = true): Response =>
      ({
        ok,
        status: ok ? 200 : 404,
        async json() {
          return body;
        },
        async text() {
          return JSON.stringify(body);
        },
      }) as Response;

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith('/health')) {
        return jsonResponse({ ok: true });
      }
      if (url.endsWith('/v2/action')) {
        const request = JSON.parse(String(init?.body ?? '{}')) as { id?: string };
        const cipher = encodeWirePayload(JSON.stringify(wireResult), sessionKey);
        return jsonResponse({ type: 'rpc.ok', id: request.id, cipher });
      }
      return jsonResponse({ error: 'not found' }, false);
    }) as typeof fetch;

    const client = await RemoteModelDBClient.connect({
      url: 'http://127.0.0.1:5179',
      token,
      dbName,
      mode: 'short',
    });
    const rows = (await client.model('Node').query().children('children').execute()) as unknown[];
    assert.equal(rows.length, 1);
    assert.ok(rows[0] instanceof RemoteHydratedEntity);

    const tree = (rows[0] as RemoteHydratedEntity).toTree();
    const children = tree.children as Record<string, unknown>[] | undefined;
    assert.equal(children?.[0]?.code, 'child');
  });
});
