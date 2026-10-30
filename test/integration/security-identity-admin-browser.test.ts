/** Formal UI acceptance: synthetic TLS, native DPAPI/Pipe, fresh build and virtual authenticator. */
import assert from 'node:assert/strict';
import {createHash, X509Certificate, randomBytes, randomUUID} from 'node:crypto';
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
import {hostedSecurityLaunchUrl} from '../../packages/server/src/cli-security.js';
import {registrationBrowser, waitFor} from '../fixtures/security-registration-browser.js';
import {scopes, utc} from '../fixtures/security-registration-integration.js';
import type {DeviceRegistrationConnectionDescriptorV1} from '@mode-db/shared';

test('local approval and registered identity maintenance UI, conflict recovery and localized layouts', {timeout:300000}, async t=>{
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
  const build=process.env.MODELDB_HOSTING_TEST_BUILD,screenshots=process.env.MODELDB_HOSTING_TEST_SCREENSHOTS;assert.ok(build);assert.ok(screenshots);mkdirSync(screenshots,{recursive:true});
  const options={...cfg,host:'127.0.0.1',port,publicBaseUrl:origin,securityMode:'registry' as const,securityAuthentication:{enabled:true,allowStorageMigration:true},securityRegistration:{descriptor,allowStorageMigration:true},securityHosting:{enabled:true,designerDirectory:build,managementPort:0},securityNetwork:{transport:{mode:'tls' as const,certificateFile:join(tls,'modeldb-a.crt'),privateKeyFile:join(tls,'modeldb-a.key')},data:{allowListEnabled:false}},securityAudit:{maxEvents:20000,retentionDays:365}};
  let app:Awaited<ReturnType<typeof buildDualTrackFastify>>|undefined,page:Awaited<ReturnType<typeof registrationBrowser>>|undefined,adminOrigin='';
  const local=(input:unknown)=>callLocalSecurity(dir,input);
  const click=async(selector:string)=>{await waitFor(()=>page!.evaluate<boolean>(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !!e&&!e.disabled;})()`),Boolean,30000);await page!.evaluate(`document.querySelector(${JSON.stringify(selector)}).click();true`);};
  const input=async(selector:string,value:string)=>{await page!.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);};
  const ready=()=>waitFor(()=>page!.evaluate<boolean>(`document.querySelector('.identity-admin')?.getAttribute('aria-busy')==='false'`),Boolean,30000);
  const tab=async(value:string)=>{await ready();await click('[data-admin-tab="'+value+'"]');await ready();};
  const reload=async()=>{await click('[data-admin-reload]');await ready();};
  const apply=async(name:string)=>{
    await page!.call('Page.navigate',{url:origin+'/designer/'});await waitFor(()=>page!.evaluate<boolean>(`document.querySelector('.designer-identity')?.getAttribute('aria-busy')==='false'`),Boolean,30000);
    await page!.evaluate(`document.querySelector('.designer-identity details').open=true;true`);await input('[data-identity-name]',name);await click('[data-identity-register]');
    await waitFor(()=>page!.evaluate<string>(`document.querySelector('[data-identity-state]')?.getAttribute('data-identity-state')`),v=>v==='pending',30000);
    return page!.evaluate<string>(`document.querySelector('[data-identity-state] dd').textContent`);
  };
  const management=async(first=false)=>{
    let url=adminOrigin+'/security/';if(first){const launch=await local({action:'browser.hosted.security.launch'}) as {origin:string;url:string;code:string};adminOrigin=launch.origin;url=hostedSecurityLaunchUrl(launch).href;}
    await page!.call('Page.navigate',{url});await waitFor(()=>page!.evaluate<boolean>(`!!document.querySelector('.security-center-navigation-title')`),Boolean,30000);
    const messages=JSON.parse(readFileSync(join('apps/model-designer/src/i18n/locales/zh/ui.json'),'utf8')) as Record<string,string>;
    await page!.evaluate(`(()=>{const s=document.querySelector('.designer-language-selector select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'zh');s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(()=>page!.evaluate<boolean>(`[...document.querySelectorAll('.security-center-navigation nav button')].some(b=>b.textContent===${JSON.stringify(messages.securityCenterTab_registered)})`),Boolean);
    await page!.evaluate(`[...document.querySelectorAll('.security-center-navigation nav button')].find(b=>b.textContent===${JSON.stringify(messages.securityCenterTab_registered)}).click();true`);await ready();
  };
  const review=async(id:string,action:string)=>{await click('[data-admin-entry="'+id+'"] [data-admin-action="'+action+'"]');};
  const preview=async()=>{await click('[data-admin-preview]');await waitFor(()=>page!.evaluate<boolean>(`document.activeElement===document.querySelector('[data-admin-review]')`),Boolean);assert.equal(await page!.evaluate<boolean>(`document.querySelector('[data-admin-submit]').disabled`),true);};
  const submit=async()=>{await click('[data-admin-confirm]');await click('[data-admin-submit]');await waitFor(()=>page!.evaluate<boolean>(`!!document.querySelector('[data-admin-success]')||!!document.querySelector('[data-admin-issue]')`),Boolean,30000);};
  const execute=async(id:string,action:string)=>{await review(id,action);await preview();await submit();assert.equal(await page!.evaluate<boolean>(`!!document.querySelector('[data-admin-success]')`),true,action);await reload();};
  const shot=async(scene:string)=>{
    for(const locale of ['zh','en','ja'])for(const width of [1280,390]){
      await page!.call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
      const messages=JSON.parse(readFileSync(join('apps/model-designer/src/i18n/locales',locale,'ui.json'),'utf8')) as Record<string,string>;
      await input('.designer-language-selector select',locale);
      await waitFor(()=>page!.evaluate<string>(`document.querySelector('.security-center-header h1')?.textContent`),v=>v===messages.securityCenterTab_registered);
      assert.equal(await page!.evaluate<boolean>(`(()=>{const r=document.querySelector('.identity-admin'),root=document.querySelector('.security-center-workspace');return root.lang===${JSON.stringify(locale)}&&document.documentElement.scrollWidth<=innerWidth&&r.scrollWidth<=r.clientWidth+1&&[...r.querySelectorAll('input,select')].every(e=>e.labels.length>0)&&!r.textContent.includes('identityAdmin_');})()`),true,'layout '+scene+locale+width);
      if(scene==='approval-review')await page!.evaluate(`document.querySelector('[data-admin-review]').scrollIntoView({block:'start',behavior:'instant'});true`);
      const image=await page!.call<{data:string}>('Page.captureScreenshot',{format:'png'});writeFileSync(join(screenshots,scene+'-'+locale+'-'+width+'.png'),Buffer.from(image.data,'base64'));
    }
    await page!.call('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
  };
  try{
    app=await buildDualTrackFastify(options);page=await registrationBrowser(root,spki.toString('base64'));
    const rejected=await apply('Synthetic reject admin UI');await management(true);await shot('applications');await execute(rejected,'registration.reject');
    await page.call('WebAuthn.clearCredentials',{authenticatorId:page.authenticatorId});
    const approved=await apply('Synthetic approve admin UI');await management();await review(approved,'registration.approve');await input('[data-admin-name]','Synthetic reviewed operator');
    // Exact scope is authored through actual themed form controls, not a direct API mutation.
    await page.evaluate(`(()=>{const b=[...document.querySelectorAll('.identity-admin-scopes button')].at(-1);b.click();})()`);
    await input('.identity-admin-scope input:nth-of-type(1)','synthetic_business');
    const fields=await page.evaluate<number>(`document.querySelectorAll('.identity-admin-scope input:not([type=checkbox])').length`);assert.equal(fields,3);
    await page.evaluate(`(()=>{const e=document.querySelectorAll('.identity-admin-scope input:not([type=checkbox])')[1];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'*');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await click('.identity-admin-actions input[type=checkbox]');await preview();await shot('approval-review');await submit();
    assert.equal(await page.evaluate<boolean>(`!!document.querySelector('[data-admin-success]')`),true);
    const credentials=await local({action:'registration.credentials.list',instanceId}) as {credentials:Array<{id:string;userId:string;state:string;grants:unknown[]}>};const key=credentials.credentials[0];assert.deepEqual(key.grants,scopes);
    await page.call('Page.navigate',{url:origin+'/designer/'});await waitFor(()=>page!.evaluate<boolean>(`!!document.querySelector('[data-identity-login]:not(:disabled)')`),Boolean,30000);
    assert.equal(await page.evaluate<number>(`fetch('/api/v1/security/session').then(r=>r.status)`),401,'Approval does not sign in');
    await click('[data-identity-login]');await waitFor(()=>page!.evaluate<boolean>(`!!document.querySelector('[data-identity-session="ready"]')`),Boolean,30000);
    assert.equal(await page.evaluate<number>(`fetch('/api/v1/security/context?database=synthetic_business').then(r=>r.status)`),200);
    assert.equal(await page.evaluate<number>(`fetch('/api/v1/security/admin/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'registration.list',instanceId:${JSON.stringify(instanceId)}})}).then(r=>r.status)`),404);
    await management();await tab('sessions');const dataSession=await page.evaluate<string>(`[...document.querySelectorAll('[data-admin-entry]')].find(e=>e.textContent.includes('registered-public-key')).getAttribute('data-admin-entry')`);await execute(dataSession,'registration.session.revoke');
    await tab('users');await execute(key.userId,'registration.user.disable');await execute(key.userId,'registration.user.enable');
    await tab('credentials');await review(key.id,'registration.credential.disable');await preview();
    await local({action:'registration.users.list',instanceId});await submit();
    assert.equal(await page.evaluate<string>(`document.querySelector('[data-admin-issue]')?.getAttribute('data-admin-issue')`),'conflict');
    assert.equal(await page.evaluate<boolean>(`!document.querySelector('[data-admin-review]')&&!document.querySelector('.identity-admin-editor')`),true);await shot('conflict');await reload();
    await execute(key.id,'registration.credential.disable');await execute(key.id,'registration.credential.enable');
    await review(key.id,'registration.credential.restrict');await click('.identity-admin-scope button');await preview();await submit();assert.equal(await page.evaluate<boolean>(`!!document.querySelector('[data-admin-success]')`),true);await reload();await shot('credentials');
    await page.call('WebAuthn.clearCredentials',{authenticatorId:page.authenticatorId});const replacement=await apply('Synthetic replacement admin UI');await management();await tab('credentials');await review(key.id,'registration.credential.replace');await input('.identity-admin-editor select',replacement);await preview();await submit();assert.equal(await page.evaluate<boolean>(`!!document.querySelector('[data-admin-success]')`),true);await reload();
    const replaced=await local({action:'registration.credentials.list',instanceId}) as {credentials:Array<{id:string;state:string}>};assert.equal(replaced.credentials.find(c=>c.id===key.id)!.state,'revoked');const nextKey=replaced.credentials.find(c=>c.id!==key.id)!;
    await reload();await execute(nextKey.id,'registration.credential.revoke');
    // Prepare unproved capacity records offline for pagination; do not relax source rate limits.
    await app.close();app=undefined;
    const setup=SecurityRegistry.open(dir);
    try {
      const store=setup.readRegistrationStorage(),at=Date.now();
      for(let i=0;i<8;i++)store.applications.push({id:randomUUID(),instanceId,serverOrigin:origin,rpId:descriptor.rpId,deploymentDescriptorSha256:descriptor.deploymentDescriptorSha256,displayName:'Synthetic page setup '+i,userHandle:randomBytes(32).toString('base64url'),continuationSecretHash:createHash('sha256').update(randomBytes(32)).digest('hex'),createdAtUtc:utc(at),expiresAtUtc:utc(at+3600000),state:'pending'});
      setup.commitRegistrationStorage(setup.status().revision,store);
    }finally{setup.close();}
    app=await buildDualTrackFastify(options);await management(true);await tab('applications');assert.equal(await page.evaluate<boolean>(`document.querySelector('[data-admin-previous]').disabled`),true);
    await click('[data-admin-next]');await ready();assert.equal(await page.evaluate<number>(`document.querySelectorAll('[data-admin-entry]').length`),1);await click('[data-admin-previous]');await ready();
    await tab('sessions');const active=await page.evaluate<string>(`[...document.querySelectorAll('[data-admin-entry]')].filter(e=>e.querySelector('[data-admin-action="registration.session.revoke"]')).at(-1).getAttribute('data-admin-entry')`);await review(active,'registration.session.revoke');await preview();await submit();await reload();
    assert.equal(await page.evaluate<string>(`document.querySelector('[data-admin-issue]')?.getAttribute('data-admin-issue')`),'failed');
    t.diagnostic(JSON.stringify({format:'modeldb.identity-admin-browser.v1',ok:true,browser:page.version,screenshots:24,hardwareAuthenticatorTested:false,systemTrustInstalled:false,liveMaterialRead:false,checks:{freshDesignerBuild:true,nativeDpapi:true,osPairedManagement:true,uiApproval:true,uiRejection:true,exactGrants:true,approvalRequiresLogin:true,actualWebAuthnLogin:true,dataListenerDenied:true,uiUserMaintenance:true,uiCredentialMaintenance:true,uiRestriction:true,uiReplacement:true,uiSessionRevoke:true,explicitConfirmation:true,conflictRequiresReload:true,noAutomaticRetry:true,pagination:true,localizedZhEnJa:true,wideAndNarrow:true,labelsAndFocus:true}}));
  }finally{await page?.close();await app?.close();}
});
