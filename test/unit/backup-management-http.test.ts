import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { AuthoringEngine } from '@mode-db/core';
import { buildDualTrackFastify } from '../../packages/server/src/dual-track-app.js';

it('supports named backups and validation across the management HTTP workflow', async () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-backup-http-'));
  const engine = new AuthoringEngine({
    atlas: 'graph',
    storageRoot: root,
    connectToken: 'fixture-token',
  });
  engine.registerModel('Item', { label: 'String' });
  await engine.insert('Item', { label: 'before backup' }, { sync: true });
  await engine.flushAll();
  const app = await buildDualTrackFastify({
    host: '127.0.0.1',
    port: 0,
    storageRoot: root,
    designerWorkspace: 'designer',
    connectToken: 'fixture-token',
    dev: false,
    configFilePath: join(root, 'config.json'),
  });
  const headers = { 'x-modeldb-connect-token': 'fixture-token' };
  try {
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/management/databases/graph/backup',
      payload: { name: 'test' },
    });
    assert.equal(denied.statusCode, 401);
    for (const name of ['', 'a\nb', 'x'.repeat(121), 5]) {
      const invalid = await app.inject({
        method: 'POST',
        url: '/api/v1/management/databases/graph/backup',
        headers,
        payload: { name },
      });
      assert.equal(invalid.statusCode, 400, invalid.body);
    }
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/management/databases/graph/backup',
      headers,
      payload: { name: '上线前快照', reason: 'manual' },
    });
    assert.equal(created.statusCode, 200, created.body);
    const backup = created.json().backup;
    assert.equal(backup.name, '上线前快照');
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/management/backups?database=graph',
      headers,
    });
    assert.equal(listed.json().backups[0].name, backup.name);
    const downloaded = await app.inject({
      method: 'GET',
      url: `/api/v1/management/backups/${backup.fileName}/download`,
      headers,
    });
    assert.equal(downloaded.statusCode, 200, downloaded.body);
    assert.equal(JSON.parse(downloaded.body).name, backup.name);
    const imported = await app.inject({
      method: 'POST',
      url: `/api/v1/management/backups/import?fileName=${backup.fileName}`,
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: downloaded.rawPayload,
    });
    assert.equal(imported.statusCode, 200, imported.body);
    assert.equal(imported.json().backup.name, backup.name);
    assert.notEqual(imported.json().backup.fileName, backup.fileName);
    const restored = await app.inject({
      method: 'POST',
      url: '/api/v1/management/databases/graph/restore',
      headers,
      payload: { backupFile: backup.fileName },
    });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(restored.json().restored.name, backup.name);
    assert.ok(restored.json().safetyBackup.fileName);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
