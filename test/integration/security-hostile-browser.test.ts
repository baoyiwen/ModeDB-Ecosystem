/** DR-P3.6 real Chrome attacks against a fresh native instance; no live material or DNS changes. */
import assert from 'node:assert/strict';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureModelDbLayoutAtRoot } from '../../packages/server/src/modeldb-default-home.js';
import { loadModelDBServerConfig } from '../../packages/server/src/config-loader.js';
import { buildDualTrackFastify } from '../../packages/server/src/dual-track-app.js';
import { callLocalSecurity } from '../../packages/server/src/security/local-management-channel.js';
import { hostedSecurityLaunchUrl } from '../../packages/server/src/cli-security.js';
import { registrationBrowser, waitFor } from '../fixtures/security-registration-browser.js';

async function raw(origin: string, path: string, headers: Record<string, string> = {}, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const url = new URL(origin);
  return new Promise<{ status: number; headers: IncomingHttpHeaders }>((done, fail) => {
    const req = request({ hostname: '127.0.0.1', port: Number(url.port), path, method, headers: { host: url.host, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } }, res => {
      res.resume(); res.on('end', () => done({ status: res.statusCode!, headers: res.headers }));
    });
    req.on('error', fail); req.setTimeout(15000, () => req.destroy(Error('SYNTHETIC_REQUEST_TIMEOUT')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('native browser hostile page, same-site CSRF, null Origin, rebinding and proxy spoof cannot reach management', { timeout: 180000 }, async t => {
  assert.equal(process.platform, 'win32', 'Native Windows acceptance is required');
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Hostile-Browser-')), dir = join(root, 'security');
  const cfg = await loadModelDBServerConfig(ensureModelDbLayoutAtRoot(root), { port: 0 });
  const build = process.env.MODELDB_HOSTING_TEST_BUILD; assert.ok(build, 'Fresh candidate build is required');
  let app: Awaited<ReturnType<typeof buildDualTrackFastify>> | undefined;
  let page: Awaited<ReturnType<typeof registrationBrowser>> | undefined;
  let attackerOrigin = '';
  const attacker = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end('<!doctype html><html><title>Synthetic untrusted page</title><body><main>Isolated attack fixture</main></body></html>'); });
  const local = (input: unknown) => callLocalSecurity(dir, input);
  try {
    app = await buildDualTrackFastify({ ...cfg, host: '127.0.0.1', port: 0, securityMode: 'registry', securityHosting: { enabled: true, designerDirectory: build, managementPort: 0 }, securityAudit: { maxEvents: 20000, retentionDays: 365 } });
    const dataAddress = app.server.address(); assert.ok(dataAddress && typeof dataAddress !== 'string');
    const data = 'http://127.0.0.1:' + dataAddress.port;
    const launch = await local({ action: 'browser.hosted.security.launch' }) as { code: string; url: string; origin: string; expiresAt: string };
    const admin = launch.origin;
    await new Promise<void>((done, fail) => { attacker.once('error', fail); attacker.listen(0, '127.0.0.1', done); });
    const attackAddress = attacker.address(); assert.ok(attackAddress && typeof attackAddress !== 'string');
    attackerOrigin = 'http://127.0.0.1:' + attackAddress.port;
    page = await registrationBrowser(root, '');
    await page.call('Page.navigate', { url: hostedSecurityLaunchUrl(launch).href });
    await waitFor(() => page!.evaluate<boolean>(`!!document.querySelector('.security-center-navigation-title')`), Boolean, 30000);
    assert.equal(await page.evaluate<string>('location.hash'), '');
    assert.equal(await page.evaluate<number>(`fetch('/api/v1/security/admin/overview').then(r=>r.status)`), 200);
    for (const csrf of [undefined, 'synthetic-wrong-csrf']) {
      assert.equal(await page.evaluate<number>(`fetch('/api/v1/security/session/logout',{method:'POST',headers:{'content-type':'application/json',...${JSON.stringify(csrf ? { 'x-modeldb-csrf': csrf } : {})}},body:'{}'}).then(r=>r.status)`), 403);
    }
    const session = await page.evaluate<{ csrf: string }>(`fetch('/api/v1/security/session').then(r=>r.json())`);
    const cookies = await page.call<{ cookies: Array<{ name: string; value: string; httpOnly: boolean; sameSite: string }> }>('Network.getCookies', { urls: [admin] });
    const cookieItem = cookies.cookies.find(c => c.name.startsWith('mdbs_session_')); assert.ok(cookieItem?.httpOnly); assert.equal(cookieItem.sameSite, 'Strict');
    const cookie = cookieItem.name + '=' + cookieItem.value;
    const unused = await local({ action: 'browser.hosted.security.launch' }) as typeof launch;
    const before = await local({ action: 'audit.page', query: { action: 'hosting.reject', limit: 1 } }) as { total: number };

    // Requests carry a real cookie and even a known CSRF value: server Origin/Host checks still apply.
    for (const origin of [attackerOrigin, 'null']) {
      const response = await raw(admin, '/api/v1/security/session/logout', { origin, cookie, 'x-modeldb-csrf': session.csrf }, {});
      assert.equal(response.status, 403); assert.equal(response.headers['access-control-allow-origin'], undefined);
      assert.equal((await raw(admin, '/api/v1/security/pair', { origin }, { code: unused.code })).status, 403);
    }
    const preflight = await raw(admin, '/api/v1/security/admin/control', { origin: attackerOrigin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-modeldb-csrf' }, undefined, 'OPTIONS');
    assert.equal(preflight.status, 403); assert.equal(preflight.headers['access-control-allow-origin'], undefined);
    for (const host of ['attacker.invalid:' + new URL(admin).port, 'localhost:' + new URL(admin).port, '127.0.0.1:1']) assert.equal((await raw(admin, '/security/', { host, cookie })).status, 403);
    assert.equal((await raw(data, '/designer/', { host: 'attacker.invalid:' + dataAddress.port })).status, 403);
    for (const header of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip', 'via']) {
      assert.equal((await raw(admin, '/api/v1/security/admin/overview', { origin: admin, cookie, [header]: '127.0.0.1' })).status, 403);
      // A forged proxy address cannot turn the public data listener into management.
      assert.equal((await raw(data, '/api/v1/security/admin/overview', { origin: data, [header]: '127.0.0.1' })).status, 404);
    }
    const browserBefore = await local({ action: 'audit.page', query: { action: 'hosting.reject', limit: 1 } }) as { total: number };
    await page.call('Page.navigate', { url: attackerOrigin });
    await waitFor(() => page!.evaluate<string>('document.title'), value => value === 'Synthetic untrusted page');
    // Same-site different port is intentional: Strict cookies alone do not prevent this attack.
    const cors = await page.evaluate<string>(`fetch(${JSON.stringify(admin + '/api/v1/security/admin/overview')},{credentials:'include'}).then(()=> 'readable',()=> 'blocked')`);
    assert.equal(cors, 'blocked');
    assert.ok(['opaque','blocked'].includes(await page.evaluate<string>(`fetch(${JSON.stringify(admin + '/api/v1/security/session/logout')},{method:'POST',mode:'no-cors',credentials:'include',body:'{}'}).then(r=>r.type,()=> 'blocked')`)));
    assert.equal(await page.evaluate<string>(`fetch(${JSON.stringify(admin + '/api/v1/security/session/logout')},{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:'{}'}).then(()=> 'readable',()=> 'blocked')`), 'blocked');
    // Submit a normal HTML form; no fetch/CORS preflight is involved.
    await page.evaluate(`(()=>{const target=document.createElement('iframe');target.name='form-target';document.body.append(target);const form=document.createElement('form');form.target=target.name;form.method='POST';form.action=${JSON.stringify(admin + '/api/v1/security/session/logout')};document.body.append(form);form.submit();return true;})()`);
    // sandbox srcdoc has an opaque (null) Origin; its script still cannot log out the session.
    const sandboxCode = `fetch(${JSON.stringify(admin + '/api/v1/security/session/logout')},{method:'POST',mode:'no-cors',credentials:'include',body:'{}'}).finally(()=>parent.postMessage('synthetic-sandbox-done','*'));`;
    await page.evaluate(`(()=>{globalThis.sandboxDone=false;addEventListener('message',e=>{if(e.data==='synthetic-sandbox-done'&&e.origin==='null')globalThis.sandboxDone=true;});const f=document.createElement('iframe');f.sandbox='allow-scripts';f.srcdoc=${JSON.stringify('<script>' + sandboxCode + '</script>')};document.body.append(f);return true;})()`);
    await waitFor(() => page!.evaluate<boolean>('globalThis.sandboxDone===true'), Boolean);
    const wrongRp = await page.evaluate<string>(`navigator.credentials.create({publicKey:{rp:{id:'modeldb-a.example.test',name:'Synthetic wrong RP'},user:{id:new Uint8Array([1]),name:'synthetic',displayName:'Synthetic'},challenge:new Uint8Array(32),pubKeyCredParams:[{type:'public-key',alg:-7}],timeout:3000}}).then(()=> 'unexpected-proof',e=>e.name)`);
    assert.equal(wrongRp, 'SecurityError');
    await page.evaluate(`(()=>{const f=document.createElement('iframe');f.name='hostile-embedding-target';f.src=${JSON.stringify(admin + '/security/')};document.body.append(f);return true;})()`);
    await waitFor(() => page!.call<{ frameTree: { childFrames?: Array<{ frame: { name?: string; url: string } }> } }>('Page.getFrameTree'), tree => !!tree.frameTree.childFrames?.some(f => f.frame.name === 'hostile-embedding-target' && f.frame.url === 'chrome-error://chromewebdata/'));
    const browserAfter = await local({ action: 'audit.page', query: { action: 'hosting.reject', limit: 1 } }) as { total: number };
    assert.ok(browserAfter.total > browserBefore.total, 'Real browser requests must reach the server rejection boundary');
    const boundary = await raw(admin, '/security/'); assert.match(String(boundary.headers['content-security-policy']), /frame-ancestors 'none'/);
    await page.call('Page.navigate', { url: admin + '/security/' });
    await waitFor(() => page!.evaluate<boolean>(`!!document.querySelector('.security-center-navigation-title')`), Boolean, 30000);
    assert.equal(await page.evaluate<number>(`fetch('/api/v1/security/admin/overview').then(r=>r.status)`), 200);
    assert.equal((await raw(admin, '/api/v1/security/pair', { origin: admin }, { code: unused.code })).status, 200, 'Attacks must not consume the one-time pairing');
    assert.equal((await raw(data, '/api/v1/security/admin/overview', { origin: data, cookie })).status, 404);
    assert.equal((await raw(admin, '/api/v1/rpc', { origin: admin, cookie }, {})).status, 404);
    const after = await local({ action: 'audit.page', query: { action: 'hosting.reject', limit: 1 } }) as { total: number };
    assert.ok(after.total > before.total, 'Rejected requests must be audited');
    t.diagnostic(JSON.stringify({ format: 'modeldb.hostile-browser.v1', ok: true, browser: page.version, hardwareAuthenticatorTested: false, systemTrustInstalled: false, liveMaterialRead: false, checks: { authenticatedPositiveControl: true, sameOriginCsrfRequired: true, sameSiteMaliciousFetchDenied: true, preflightDenied: true, maliciousFormDenied: true, frameDenied: true, sandboxNullOriginDenied: true, webAuthnWrongRpDenied: true, rebindingHostDenied: true, localhostAliasDenied: true, proxySpoofDenied: true, dataManagementSeparated: true, sessionSurvivesAttack: true, oneTimePairingSurvivesAttack: true, noPermissiveCors: true, rejectionsAudited: true } }));
  } finally {
    await page?.close(); await app?.close();
    if (attacker.listening) await new Promise<void>((done, fail) => attacker.close(error => error ? fail(error) : done()));
  }
});
