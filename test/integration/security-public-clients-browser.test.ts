/** Formal UI acceptance: synthetic TLS, native DPAPI/Pipe, fresh build and virtual authenticator. */
import assert from 'node:assert/strict';
import {createHash, X509Certificate} from 'node:crypto';
import {mkdtempSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {test} from 'node:test';
import {ensureModelDbLayoutAtRoot} from '../../packages/server/src/modeldb-default-home.js';
import {loadModelDBServerConfig} from '../../packages/server/src/config-loader.js';
import {buildDualTrackFastify} from '../../packages/server/src/dual-track-app.js';
import {SecurityRegistry} from '../../packages/server/src/security/security-registry.js';
import {callLocalSecurity} from '../../packages/server/src/security/local-management-channel.js';
import {registrationBrowser, waitFor} from '../fixtures/security-registration-browser.js';
import {scopes, utc} from '../fixtures/security-registration-integration.js';
import {assertSyntheticBrowserSave} from '../fixtures/security-browser-save.js';
import type {DeviceRegistrationConnectionDescriptorV1} from '@mode-db/shared';

for(const appName of ['data-studio','web']) test(appName+' public identity registration, approval, Passkey and library connection', {timeout:240000}, async t=>{
  assert.equal(process.platform,'win32','Native Windows is required');
  const root=mkdtempSync(join(tmpdir(),'ModeDB-Designer-Identity-')),dir=join(root,'security');
  const cfg=await loadModelDBServerConfig(ensureModelDbLayoutAtRoot(root),{port:0});
  const registry=SecurityRegistry.open(dir),instanceId=registry.status().instanceId;registry.close();
  const reservation=createServer();await new Promise<void>((done,fail)=>{reservation.once('error',fail);reservation.listen(0,'127.0.0.1',done);});
  const address=reservation.address();assert.ok(address&&typeof address!=='string');const port=address.port;
  await new Promise<void>((done,fail)=>reservation.close(e=>e?fail(e):done()));
  const origin=`https://modeldb-a.example.test:${port}`,tls=fileURLToPath(new URL('../fixtures/security-registration-tls/',import.meta.url));
  const cert=new X509Certificate(readFileSync(join(tls,'modeldb-a.crt'))),spki=createHash('sha256').update(cert.publicKey.export({type:'spki',format:'der'})).digest(),now=Date.now();
  const descriptor:DeviceRegistrationConnectionDescriptorV1={format:'modeldb.device-registration-connection.v1',version:1,instanceId,serverOrigin:origin,rpId:'modeldb-a.example.test',registrationMode:'enabled',issuedAtUtc:utc(now-1000),expiresAtUtc:utc(now+3600000),deploymentDescriptorSha256:'a'.repeat(64),tls:{mode:'owner-pinned',minVersion:'TLS1.2',spkiSha256:spki.toString('hex')}};
  const builds=process.env.MODELDB_PUBLIC_TEST_BUILDS,shots=process.env.MODELDB_HOSTING_TEST_SCREENSHOTS;assert.ok(builds);assert.ok(shots);const build=join(builds,appName),screenshots=join(shots,appName);mkdirSync(screenshots,{recursive:true});
  const options={...cfg,host:'127.0.0.1',port,publicBaseUrl:origin,securityMode:'registry' as const,securityAuthentication:{enabled:true,allowStorageMigration:true},securityRegistration:{descriptor,allowStorageMigration:true},securityHosting:{enabled:true,designerDirectory:build,managementPort:0},securityNetwork:{transport:{mode:'tls' as const,certificateFile:join(tls,'modeldb-a.crt'),privateKeyFile:join(tls,'modeldb-a.key')},data:{allowListEnabled:false}},securityAudit:{maxEvents:20000,retentionDays:365}};
  let app:Awaited<ReturnType<typeof buildDualTrackFastify>>|undefined,page:Awaited<ReturnType<typeof registrationBrowser>>|undefined;
  const local=(input:unknown)=>callLocalSecurity(dir,input);
  const state=()=>page!.evaluate<string>(`document.querySelector('[data-identity-state]')?.getAttribute('data-identity-state')`);
  const click=async(selector:string)=>{assert.equal(await page!.evaluate<boolean>(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return false;e.click();return true;})()`),true,'UI control ready: '+selector);};
  const ready=()=>waitFor(()=>page!.evaluate<boolean>(`!!document.querySelector('[data-identity-login]:not(:disabled)')`),Boolean,30000);
  const navigate=async()=>{await page!.call('Page.navigate',{url:origin+'/designer/'});await waitFor(()=>page!.evaluate<boolean>(`!!document.querySelector('.designer-identity') && document.querySelector('.designer-identity')?.getAttribute('aria-busy')==='false'`),Boolean,30000);};
  const shot=async(scene:string)=>{
    for(const locale of (appName==='web'?['zh-CN','en']:['zh','en','ja']))for(const width of [1280,390]){
      await page!.call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
      const messages=JSON.parse(readFileSync(join('apps/data-studio/src/i18n/locales',locale==='zh-CN'?'zh':locale,'ui.json'),'utf8')) as Record<string,string>;
      await page!.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(appName==='web'?'#locale':'.studio-connect-card select.studio-select')});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(locale)});e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await waitFor(()=>page!.evaluate<string>(`document.querySelector('#identity-title')?.textContent`),v=>v===messages.identity_title);
      assert.equal(await page!.evaluate<boolean>(`(()=>{const r=document.querySelector('.designer-identity'),flow=document.querySelector('.mdb-identity'),b=r.querySelector('button');b.focus();return document.documentElement.scrollWidth<=innerWidth && flow.scrollWidth<=flow.clientWidth+1 && [...r.querySelectorAll('input')].every(e=>e.labels.length>0) && document.activeElement===b && flow.lang===${JSON.stringify(locale)};})()`),true);
      const image=await page!.call<{data:string}>('Page.captureScreenshot',{format:'png'});writeFileSync(join(screenshots,scene+'-'+locale+'-'+width+'.png'),Buffer.from(image.data,'base64'));
    }
  };
  try{
    app=await buildDualTrackFastify(options);page=await registrationBrowser(root,spki.toString('base64'));await navigate();await ready();
    const seedPrincipal=await local({action:'principal.create',name:'Synthetic library seed'}) as {id:string};
    const seed=await local({action:'credential.create',principalId:seedPrincipal.id,name:'Synthetic seed',grants:[{database:'synthetic_business',resource:'*',actions:['model.read','model.write','schema.manage','database.manage']}]}) as {token:string};
    assert.equal(await page.evaluate<number>(`fetch('/api/v1/management/databases',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+${JSON.stringify(seed.token)}},body:JSON.stringify({name:'synthetic_business'})}).then(r=>r.status)`),200);
    assert.equal(await page.evaluate<number>(`fetch('/api/v1/rpc',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+${JSON.stringify(seed.token)}},body:JSON.stringify({version:1,database:'synthetic_business',operation:{op:'registerModel',model:'SyntheticItem',schema:{label:'String'}}})}).then(r=>r.status)`),200);
    await page.call('Network.clearBrowserCookies');await navigate();await ready();await shot('login');
    // A real UI cancellation path without completing or weakening WebAuthn verification.
    await page.evaluate(`globalThis.savedCredentialGet = navigator.credentials.get.bind(navigator.credentials); navigator.credentials.get = async()=>{throw new DOMException('Synthetic user cancellation','NotAllowedError');};true`);
    await click('[data-identity-login]');await waitFor(()=>page!.evaluate<string>(`document.querySelector('[data-identity-issue]')?.getAttribute('data-identity-issue')`),v=>v==='cancelled');
    await page.evaluate(`navigator.credentials.get=globalThis.savedCredentialGet;delete globalThis.savedCredentialGet;true`);
    assert.equal(await page.evaluate<number>(`fetch('/api/v1/security/session').then(r=>r.status)`),401);
    await page.evaluate(`document.querySelector('.designer-identity details').open=true;true`);
    const importFile=async(value:unknown)=>{
      const path=join(root,'synthetic-descriptor.json');writeFileSync(path,JSON.stringify(value));
      const doc=await page!.call<{root:{nodeId:number}}>('DOM.getDocument');
      const input=await page!.call<{nodeId:number}>('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'.designer-identity input[type=file]'});
      await page!.call('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[path]});
    };
    await importFile({...descriptor,serverOrigin:'https://other.example.test'});
    await waitFor(()=>page!.evaluate<string>(`document.querySelector('[data-identity-issue]')?.getAttribute('data-identity-issue')`),v=>v==='descriptor');
    assert.equal(await page.evaluate<string>('location.origin'),origin);
    await importFile(descriptor);await waitFor(()=>page!.evaluate<boolean>(`!!document.querySelector('[data-identity-imported]')`),Boolean);
    const apply=async(name:string)=>{
      await page!.evaluate(`document.querySelector('.designer-identity details').open=true;true`);
      await page!.evaluate(`(()=>{const e=document.querySelector('[data-identity-name]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(name)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await click('[data-identity-register]');await waitFor(state,v=>v==='pending',30000);
      return await page!.evaluate<string>(`document.querySelector('[data-identity-state] dd').textContent`);
    };
    const rejected=await apply('Synthetic rejected UI');
    let list=await local({action:'registration.list',instanceId}) as {revision:number};
    await local({action:'registration.reject',instanceId,id:rejected,revision:list.revision,confirm:true});await waitFor(state,v=>v==='rejected',15000);
    await shot('rejected');
    // Choose the newly approved identity deterministically; do not let the virtual
    // authenticator auto-select the earlier rejected resident credential.
    await page.call('WebAuthn.clearCredentials',{authenticatorId:page.authenticatorId});
    const approved=await apply('Synthetic approved UI');await shot('pending');
    assert.equal(await page.evaluate<boolean>(`!JSON.stringify({...localStorage,...sessionStorage}).includes('continuationSecret') && !document.documentElement.innerHTML.includes('continuationSecret')`),true);
    assert.equal(await page.evaluate<number>(`fetch('/api/v1/security/context?database=synthetic_business').then(r=>r.status)`),401);
    list=await local({action:'registration.list',instanceId}) as {revision:number};
    await local({action:'registration.approve',instanceId,id:approved,revision:list.revision,confirm:true,name:'Synthetic UI operator',grants:[{...scopes[0],actions:['model.read','model.write']}]});
    await waitFor(state,v=>v==='approved',15000);await shot('approved');
    assert.equal(await page.evaluate<number>(`fetch('/api/v1/security/session').then(r=>r.status)`),401);
    await click('[data-identity-login]');await waitFor(()=>page!.evaluate<boolean>(`!!document.querySelector('[data-identity-session="ready"]')`),Boolean,30000);
    assert.equal(await page.evaluate<number>(`fetch('/api/v1/security/context?database=synthetic_business').then(r=>r.status)`),200);
    assert.equal(await page.evaluate<number>(`fetch('/api/v1/security/admin/overview').then(r=>r.status)`),404);
    const cookies=await page.call<{cookies:Array<{httpOnly:boolean;secure:boolean;sameSite:string;name:string}>}>('Network.getCookies',{urls:[origin]});assert.ok(cookies.cookies.some(c=>c.name.startsWith('mdbs_session_')&&c.httpOnly&&c.secure&&c.sameSite==='Strict'));
    assert.equal(await page.evaluate<string>('document.cookie'),'');
    await assertSyntheticBrowserSave(page,true);
    await click('.designer-identity-actions button:first-of-type');
    if(appName==='data-studio') {
      await waitFor(()=>page!.evaluate<boolean>(`!!document.querySelector('select.studio-input option[value=synthetic_business]')`),Boolean,30000);
      await click('.studio-btn-row .studio-btn-primary');
      await waitFor(()=>page!.evaluate<boolean>(`!!document.querySelector('.studio-shell')`),Boolean,30000);
    } else await waitFor(()=>page!.evaluate<boolean>(`!!document.querySelector('.sidebar .tree-db')`),Boolean,30000);
    // Discard only UI restore markers so the public session panel is inspected again.
    await page.evaluate(`localStorage.clear();true`);
    await navigate();await waitFor(()=>page!.evaluate<boolean>(`!!document.querySelector('[data-identity-session="ready"]')`),Boolean,30000);
    assert.equal(await state(),undefined,'No continuation secret persisted across reload');
    await assertSyntheticBrowserSave(page,false);
    await click('.designer-identity-actions button:last-child');await ready();
    assert.equal(await page.evaluate<number>(`fetch('/api/v1/security/session').then(r=>r.status)`),401);
    // An expired registration download must not prevent the actual formal login UI.
    await app.close();app=undefined;
    app=await buildDualTrackFastify({...options,securityRegistration:{descriptor:{...descriptor,registrationMode:'disabled',issuedAtUtc:utc(now-7200000),expiresAtUtc:utc(now-3600000)}}});
    await navigate();await ready();assert.equal(await page.evaluate<number>(`fetch('/security/registration/v1/connection').then(r=>r.status)`),410);
    await click('[data-identity-login]');await waitFor(()=>page!.evaluate<boolean>(`!!document.querySelector('[data-identity-session="ready"]')`),Boolean,30000);
    const credentials=await local({action:'registration.credentials.list',instanceId}) as {revision:number;credentials:Array<{id:string}>};
    assert.equal(credentials.credentials.length,1);
    await local({action:'registration.credential.disable',instanceId,id:credentials.credentials[0]!.id,revision:credentials.revision,confirm:true});
    assert.equal(await page.evaluate<number>(`fetch('/api/v1/security/context?database=synthetic_business').then(r=>r.status)`),401);
    await navigate();await ready();await click('[data-identity-login]');
    await waitFor(()=>page!.evaluate<string>(`document.querySelector('[data-identity-issue]')?.getAttribute('data-identity-issue')`),v=>v==='identity',30000);
    t.diagnostic(JSON.stringify({format:'modeldb.public-identity-browser.v1',app:appName,ok:true,browser:page.version,screenshots:appName==='web'?16:24,hardwareAuthenticatorTested:false,systemTrustInstalled:false,liveMaterialRead:false,checks:{syntheticSaveReadback:true,freshApplicationBuild:true,publicClient:true,libraryConnection:true,formalRegistration:true,pendingNoAuthority:true,rejectedState:true,localOsApproval:true,approvalRequiresLogin:true,actualWebAuthnLogin:true,syntheticDataScope:true,managementDenied:true,httpOnlySecureStrict:true,reloadRestoresSession:true,continuationNotPersisted:true,logout:true,expiredWindowLogin:true,revocationDenied:true,cancelledExplained:true,supportedLocales:true,wideAndNarrow:true,labelsAndFocus:true}}));
  }finally{await page?.close();await app?.close();}
});
