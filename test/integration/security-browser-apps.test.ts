import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import type { WebSocket as WebSocketType } from 'ws';
import type { SecurityMaintenanceStatus, SecurityProtectionState } from '@mode-db/shared';
import { ensureModelDbLayoutAtRoot } from '../../packages/server/src/modeldb-default-home.js';
import { loadModelDBServerConfig } from '../../packages/server/src/config-loader.js';
import { buildDualTrackFastify } from '../../packages/server/src/dual-track-app.js';
import { callLocalSecurity } from '../../packages/server/src/security/local-management-channel.js';
import {
  customerOrdersQueryFixture,
  EMPTY_QUERY_CHAIN_STATE,
  queryInterfacePublicationSignature,
  type QueryInterfaceRelease,
} from '../../apps/model-designer/src/query-designer/index.js';

const browserPath = process.env.MODELDB_TEST_BROWSER ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const { WebSocket } = await import(new URL('../../packages/server/node_modules/ws/wrapper.mjs', import.meta.url).href) as typeof import('ws');
const workspace = fileURLToPath(new URL('../../', import.meta.url));
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout = 90000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await delay(150);
  }
  throw new Error('BROWSER_ACCEPTANCE_TIMEOUT');
}

async function serveApp(app: string): Promise<{ server: Server; origin: string }> {
  const root = process.env.MODELDB_TEST_APP_ROOT
    ? resolve(process.env.MODELDB_TEST_APP_ROOT, app)
    : resolve(workspace, 'apps', app, 'dist');
  assert.ok(existsSync(join(root, 'index.html')), 'Build all three applications before browser acceptance.');
  const server = createServer((request, response) => {
    void (async () => {
      const path = resolve(root, '.' + new URL(request.url ?? '/', 'http://local').pathname);
      const target = path === root ? join(root, 'index.html') : path;
      if (!target.startsWith(root + sep)) { response.writeHead(403).end(); return; }
      const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
      try {
        const body = await readFile(target);
        response.writeHead(200, { 'content-type': mime[extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
      } catch { response.writeHead(404).end(); }
    })();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

class BrowserPage {
  private counter = 0;
  private pending = new Map<number, { done: (value: any) => void; fail: (reason: Error) => void }>();
  readonly exceptions: string[] = [];
  constructor(private socket: WebSocketType) {
    socket.on('message', (bytes) => {
      const message = JSON.parse(bytes.toString());
      if (message.id) {
        const item = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) item?.fail(new Error('BROWSER_PROTOCOL_ERROR'));
        else item?.done(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(message.params.exceptionDetails.text);
      } else if (message.method === 'Page.javascriptDialogOpening') {
        console.log('[security-browser] dialog:', message.params.message.slice(0, 250));
        void this.call('Page.handleJavaScriptDialog', { accept: true });
      }
    });
  }
  call(method: string, params: object = {}): Promise<any> {
    const id = ++this.counter;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => { this.pending.delete(id); fail(new Error('BROWSER_COMMAND_TIMEOUT:' + method)); }, 15000);
      this.pending.set(id, { done: (value) => { clearTimeout(timer); done(value); }, fail: (error) => { clearTimeout(timer); fail(error); } });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.equal(response.exceptionDetails, undefined, 'Browser evaluation failed');
    return response.result.value as T;
  }
  close(): void { this.socket.close(); }
}

async function checkEntryLanguages(page: BrowserPage, entry: 'connection' | 'security' | 'forbidden'): Promise<void> {
  const root = entry === 'connection' ? '.designer-connection-flow' : '.security-center-workspace';
  const title = entry === 'connection' ? '.designer-connection-card h1'
    : entry === 'forbidden' ? '.security-center-access-state h2' : '.security-center-navigation-title strong';
  const titleKey = entry === 'connection' ? 'gateTitle'
    : entry === 'forbidden' ? 'securityCenterAccessRequired' : 'securityCenterTitle';
  const visualRoot = process.env.MODELDB_TEST_SCREENSHOTS_ROOT;
  if (visualRoot) mkdirSync(visualRoot, { recursive: true });
  for (const locale of ['en', 'zh', 'ja']) {
    const messages = JSON.parse(readFileSync(join(workspace, 'apps/model-designer/src/i18n/locales', locale, 'ui.json'), 'utf8')) as Record<string, string>;
    for (const width of [1280, 390]) {
      await page.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await page.evaluate(`(() => {
        const select = document.querySelector(${JSON.stringify(root + ' .designer-language-selector select')});
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(locale)});
        select.dispatchEvent(new Event('change',{bubbles:true}));
      })()`);
      await waitFor(() => page.evaluate<string>(`document.querySelector(${JSON.stringify(title)})?.textContent`), value => value === messages[titleKey]);
      assert.equal(await page.evaluate<string>(`localStorage.getItem('model-designer:locale')`), locale);
      assert.equal(await page.evaluate<string>(`document.querySelector(${JSON.stringify(root)}).lang`), locale);
      assert.equal(await page.evaluate<string>(`document.querySelector(${JSON.stringify(root + ' .designer-language-selector span')}).textContent`), messages.locale);
      assert.equal(await page.evaluate<boolean>(`(() => {
        const region=document.querySelector(${JSON.stringify(root)});
        const select=region.querySelector('.designer-language-selector select');
        const r=select.getBoundingClientRect();
        select.focus();
        return document.documentElement.scrollWidth<=innerWidth && region.scrollWidth<=region.clientWidth+1
          && r.left>=0 && r.right<=innerWidth+1 && document.activeElement===select
          && select.labels.length===1 && select.options.length===3;
      })()`), true, entry + ' localized layout and accessible language control');
      if (entry === 'forbidden') {
        const dimensions = await page.evaluate<{ viewport: number; heights: number[]; layout: string[] }>(`({
          viewport:innerHeight,
          heights:['.designer-security-center-workspace','.designer-panel-body--security-center','.security-center-workspace'].map(s=>document.querySelector(s).getBoundingClientRect().height),
          layout:['.designer-security-center-workspace','.designer-panel-body--security-center','.security-center-workspace'].map(s=>{const c=getComputedStyle(document.querySelector(s));return [c.height,c.maxHeight,c.flex,c.display,c.gridTemplateRows].join('/')})
        })`);
        assert.ok(dimensions.heights[2]! >= dimensions.viewport - 80, 'security drawer fills the editor height: ' + JSON.stringify(dimensions));
      }
      if (visualRoot) {
        const screenshot = await page.call('Page.captureScreenshot', { format: 'png' }) as { data: string };
        writeFileSync(join(visualRoot, `${entry}-${locale}-${width}.png`), Buffer.from(screenshot.data, 'base64'));
      }
    }
  }
  // Verify that switching display language also works when preference writes are blocked.
  await page.evaluate(`(() => {
    const original=Storage.prototype.setItem;
    Storage.prototype.setItem=function(){throw new Error('SYNTHETIC_STORAGE_BLOCKED')};
    try {
      const select=document.querySelector(${JSON.stringify(root + ' .designer-language-selector select')});
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'en');
      select.dispatchEvent(new Event('change',{bubbles:true}));
    } finally { Storage.prototype.setItem=original; }
  })()`);
  const english = JSON.parse(readFileSync(join(workspace, 'apps/model-designer/src/i18n/locales/en/ui.json'), 'utf8')) as Record<string, string>;
  await waitFor(() => page.evaluate<string>(`document.querySelector(${JSON.stringify(title)})?.textContent`), value => value === english[titleKey]);
  assert.equal(await page.evaluate<string>(`localStorage.getItem('model-designer:locale')`), 'ja', 'failed preference write keeps the old stored language');
  // Persist the default language for the rest of the existing acceptance flow.
  await page.evaluate(`(() => {
    const select=document.querySelector(${JSON.stringify(root + ' .designer-language-selector select')});
    select.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  assert.equal(await page.evaluate<string>(`localStorage.getItem('model-designer:locale')`), 'en');
  await page.call('Emulation.clearDeviceMetricsOverride');
  console.log(`[security-browser] ${entry}: zh/en/ja, wide/narrow layout, label/focus and blocked preference writes passed`);
}

it('three production browser apps pair through the Windows pipe, restore after reload and revoke on logout', {
  skip: process.platform !== 'win32' || !existsSync(browserPath), timeout: 600000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'modedb-browser-apps-'));
  let engine: Awaited<ReturnType<typeof buildDualTrackFastify>> | undefined;
  const servers: Server[] = [];
  let chrome: ReturnType<typeof spawn> | undefined;
  let page: BrowserPage | undefined;
  try {
    const cfg = await loadModelDBServerConfig(ensureModelDbLayoutAtRoot(root), { port: 0 });
    engine = await buildDualTrackFastify(cfg);
    const address = engine.server.address();
    assert.ok(address && typeof address === 'object');
    const api = `http://127.0.0.1:${address.port}`;
    const profile = join(root, 'browser-profile');
    chrome = spawn(browserPath, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    chrome.on('error', () => { /* Readiness timeout reports browser startup failure. */ });
    const devtools = join(profile, 'DevToolsActivePort');
    await waitFor(async () => existsSync(devtools), Boolean, 15000);
    const debugPort = readFileSync(devtools, 'utf8').split(/\r?\n/)[0];
    const target = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json()) as { webSocketDebuggerUrl: string };
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((done, reject) => { socket.once('open', done); socket.once('error', reject); });
    page = new BrowserPage(socket);
    await page.call('Runtime.enable');
    await page.call('Page.enable');
    await page.call('Network.enable');

    for (const app of ['model-designer', 'data-studio', 'web']) {
      const served = await serveApp(app);
      servers.push(served.server);
      await page.call('Network.clearBrowserCookies');
      const pairing = await callLocalSecurity(join(root, 'security'), { action: 'browser.launch', origin: served.origin, databases: ['graph'] }) as { code: string };
      // Create a real business database through the delegated cookie session.
      await page.call('Page.navigate', { url: served.origin });
      await waitFor(() => page!.evaluate<string>('document.readyState'), (v) => v === 'complete');
      if (app === 'model-designer') {
        await waitFor(() => page!.evaluate<boolean>(`!!document.querySelector('.designer-language-selector select')`), Boolean);
        await checkEntryLanguages(page, 'connection');
        assert.equal(await page.evaluate<boolean>(`!document.querySelector('.security-center-workspace') && !!document.querySelector('.designer-connection-card input[type=password]')`), true, 'language choice does not authenticate');
        await page.evaluate(`(() => {
          const select=document.querySelector('.designer-language-selector select');
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'ja');
          select.dispatchEvent(new Event('change',{bubbles:true}));
        })()`);
        await page.call('Page.reload', { ignoreCache: true });
        await waitFor(() => page!.evaluate<string>(`document.querySelector('.designer-language-selector select')?.value`), value => value === 'ja');
      }
      const bootstrap: number = await page.evaluate<number>(`(async () => {
        localStorage.clear();
        const paired = await fetch(${JSON.stringify(api + '/api/v1/security/pair')}, { method:'POST', credentials:'include', headers:{'content-type':'application/json'}, body:JSON.stringify({code:${JSON.stringify(pairing.code)}}) });
        const info = await paired.json();
        if (!paired.ok) return paired.status;
        if (${JSON.stringify(app)} !== 'model-designer') return 200;
        const created = await fetch(${JSON.stringify(api + '/api/v1/management/databases')}, { method:'POST', credentials:'include', headers:{'content-type':'application/json','x-modeldb-csrf':info.csrf}, body:JSON.stringify({name:'graph'}) });
        return created.status;
      })()`);
      assert.equal(bootstrap, 200, app + ' bootstrap');
      // Reproduce a returning user whose previous connection used a service Token.
      const authModeKey = app === 'model-designer' ? 'model-designer:authMode'
        : app === 'data-studio' ? 'data-studio:authMode' : 'modedb.playground.authMode';
      await page.evaluate(`localStorage.setItem(${JSON.stringify(authModeKey)}, 'token')`);
      // Use a new one-time code so the actual application performs its own exchange.
      const launch = await callLocalSecurity(join(root, 'security'), { action: 'browser.launch', origin: served.origin, databases: ['graph'] }) as { code: string };
      const fragment = new URLSearchParams({ 'modeldb-pair': launch.code, 'modeldb-server': api });
      await page.call('Page.navigate', { url: 'about:blank' });
      await page.call('Page.navigate', { url: `${served.origin}/#${fragment}` });
      const pairedState = await waitFor(() => page!.evaluate<{ clean: boolean; ready: boolean }>(`({ clean: !location.hash.includes('modeldb-pair'), ready: ${app === 'model-designer' ? "!!document.querySelector('.designer-connection-card select') && document.querySelectorAll('.designer-connection-card select').length > 0 && !document.querySelector('.designer-connection-card input[type=password]')" : app === 'data-studio' ? "!!document.querySelector('.studio-connect-card select.studio-input')" : "!!document.querySelector('.sidebar .tree') || !![...document.querySelectorAll('button')].find(b=>/Disconnect|断开连接/.test(b.textContent||''))"} })`), (v) => v.clean && v.ready);
      assert.equal(pairedState.clean, true);
      assert.equal(await page.evaluate<string>(`localStorage.getItem(${JSON.stringify(authModeKey)})`), 'browser', app + ' launcher overrides saved Token mode');
      if (app !== 'web') {
        const clicked: boolean = await page.evaluate<boolean>(`(() => {
          const select = document.querySelector(${JSON.stringify(app === 'model-designer' ? '.designer-connection-card select' : '.studio-connect-card select.studio-input')});
          const option = [...select.options].find(o=>o.value==='graph');
          if (!option) return false;
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'graph');
          select.dispatchEvent(new Event('change',{bubbles:true}));
          return true;
        })()`);
        assert.equal(clicked, true, app + ' library option');
        await delay(200);
        assert.equal(await page.evaluate<boolean>(`(() => { const b=[...document.querySelectorAll('button')].find(b=>/Open library|打开图谱|打开库|打开工作|进入设计|打开画布/.test(b.textContent||'')); if(!b) return false; b.click(); return true; })()`), true, app + ' open button');
      }
      const connected = `!![...document.querySelectorAll('button')].find(b=>/Disconnect|断开连接/.test((b.textContent||'')+' '+(b.title||'')))`;
      await waitFor(() => page!.evaluate<boolean>(connected), Boolean, 120000);
      assert.equal(await page.evaluate<boolean>(`!document.cookie.includes('mdbs_session') && !JSON.stringify({...localStorage,...sessionStorage}).match(/mdb[tsp]_v1_/)`), true, app + ' no browser-visible authentication secrets');
      await page.call('Page.reload', { ignoreCache: true });
      await waitFor(() => page!.evaluate<boolean>(connected), Boolean, 120000);
      const restored: number = await page.evaluate<number>(`fetch(${JSON.stringify(api + '/api/v1/security/session')},{credentials:'include'}).then(r=>r.status)`);
      assert.equal(restored, 200, app + ' restored session');
      if (app === 'model-designer') {
        assert.equal(await page.evaluate<boolean>(`(() => {
          const button=[...document.querySelectorAll('button')].find(b=>b.title==='Security center');
          if(!button)return false; button.click(); return true;
        })()`), true, 'ordinary editor opens the security center');
        await waitFor(() => page!.evaluate<boolean>(`!!document.querySelector('.security-center-access-state h2')`), Boolean);
        assert.equal(await page.evaluate<string>(`document.querySelector('.security-center-navigation-title span').textContent`), api, 'endpoint is displayed with one port');
        await checkEntryLanguages(page, 'forbidden');
        assert.deepEqual(await page.evaluate(`(async () => {
          const session=await fetch(${JSON.stringify(api + '/api/v1/security/session')},{credentials:'include'}).then(r=>r.json());
          const response=await fetch(${JSON.stringify(api + '/api/v1/security/admin/overview')},{credentials:'include',headers:{'x-modeldb-csrf':session.csrf}});
          return {securityAdmin:session.securityAdmin===true,status:response.status};
        })()`), {securityAdmin:false,status:403}, 'language selection cannot elevate ordinary session');
        await page.evaluate(`document.querySelector('.designer-security-center-workspace .mode-ui-drawer-close').click()`);
        await waitFor(() => page!.evaluate<boolean>(`!document.querySelector('.security-center-workspace')`), Boolean);
        assert.equal(await page.evaluate<boolean>(connected), true, 'return to the same connected editor');
        const query = structuredClone(customerOrdersQueryFixture);
        query.status = 'active';
        const published: QueryInterfaceRelease = {
          version: query.version.current, callableName: 'SecurityBrowser_Query',
          publishedAt: new Date().toISOString(), signature: queryInterfacePublicationSignature(query),
          queryInterface: query,
          // Only documentation is rendered here; execution is covered by the real engine HTTP suite.
          executionTemplate: {} as QueryInterfaceRelease['executionTemplate'],
        };
        const seed: number = await page.evaluate<number>(`(async () => {
          const info = await fetch(${JSON.stringify(api + '/api/v1/security/session')},{credentials:'include'}).then(r=>r.json());
          const response = await fetch(${JSON.stringify(api + '/api/v1/rpc')}, {
            method:'POST',credentials:'include',headers:{'content-type':'application/json','x-modeldb-csrf':info.csrf},
            body:JSON.stringify(${JSON.stringify({ version: 1, database: cfg.designerWorkspace, operation: {
              op: 'insert', model: 'sys_query_interface', sync: true, data: {
                library_code: 'graph', interface_id: query.id, display_name: 'SecurityBrowser_Query',
                query_json: JSON.stringify(query), chain_json: JSON.stringify(EMPTY_QUERY_CHAIN_STATE),
                release_json: JSON.stringify(published), release_history_json: '',
                signature: published.signature, created_at: published.publishedAt, updated_at: published.publishedAt,
              },
            } })})
          });
          return response.status;
        })()`);
        assert.equal(seed, 200, 'seed published interface documentation');
        await page.call('Page.reload', { ignoreCache: true });
        await waitFor(() => page!.evaluate<boolean>(connected), Boolean, 120000);
        assert.equal(await page.evaluate<boolean>(`(() => {
          const button=[...document.querySelectorAll('button')].find(b=>/Interface manager|接口管理/.test(b.title||''));
          if(!button) return false; button.click(); return true;
        })()`), true, 'open interface manager');
        await waitFor(() => page!.evaluate<boolean>(`!!document.querySelector('.query-interface-doc-summary')`), Boolean);
        await page.evaluate(`document.querySelector('.query-interface-doc-summary').click()`);
        await waitFor(() => page!.evaluate<boolean>(`!!document.querySelector('.query-interface-http-example')`), Boolean);
        const endpoint: string = await page.evaluate<string>(`document.querySelector('.query-interface-doc-call code').textContent`);
        assert.equal(endpoint, `POST ${api}/api/v1/databases/graph/query-interfaces/SecurityBrowser_Query`);
        await page.evaluate(`document.querySelector('.query-interface-http-example > summary').click()`);
        assert.equal(await page.evaluate<boolean>(`document.querySelector('.query-interface-http-example pre').textContent.includes('Authorization: Bearer $MODELDB_TOKEN')`), true);
        const downloads = join(root, 'downloads');
        mkdirSync(downloads);
        await page.call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
        await page.evaluate(`document.querySelector('.query-interface-call-tools button').click()`);
        const collectionFile = join(downloads, 'SecurityBrowser_Query.postman_collection.json');
        await waitFor(async () => existsSync(collectionFile), Boolean, 10000);
        const exported = JSON.parse(readFileSync(collectionFile, 'utf8'));
        assert.equal(exported.item[0].request.auth.type, 'bearer');
        assert.equal(exported.variable[1].value, '');
        assert.equal(exported.item[0].request.method, 'POST');
        assert.ok(!JSON.stringify(exported).includes('mdbt_v1_'));
        console.log('[security-browser] Query interface: complete POST URL, Bearer example and Postman download passed');
      }
      await page.evaluate(`(() => { [...document.querySelectorAll('button')].find(b=>/Disconnect|断开连接/.test((b.textContent||'')+' '+(b.title||''))).click(); })()`);
      await waitFor(() => page!.evaluate<number>(`fetch(${JSON.stringify(api + '/api/v1/security/session')},{credentials:'include'}).then(r=>r.status)`), (v) => v === 401 || v === 403, 30000);
      if (app === 'model-designer') {
        await page.evaluate(`localStorage.setItem('model-designer:authMode', 'token')`);
        const admin = await callLocalSecurity(join(root, 'security'), { action: 'browser.security.launch', origin: served.origin, databases: [] }) as { code: string };
        const adminFragment = new URLSearchParams({ 'modeldb-pair': admin.code, 'modeldb-server': api });
        // Open the launcher in a fresh document; reloading during exchange can discard the one-time code.
        await page.call('Page.navigate', { url: 'about:blank' });
        await page.call('Page.navigate', { url: `${served.origin}/#${adminFragment}` });
        await waitFor(() => page!.evaluate<boolean>(`!!document.querySelector('.security-center-metrics')`), Boolean);
        assert.equal(await page.evaluate<string>(`document.querySelector('.security-center-navigation-title span').textContent`), api, 'administrator endpoint is displayed with one port');
        assert.equal(await page.evaluate<string>(`localStorage.getItem('model-designer:authMode')`), 'browser', 'administrator launcher overrides saved Token mode');
        await checkEntryLanguages(page, 'security');
        await page.evaluate(`document.querySelector('.security-center-design-guide summary').click()`);
        assert.equal(await page.evaluate<boolean>(`document.querySelector('.security-center-design-guide').open && document.querySelector('.security-center-design-guide code').textContent.includes('browser-open -c <config>')`), true, 'design guide provides an explicit scoped launcher template');
        assert.deepEqual(await page.evaluate<{ databases: unknown[] }>(`fetch(${JSON.stringify(api + '/api/v1/management/databases')},{credentials:'include'}).then(r=>r.json())`), { databases: [] }, 'administrator sees no business databases');
        assert.equal(await page.evaluate<number>(`fetch(${JSON.stringify(api + '/api/v1/management/databases/graph/catalog')},{credentials:'include'}).then(r=>r.status)`), 403, 'administrator has no business database grants');
        await page.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
        assert.equal(await page.evaluate<boolean>(`document.documentElement.scrollWidth<=innerWidth && document.querySelector('.security-center-design-guide').scrollWidth<=document.querySelector('.security-center-design-guide').clientWidth+1`), true, 'expanded design guidance fits narrow viewport');
        if (process.env.MODELDB_TEST_SCREENSHOTS_ROOT) {
          const screenshot = await page.call('Page.captureScreenshot', { format: 'png' }) as { data: string };
          writeFileSync(join(process.env.MODELDB_TEST_SCREENSHOTS_ROOT, 'security-guide-en-390.png'), Buffer.from(screenshot.data, 'base64'));
        }
        await page.call('Emulation.clearDeviceMetricsOverride');
        await page.evaluate(`document.querySelector('.security-center-design-guide summary').click()`);
        console.log('[security-browser] administrator: independent entry and business isolation passed');
        for (let i = 0; i < 8; i++) {
          const rejected = await fetch(api + '/api/v1/rpc', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-rejected-browser-probe' }, body: '{}' });
          assert.equal(rejected.status, 401);
        }
        await page.call('Page.reload', { ignoreCache: true });
        await waitFor(() => page!.evaluate<boolean>(`!!document.querySelector('.security-center-metrics')`), Boolean);
        await page.evaluate(`[...document.querySelectorAll('.security-center-navigation nav button')].find(b=>b.textContent==="Security audit").click()`);
        await waitFor(() => page!.evaluate<boolean>(`!!document.querySelector('.security-center-audit-controls')`), Boolean);
        const counts: number[] = await page.evaluate<number[]>(`[...document.querySelectorAll('.security-center-metric strong')].map(el=>Number(el.textContent))`);
        assert.equal(counts[0], counts[1] + counts[2], 'observed = suppressed + saved audit details');
        assert.ok(counts[1] >= 6, 'anonymous browser probes aggregate even across a minute boundary');
        assert.equal(await page.evaluate<boolean>(`[...document.querySelectorAll('td')].some(td=>td.querySelector('code')?.textContent==='authentication.reject' && !!td.querySelector('small'))`), true, 'aggregate row shows observed count');
        await page.call('Emulation.setDeviceMetricsOverride', { width: 760, height: 900, deviceScaleFactor: 1, mobile: false });
        assert.equal(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`), true, 'audit metrics fit a narrow viewport');
        console.log('[security-browser] administrator: aggregate audit counts, row details and narrow layout passed');
        await page.evaluate(`[...document.querySelectorAll('.security-center-navigation nav button')].find(b=>b.textContent==="Network policy").click()`);
        await waitFor(() => page!.evaluate<boolean>(`!!document.querySelector('.security-protection-panel > fieldset')`), Boolean);
        const initial = await callLocalSecurity(join(root, 'security'), { action: 'network.status' }) as SecurityProtectionState;
        await page.evaluate(`document.querySelectorAll('.security-protection-rules')[1].querySelector(':scope > button').click()`);
        await page.evaluate(`(() => {
          const inputs=document.querySelectorAll('.security-protection-rules')[1].querySelectorAll('input');
          ['browser-deny','192.0.2.1','','isolated browser verification'].forEach((value,index)=>{
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(inputs[index],value);
            inputs[index].dispatchEvent(new Event('input',{bubbles:true}));
          });
        })()`);
        await page.evaluate(`document.querySelector('.security-protection-panel > fieldset > button').click()`);
        await waitFor(() => page!.evaluate<boolean>(`!!document.querySelector('.security-protection-preview button')`), Boolean);
        await page.evaluate(`document.querySelector('.security-protection-preview button').click()`);
        await waitFor(() => page!.evaluate<boolean>(`!!document.querySelector('.security-protection-pending button')`), Boolean);
        await page.evaluate(`document.querySelector('.security-protection-pending button').click()`);
        await waitFor(() => page!.evaluate<boolean>(`!document.querySelector('.security-protection-pending') && document.querySelector('.security-protection-panel')?.getAttribute('aria-busy')==='false'`), Boolean);
        const confirmed = await callLocalSecurity(join(root, 'security'), { action: 'network.status' }) as SecurityProtectionState;
        assert.equal(confirmed.config.data.deny?.[0]?.source, '192.0.2.1');
        assert.equal(confirmed.pending, undefined);
        console.log('[security-browser] administrator: rule preview/apply/confirm passed');
        await page.evaluate(`document.querySelectorAll('.security-protection-panel > button')[1].click()`);
        await waitFor(async () => (await callLocalSecurity(join(root, 'security'), { action: 'network.status' }) as SecurityProtectionState).revision, (value) => value > confirmed.revision);
        const reverted = await callLocalSecurity(join(root, 'security'), { action: 'network.status' }) as SecurityProtectionState;
        assert.deepEqual(reverted.config, initial.config);
        await page.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
        assert.equal(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('.security-center-main').getBoundingClientRect().right <= innerWidth+1`), true, 'network panel fits narrow viewport');
        await page.evaluate(`[...document.querySelectorAll('.security-center-navigation nav button')].find(b=>b.textContent==="Key references").click()`);
        await waitFor(() => page!.evaluate<boolean>(`!!document.querySelector('.security-protection-panel dl')`), Boolean);
        const beforeRotate = await callLocalSecurity(join(root, 'security'), { action: 'maintenance.status' }) as SecurityMaintenanceStatus;
        await page.evaluate(`document.querySelector('.security-protection-panel .security-protection-checkbox input').click()`);
        await page.evaluate(`document.querySelectorAll('.security-protection-panel > button')[1].click()`);
        await waitFor(async () => (await callLocalSecurity(join(root, 'security'), { action: 'maintenance.status' }) as SecurityMaintenanceStatus).keys.masterKeyId, (value) => value !== beforeRotate.keys.masterKeyId);
        await waitFor(() => page!.evaluate<boolean>(`document.querySelector('.security-protection-panel')?.getAttribute('aria-busy')==='false'`), Boolean);
        assert.equal(await page.evaluate<boolean>(`!!document.querySelector('.security-protection-panel [role=alert]')`), false, 'maintenance UI completed');
        assert.equal(await page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`), true, 'maintenance panel fits narrow viewport');
        await page.evaluate(`document.querySelector('.security-center-navigation > button').click()`);
        await waitFor(() => page!.evaluate<boolean>(`!!document.querySelector('.designer-connection-card input[type=password]')`), Boolean);
        await waitFor(() => page!.evaluate<number>(`fetch(${JSON.stringify(api + '/api/v1/security/session')},{credentials:'include'}).then(r=>r.status)`), (v) => v === 401);
        await page.call('Emulation.clearDeviceMetricsOverride');
        console.log('[security-browser] administrator: independent entry, reload, rule preview/apply/confirm/rollback, master rotation, narrow layout and logout passed');
      }
      // Exercise the original application credential controls in a fresh document.
      const servicePrincipal=await callLocalSecurity(join(root,'security'),{action:'principal.create',name:'Synthetic '+app+' compatibility'}) as {id:string};
      const serviceCredential=await callLocalSecurity(join(root,'security'),{action:'credential.create',principalId:servicePrincipal.id,name:'Synthetic application credential',grants:['graph','model_designer_workspace'].map(database=>({database,resource:'*',actions:['model.read','model.write','schema.manage','database.manage']}))}) as {token:string};
      await page.call('Page.navigate',{url:'about:blank'});
      await page.call('Page.navigate',{url:served.origin});
      await waitFor(()=>page!.evaluate<boolean>(`!!document.querySelector('input[type=password]')`),Boolean,30000);
      const connectionRoot=app==='model-designer'?'.designer-connection-card':app==='data-studio'?'.studio-connect-card':'.sidebar';
      await page.evaluate(`(()=>{const root=document.querySelector(${JSON.stringify(connectionRoot)}),select=[...root.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.value==='token'));Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'token');select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await delay(100);
      await page.evaluate(`(()=>{const root=document.querySelector(${JSON.stringify(connectionRoot)}),input=root.querySelector('input[type=password]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(serviceCredential.token)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      const connectSelector=app==='model-designer'?'.designer-connection-card .designer-btn-primary':app==='data-studio'?'.studio-connect-card .studio-btn-primary':'.sidebar .actions button';
      await page.evaluate(`document.querySelector(${JSON.stringify(connectSelector)}).click()`);
      await waitFor(()=>page!.evaluate<boolean>(app==='model-designer'?`!document.querySelector('.designer-connection-card input[type=password]')`:app==='data-studio'?`!!document.querySelector('select.studio-input option[value=graph]')`:`!!document.querySelector('.sidebar .tree-db')`),Boolean,120000);
      assert.equal(await page.evaluate<boolean>(`!JSON.stringify({...localStorage,...sessionStorage}).includes(${JSON.stringify(serviceCredential.token)})`),true,app+' application Token remains memory-only');
      await page.call('Page.reload',{ignoreCache:true});
      await waitFor(()=>page!.evaluate<boolean>(`!!document.querySelector('input[type=password]')`),Boolean,30000);
      assert.equal(await page.evaluate<string>(`document.querySelector('input[type=password]').value`),'',app+' Token is not restored from storage');
      console.log('[security-browser] '+app+': application credential controls, scoped listing and memory-only reload passed');
      assert.deepEqual(page.exceptions, [], app + ' unhandled browser exceptions');
      console.log(`[security-browser] ${app}: pairing, workspace, reload, HttpOnly and logout passed`);
    }
  } finally {
    page?.close();
    if (chrome && chrome.exitCode === null) {
      chrome.kill();
      await new Promise<void>((done) => { chrome!.once('exit', () => done()); setTimeout(done, 5000); });
    }
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
    await engine?.close();
    // Chromium may finish releasing profile handles just after its main process exits.
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
