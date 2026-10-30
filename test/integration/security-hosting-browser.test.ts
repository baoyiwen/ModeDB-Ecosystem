/** Required native acceptance. Only fresh temporary instances, builds and browser profiles. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { ensureModelDbLayoutAtRoot } from '../../packages/server/src/modeldb-default-home.js';
import { loadModelDBServerConfig } from '../../packages/server/src/config-loader.js';
import { buildDualTrackFastify } from '../../packages/server/src/dual-track-app.js';
import { callLocalSecurity } from '../../packages/server/src/security/local-management-channel.js';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';
import { hostedSecurityLaunchUrl } from '../../packages/server/src/cli-security.js';
import { registrationBrowser, waitFor } from '../fixtures/security-registration-browser.js';

async function fixture() {
  assert.equal(process.platform,'win32','Native Windows acceptance is required');
  const root=mkdtempSync(join(tmpdir(),'ModeDB-Hosting-Native-'));
  const cfg=await loadModelDBServerConfig(ensureModelDbLayoutAtRoot(root),{port:0});
  const build=process.env.MODELDB_HOSTING_TEST_BUILD;
  assert.ok(build,'Fresh isolated Designer build is required');
  return {root,dir:join(root,'security'),options:{...cfg,host:'127.0.0.1',port:0,securityMode:'registry' as const,securityHosting:{enabled:true,designerDirectory:build,managementPort:0},securityAudit:{maxEvents:10000,retentionDays:365}}};
}
async function reserve() {
  const server=createServer();await new Promise<void>((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',done);});
  const a=server.address();assert.ok(a&&typeof a!=='string');return {server,port:a.port,close:()=>new Promise<void>((done,fail)=>server.close(e=>e?fail(e):done()))};
}
const origin=(app:Awaited<ReturnType<typeof buildDualTrackFastify>>)=>{const a=app.server.address();assert.ok(a&&typeof a!=='string');return 'http://127.0.0.1:'+a.port;};
type Launch={code:string;origin:string;url:string;expiresAt:string};
const launch=async(dir:string)=>await callLocalSecurity(dir,{action:'browser.hosted.security.launch'}) as Launch;
async function assertReleased(dir:string) {const r=SecurityRegistry.open(dir);r.close();await assert.rejects(()=>callLocalSecurity(dir,{action:'status'}));}

test('native Windows hosted listeners, OS pipe, bind failure cleanup and port lifecycle',{timeout:180000},async t=>{
  const x=await fixture();let app:Awaited<ReturnType<typeof buildDualTrackFastify>>|undefined;
  try {
    app=await buildDualTrackFastify(x.options);const data=origin(app),admin=await launch(x.dir);
    assert.equal(new URL(admin.origin).hostname,'127.0.0.1');assert.notEqual(admin.origin,data);
    assert.equal((await fetch(data+'/designer/')).status,200);assert.equal((await fetch(data+'/security/')).status,404);
    assert.equal((await fetch(data+'/api/v1/security/admin/overview')).status,404);
    assert.equal((await fetch(admin.origin+'/api/v1/rpc',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,404);
    assert.equal((await fetch(admin.origin+'/api/v1/security/admin/overview')).status,401);
    await assert.rejects(()=>callLocalSecurity(x.dir,{action:'browser.security.launch',origin:admin.origin}));
    const response=await fetch(admin.origin+'/api/v1/security/pair',{method:'POST',headers:{origin:admin.origin,'content-type':'application/json'},body:JSON.stringify({code:admin.code})});assert.equal(response.status,200);
    const session=await response.json() as {csrf:string;securityAdmin:boolean};assert.equal(session.securityAdmin,true);
    const cookie=response.headers.getSetCookie()[0]!.split(';')[0]!;
    assert.equal((await fetch(admin.origin+'/api/v1/security/admin/overview',{headers:{origin:admin.origin,cookie}})).status,200);
    await app.close();app=undefined;await assertReleased(x.dir);
    await assert.rejects(()=>fetch(data+'/designer/'));await assert.rejects(()=>fetch(admin.origin+'/security/'));
    const dataPort=Number(new URL(data).port),managementPort=Number(new URL(admin.origin).port);
    app=await buildDualTrackFastify({...x.options,port:dataPort,securityHosting:{...x.options.securityHosting,managementPort}});
    assert.equal((await fetch(admin.origin+'/api/v1/security/session',{headers:{origin:admin.origin,cookie}})).status,200);
    await app.close();app=undefined;
    for(const role of ['data','management'] as const){
      const occupied=await reserve();try{
        const options={...x.options,...(role==='data'?{port:occupied.port}:{securityHosting:{...x.options.securityHosting,managementPort:occupied.port}})};
        await assert.rejects(()=>buildDualTrackFastify(options),{code:'EADDRINUSE'});await assertReleased(x.dir);
      }finally{await occupied.close();}
      app=await buildDualTrackFastify(x.options);await app.close();app=undefined;
    }
    const invalid=join(x.root,'invalid-public');mkdirSync(invalid);writeFileSync(join(invalid,'index.html'),'synthetic');writeFileSync(join(invalid,'server.key'),'synthetic excluded');
    await assert.rejects(()=>buildDualTrackFastify({...x.options,securityHosting:{enabled:true,designerDirectory:invalid}}),{code:'SECURITY_INVALID_CONFIG'});await assertReleased(x.dir);
    t.diagnostic(JSON.stringify({format:'modeldb.hosting-native.v1',ok:true,checks:{nativeDpapi:true,osAuthenticatedPipe:true,exactLiveAddress:true,dataManagementSeparated:true,anonymousAdminDenied:true,legacyLaunchBlocked:true,cookieRestartRecovery:true,closeReleasesBothPorts:true,bindFailuresReleaseRegistryAndPipe:true,invalidBuildRejected:true},liveMaterialRead:false}));
  } finally {await app?.close();}
});

test('fresh hosted Designer and management UI in Chrome, same-origin Cookie/CSRF and localized layouts',{timeout:180000},async t=>{
  const x=await fixture();let app:Awaited<ReturnType<typeof buildDualTrackFastify>>|undefined,page:Awaited<ReturnType<typeof registrationBrowser>>|undefined;
  try {
    app=await buildDualTrackFastify(x.options);const data=origin(app),admin=await launch(x.dir);
    page=await registrationBrowser(x.root,'');
    await page.call('Page.navigate',{url:data+'/designer/'});
    await waitFor(()=>page!.evaluate<boolean>(`!!document.querySelector('.designer-connection-flow')`),Boolean);
    assert.equal(await page.evaluate<boolean>(`[...document.querySelectorAll('input')].some(e=>e.value===location.port)`),true);
    assert.equal(await page.evaluate<number>(`fetch('/api/v1/security/admin/overview').then(r=>r.status)`),404);
    const screenshots=process.env.MODELDB_HOSTING_TEST_SCREENSHOTS;assert.ok(screenshots);mkdirSync(screenshots,{recursive:true});
    const languages=async(entry:'connection'|'security')=>{
      const root=entry==='connection'?'.designer-connection-flow':'.security-center-workspace';
      const title=entry==='connection'?'.designer-connection-card h1':'.security-center-navigation-title strong';
      for(const locale of ['zh','en','ja']){
        const messages=JSON.parse(readFileSync(join('apps/model-designer/src/i18n/locales',locale,'ui.json'),'utf8')) as Record<string,string>;
        for(const width of [1280,390]){
          await page!.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
          await page!.evaluate(`(()=>{const s=document.querySelector(${JSON.stringify(root+' .designer-language-selector select')});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,${JSON.stringify(locale)});s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
          await waitFor(()=>page!.evaluate<string>(`document.querySelector(${JSON.stringify(title)})?.textContent`),v=>v===messages[entry==='connection'?'gateTitle':'securityCenterTitle']);
          assert.equal(await page!.evaluate<boolean>(`(()=>{const r=document.querySelector(${JSON.stringify(root)}),s=r.querySelector('select');s.focus();return r.lang===${JSON.stringify(locale)}&&document.documentElement.scrollWidth<=innerWidth&&r.scrollWidth<=r.clientWidth+1&&s.labels.length===1&&document.activeElement===s;})()`),true);
          const shot=await page!.call<{data:string}>('Page.captureScreenshot',{format:'png'});writeFileSync(join(screenshots,entry+'-'+locale+'-'+width+'.png'),Buffer.from(shot.data,'base64'));
        }
      }
    };
    await languages('connection');
    await page.call('Page.navigate',{url:hostedSecurityLaunchUrl(admin).href});
    await waitFor(()=>page!.evaluate<boolean>(`!!document.querySelector('.security-center-navigation-title')`),Boolean,30000);
    assert.equal(await page.evaluate<boolean>(`!!document.querySelector('.security-center-design-guide')`),false);
    assert.equal(await page.evaluate<string>('location.hash'),'');
    assert.equal(await page.evaluate<number>(`fetch('/api/v1/security/admin/overview').then(r=>r.status)`),200);
    assert.equal(await page.evaluate<number>(`fetch('/api/v1/security/session/logout',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.status)`),403);
    const cookies=await page.call<{cookies:Array<{httpOnly:boolean;sameSite:string;name:string}>}>('Network.getCookies',{urls:[admin.origin]});
    assert.ok(cookies.cookies.some(c=>c.name.startsWith('mdbs_session_')&&c.httpOnly&&c.sameSite==='Strict'));
    assert.doesNotMatch(await page.evaluate<string>('document.cookie'),/mdbs_v1_/);
    assert.equal(await page.evaluate<number>(`fetch('/api/v1/rpc',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.status)`),404);
    await languages('security');
    await page.call('Page.reload');await waitFor(()=>page!.evaluate<boolean>(`!!document.querySelector('.security-center-navigation-title')`),Boolean,30000);
    assert.equal(await page.evaluate<boolean>(`(async()=>{const s=await fetch('/api/v1/security/session').then(r=>r.json());const r=await fetch('/api/v1/security/session/refresh',{method:'POST',headers:{'content-type':'application/json','x-modeldb-csrf':s.csrf},body:'{}'});const n=await r.json();return r.status===200&&n.csrf!==s.csrf&&(await fetch('/api/v1/security/session/logout',{method:'POST',headers:{'content-type':'application/json','x-modeldb-csrf':n.csrf},body:'{}'})).status===200&&(await fetch('/api/v1/security/admin/overview')).status===401;})()`),true);
    t.diagnostic(JSON.stringify({format:'modeldb.hosting-browser.v1',ok:true,browser:page.version,hardwareAuthenticatorTested:false,systemTrustInstalled:false,checks:{freshDesignerBuild:true,cspRunsApplication:true,sameOriginData:true,osLaunchFragmentRemoved:true,httpOnlyStrict:true,csrfRequired:true,managementOnly:true,reloadRecovery:true,refreshAndLogout:true,localizedZhEnJa:true,wideAndNarrow:true,accessibleLanguageControl:true},screenshots:12,liveMaterialRead:false}));
  } finally {await page?.close();await app?.close();}
});
