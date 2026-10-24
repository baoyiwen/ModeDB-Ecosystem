import assert from 'node:assert/strict';
import { it } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { securityReleaseDigest } from '@mode-db/shared';
import { designerAssetRows } from '@mode-db/core';
import { ensureModelDbLayoutAtRoot } from '../../packages/server/src/modeldb-default-home.js';
import { loadModelDBServerConfig } from '../../packages/server/src/config-loader.js';
import { buildDualTrackFastify } from '../../packages/server/src/dual-track-app.js';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';
import { LocalVaultKeyProvider } from '../../packages/server/src/security/local-vault-key-provider.js';
import { callLocalSecurity } from '../../packages/server/src/security/local-management-channel.js';
import {
  openAnyAssetPackage,
  sealDesignerAssetPackage,
} from '../../packages/server/src/security/asset-package.js';
import { backupRecipientId } from '../../packages/server/src/security/backup-package.js';
import {
  importDesignerAsset,
  previewDesignerAssetImport,
} from '../../packages/server/src/designer-asset-transfer.js';
import { designerFixture } from '../fixtures/security-designer-asset.js';
import {
  browserPath,
  delay,
  serveDesigner,
  startBrowser,
  waitFor,
  type BrowserPage,
} from '../helpers/security-browser.js';

it(
  'reviews an imported asset in Chrome, republishes it, and requires a fresh target release grant',
  { skip: process.platform !== 'win32' || !existsSync(browserPath), timeout: 300000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'modedb-asset-browser-'));
    let app: Awaited<ReturnType<typeof buildDualTrackFastify>> | undefined;
    let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
    let served: Awaited<ReturnType<typeof serveDesigner>> | undefined;
    try {
      const configPath = ensureModelDbLayoutAtRoot(root),
        securityDirectory = join(root, 'security');
      const registry = SecurityRegistry.open(securityDirectory);
      const source = designerFixture(false),
        receiver = generateKeyPairSync('rsa', { modulusLength: 3072 }),
        publisher = generateKeyPairSync('rsa', { modulusLength: 3072 });
      const bytes = sealDesignerAssetPackage(
        source.graph,
        source.designer,
        {
          assetId: 'synthetic-browser-asset',
          assetVersion: '1.0.0',
          sourceInstanceId: 'synthetic-source',
        },
        receiver.publicKey,
        publisher.privateKey,
      );
      const content = openAnyAssetPackage(
        bytes,
        receiver.privateKey,
        publisher.publicKey,
        backupRecipientId(publisher.publicKey),
      );
      assert.equal(content.version, 2);
      const sourceRelease = JSON.parse(
        String(designerAssetRows(source.workspace, 'sys_query_interface')[0]!.release_json),
      );
      const principal = registry.createPrincipal('synthetic-asset-client');
      const oldCredential = registry.createCredential(principal.id, 'stale-source-release', [
        {
          database: 'received',
          resource: '*',
          actions: ['callable.query'],
          releaseDigest: securityReleaseDigest(sourceRelease),
        },
      ]);
      const emptyCredential = registry.createCredential(principal.id, 'no-grants', []);
      const input = {
        content: content as Parameters<typeof importDesignerAsset>[0]['content'],
        storageRoot: join(root, 'vault'),
        database: 'received',
        instanceId: registry.status().instanceId,
        designerWorkspace: 'model_designer_workspace',
        securityDirectory,
        registry,
        provider: new LocalVaultKeyProvider(securityDirectory),
      };
      let imported: ReturnType<typeof importDesignerAsset>;
      try {
        imported = importDesignerAsset({
          ...input,
          confirmationDigest: previewDesignerAssetImport(input).confirmationDigest,
        });
      } finally {
        registry.close();
      }
      assert.equal(imported.published, true);
      const cfg = await loadModelDBServerConfig(configPath, { port: 0 });
      app = await buildDualTrackFastify(cfg);
      const address = app.server.address();
      assert.ok(address && typeof address === 'object');
      const api = `http://127.0.0.1:${address.port}`;
      const invoke = async (
        token: string,
        name: string,
        database = 'received',
        operation: object = { op: 'executeInterface', callableName: name, parameters: {} },
      ) => {
        const response = await fetch(api + '/api/v1/rpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
          body: JSON.stringify({ version: 1, database, operation }),
        });
        return { status: response.status, body: (await response.json()) as any };
      };
      assert.equal(
        (await invoke(oldCredential.token, 'Imported_Query')).status,
        403,
        'imported release rejects stale source authorization',
      );
      served = await serveDesigner();
      browser = await startBrowser(root);
      const page: BrowserPage = browser.page;
      const launch = (await callLocalSecurity(securityDirectory, {
        action: 'browser.launch',
        origin: served.origin,
        databases: ['received'],
      })) as { code: string };
      await page.call('Page.navigate', {
        url:
          served.origin +
          '/#' +
          new URLSearchParams({ 'modeldb-pair': launch.code, 'modeldb-server': api }),
      });
      await waitFor(
        () =>
          page.evaluate<boolean>(
            `!!document.querySelector('.designer-connection-card select') && !location.hash.includes('modeldb-pair')`,
          ),
        Boolean,
      );
      await waitFor(
        () =>
          page.evaluate<boolean>(
            `[...document.querySelector('.designer-connection-card select').options].some(o=>o.value==='received')`,
          ),
        Boolean,
      );
      assert.equal(
        await page.evaluate<boolean>(
          `(() => { const s=document.querySelector('.designer-connection-card select'); if(![...s.options].some(o=>o.value==='received')) return false; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'received'); s.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`,
        ),
        true,
      );
      await delay(200);
      await page.evaluate(
        `(() => { [...document.querySelectorAll('button')].find(b=>/Open library|打开图谱|打开库|打开画布/.test(b.textContent||'')).click(); })()`,
      );
      const connected = `!![...document.querySelectorAll('button')].find(b=>/Disconnect|断开连接/.test((b.textContent||'')+' '+(b.title||'')))`;
      await waitFor(() => page.evaluate<boolean>(connected), Boolean, 60000);
      const rpc = async (operation: object) =>
        page.evaluate<any>(
          `(async()=>{ const s=await fetch(${JSON.stringify(api + '/api/v1/security/session')},{credentials:'include'}).then(r=>r.json()); const r=await fetch(${JSON.stringify(api + '/api/v1/rpc')},{method:'POST',credentials:'include',headers:{'content-type':'application/json','x-modeldb-csrf':s.csrf},body:JSON.stringify({version:1,database:'model_designer_workspace',operation:${JSON.stringify(operation)}})}); return {status:r.status,body:await r.json()}; })()`,
        );
      await page.evaluate(
        `(() => { [...document.querySelectorAll('button')].find(b=>/Interface manager|接口管理/.test(b.title||'')).click(); })()`,
      );
      await waitFor(
        () => page.evaluate<boolean>(`!!document.querySelector('.query-interface-doc-summary')`),
        Boolean,
      );
      await page.evaluate(`document.querySelector('.query-interface-doc-summary').click()`);
      assert.equal(
        await page.evaluate<boolean>(
          `document.querySelector('.query-interface-doc-card').textContent.includes('Imported Query')`,
        ),
        true,
      );
      // Review the actual imported model/field projection and disabled policy in the editor.
      await page.evaluate(`document.querySelector('.query-interface-doc-actions button').click()`);
      console.log('[asset-browser] opened imported interface editor');
      await waitFor(
        () => page.evaluate<boolean>(`document.querySelectorAll('.query-designer-tab').length===5`),
        Boolean,
      );
      await page.evaluate(`document.querySelectorAll('.query-designer-tab')[3].click()`);
      await waitFor(
        () => page.evaluate<boolean>(`!!document.querySelector('.query-interface-access-modes')`),
        Boolean,
      );
      assert.equal(
        await page.evaluate<number>(
          `[...document.querySelector('.query-interface-access-modes').children].findIndex(b=>b.dataset.active==='true')`,
        ),
        2,
      );
      await page.evaluate(`document.querySelector('.query-interface-access-modes button').click()`);
      await delay(200);
      await page.evaluate(
        `(() => { [...document.querySelectorAll('button')].find(b=>/保存接口/.test(b.textContent||'')).click(); })()`,
      );
      await delay(400);
      await page.evaluate(
        `(() => { const b=[...document.querySelectorAll('button')].find(b=>/Interface manager|接口管理/.test(b.title||'')); b.click(); })()`,
      );
      await waitFor(
        () => page.evaluate<boolean>(`!!document.querySelector('.query-interface-doc-summary')`),
        Boolean,
      );
      await page.evaluate(`document.querySelector('.query-interface-doc-summary').click()`);
      await waitFor(
        () => page.evaluate<boolean>(`!!document.querySelector('[data-action=publish]')`),
        Boolean,
      );
      await page.evaluate(`document.querySelector('[data-action=publish]').click()`);
      await delay(500);
      console.log(
        '[asset-browser] imported disabled policy reviewed and target release published through UI',
      );
      // Read the target release through the authorized browser session for exact digest binding.
      const rows = await rpc({
        op: 'executeQuery',
        snapshot: {
          plan: {
            version: 2,
            originModel: 'sys_query_interface',
            start: { kind: 'all' },
            hops: [],
            trailing: { type: 'group', logic: 'AND', children: [] },
          },
          execute: {},
          analysis: { groupBy: null, compute: null },
        },
      });
      console.log(
        '[asset-browser] target row response status',
        rows.status,
        Object.keys(rows.body),
      );
      assert.equal(rows.status, 200);
      assert.equal(rows.body.result.rows.length, 1);
      const targetRow = rows.body.result.rows[0].data;
      const release = JSON.parse(targetRow.release_json);
      assert.equal(release.queryInterface.status, 'active');
      assert.equal(release.queryInterface.contract.permissions.mode, 'none');
      assert.notEqual(release.signature, '');
      assert.notEqual(securityReleaseDigest(release), securityReleaseDigest(sourceRelease));
      assert.equal((await invoke(oldCredential.token, release.callableName)).status, 403);
      assert.equal((await invoke(emptyCredential.token, release.callableName)).status, 403);
      const granted = (await callLocalSecurity(securityDirectory, {
        action: 'credential.create',
        principalId: principal.id,
        name: 'reviewed-target-release',
        grants: [
          {
            database: 'received',
            resource: release.callableName,
            actions: ['callable.query'],
            releaseDigest: securityReleaseDigest(release),
          },
        ],
      })) as { token: string; credential: { id: string } };
      const allowed = await invoke(granted.token, release.callableName);
      assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
      assert.equal(allowed.body.result.rows.length, 1);
      assert.equal(allowed.body.result.rows[0].label, 'Synthetic imported data');
      assert.equal((await invoke(granted.token, release.callableName, 'other')).status, 403);
      assert.equal(
        (
          await invoke(granted.token, release.callableName, 'received', {
            op: 'executeQuery',
            snapshot: release.executionTemplate.snapshot,
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await invoke(granted.token, release.callableName, 'model_designer_workspace', {
            op: 'executeQuery',
            snapshot: release.executionTemplate.snapshot,
          })
        ).status,
        403,
      );
      await callLocalSecurity(securityDirectory, {
        action: 'credential.revoke',
        id: granted.credential.id,
      });
      assert.equal((await invoke(granted.token, release.callableName)).status, 401);
      console.log(
        '[asset-browser] target release grant, projected data, cross-database/raw/system refusal and revocation passed',
      );
      await page.call('Page.reload', { ignoreCache: true });
      try {
        await waitFor(() => page.evaluate<boolean>(connected), Boolean, 120000);
      } catch (error) {
        console.log(
          '[asset-browser] reload UI',
          await page.evaluate<string>(`document.body.innerText.slice(0,1800)`),
        );
        throw error;
      }
      assert.deepEqual(page.exceptions, []);
    } finally {
      browser?.page.close();
      browser?.chrome.kill();
      if (served) await new Promise<void>((done) => served!.server.close(() => done()));
      if (app) await app.close();
      await delay(300);
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);
