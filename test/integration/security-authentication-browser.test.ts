import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { ensureModelDbLayoutAtRoot } from '../../packages/server/src/modeldb-default-home.js';
import { loadModelDBServerConfig } from '../../packages/server/src/config-loader.js';
import { buildDualTrackFastify } from '../../packages/server/src/dual-track-app.js';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';
import { callLocalSecurity } from '../../packages/server/src/security/local-management-channel.js';
import { registrationBrowser, waitFor } from '../fixtures/security-registration-browser.js';
import { scopes, utc } from '../fixtures/security-registration-integration.js';
import type { DeviceRegistrationConnectionDescriptorV1 } from '../../packages/shared/src/device-registration-contracts.js';

test('required Chrome WebAuthn get, fresh SDK, native TLS/DPAPI approval and cookie recovery/refresh/logout', {timeout:150000}, async t=>{
  assert.equal(process.platform,'win32','Native Windows acceptance cannot be skipped');
  const root=mkdtempSync(join(tmpdir(),'ModeDB-Authentication-Native-')),dir=join(root,'security');
  const cfg=await loadModelDBServerConfig(ensureModelDbLayoutAtRoot(root),{port:0});
  const registry=SecurityRegistry.open(dir),instanceId=registry.status().instanceId;registry.close();
  const key=readFileSync(join(dir,'instance.key'));
  const reservation=createServer();await new Promise<void>((done,fail)=>{reservation.once('error',fail);reservation.listen(0,'127.0.0.1',done);});
  const address=reservation.address();assert.ok(address&&typeof address!=='string');const port=address.port;
  await new Promise<void>((done,fail)=>reservation.close(e=>e?fail(e):done()));
  const origin=`https://modeldb-a.example.test:${port}`,tls=fileURLToPath(new URL('../fixtures/security-registration-tls/',import.meta.url));
  const cert=new X509Certificate(readFileSync(join(tls,'modeldb-a.crt'))),spki=createHash('sha256').update(cert.publicKey.export({type:'spki',format:'der'})).digest();
  const now=Date.now(),descriptor:DeviceRegistrationConnectionDescriptorV1={format:'modeldb.device-registration-connection.v1',version:1,instanceId,serverOrigin:origin,rpId:'modeldb-a.example.test',registrationMode:'enabled',issuedAtUtc:utc(now-1000),expiresAtUtc:utc(now+3600000),deploymentDescriptorSha256:'a'.repeat(64),tls:{mode:'owner-pinned',minVersion:'TLS1.2',spkiSha256:spki.toString('hex')}};
  const options={...cfg,host:'127.0.0.1',port,publicBaseUrl:origin,securityMode:'registry' as const,securityAuthentication:{enabled:true,allowStorageMigration:true},securityRegistration:{descriptor,allowStorageMigration:true},securityNetwork:{transport:{mode:'tls' as const,certificateFile:join(tls,'modeldb-a.crt'),privateKeyFile:join(tls,'modeldb-a.key')},data:{allowListEnabled:false}},securityAudit:{maxEvents:10000,retentionDays:365}};
  const repository=fileURLToPath(new URL('../../',import.meta.url));
  const {build}=createRequire(realpathSync(join(repository,'node_modules/tsx/package.json')))('esbuild');
  const bundled=await build({absWorkingDir:repository,entryPoints:['packages/sdk/src/index.ts'],bundle:true,platform:'browser',format:'iife',globalName:'drillSdk',write:false,alias:{'@mode-db/shared':join(repository,'packages/shared/src/index.ts')},logLevel:'silent'});
  const bundle:string=bundled.outputFiles[0].text;
  let app:Awaited<ReturnType<typeof buildDualTrackFastify>>|undefined,page:Awaited<ReturnType<typeof registrationBrowser>>|undefined;
  const local=(input:unknown)=>callLocalSecurity(dir,input);
  const preparePage=async()=>{
    await page!.call('Page.navigate',{url:origin+'/security/authentication/v1/capabilities'});
    await waitFor(()=>page!.evaluate<boolean>('document.readyState === "complete" && location.origin === '+JSON.stringify(origin)),Boolean);
    await page!.evaluate(bundle+'; true');
    await page!.evaluate(`globalThis.authConfig={host:${JSON.stringify(origin)},port:${port}}; globalThis.authBinding={format:'modeldb.device-authentication.v1',version:1,instanceId:${JSON.stringify(instanceId)},deploymentDescriptorSha256:'${'a'.repeat(64)}'};true`);
  };
  try{
    app=await buildDualTrackFastify(options);page=await registrationBrowser(root,spki.toString('base64'));await preparePage();
    const enrollment=await page.evaluate<{id:string;rawId:string}>(`(async()=>{
      const post=async(path,body)=>{const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error('SYNTHETIC_REGISTRATION_FAILED');return r.json();};
      const decode=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
      const encode=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
      const base={...authBinding,format:'modeldb.device-registration.v1'},b=await post('/security/registration/v1/begin',{...base,displayName:'Synthetic authentication browser',userVerification:'required'});
      const c=await navigator.credentials.create({publicKey:{...b.publicKey,challenge:decode(b.publicKey.challenge),user:{...b.publicKey.user,id:decode(b.publicKey.user.id)}}});
      const result=await post('/security/registration/v1/complete',{...base,registrationId:b.registrationId,continuationSecret:b.continuationSecret,challengeId:b.challengeId,credential:{id:c.id,rawId:encode(c.rawId),type:c.type,clientExtensionResults:{},response:{clientDataJSON:encode(c.response.clientDataJSON),attestationObject:encode(c.response.attestationObject)}}});
      if(result.state!=='pending')throw Error('SYNTHETIC_PENDING_REQUIRED');return {id:b.registrationId,rawId:c.id};
    })()`);
    const pending=await page.evaluate<string>(`drillSdk.loginBrowserSession(authConfig,authBinding).then(()=> 'UNEXPECTED_SUCCESS',e=>e.code)`);assert.equal(pending,'SECURITY_AUTHENTICATION_PROOF_INVALID');
    const list=await local({action:'registration.list',instanceId}) as {revision:number};
    await local({action:'registration.approve',instanceId,id:enrollment.id,revision:list.revision,confirm:true,name:'Synthetic authenticated operator',grants:scopes});
    const info=await page.evaluate<{csrf:string;securityAdmin:boolean;absoluteExpiresAt:string;expiresAt:string;error?:string}>(`drillSdk.loginBrowserSession(authConfig,authBinding).catch(e=>({error:e.code||e.name}))`);
    assert.equal(info.error,undefined,'Approved browser login returned '+info.error);
    assert.match(info.csrf,/^[a-f0-9]{64}$/);assert.equal(info.securityAdmin,false);assert.ok(Date.parse(info.absoluteExpiresAt)-Date.parse(info.expiresAt)===7.5*3600000);
    assert.equal(await page.evaluate<string>('document.cookie'),'');
    const cookies=await page.call<{cookies:Array<{name:string;httpOnly:boolean;secure:boolean;sameSite:string;value:string}>}>('Network.getCookies',{urls:[origin]});
    const cookie=cookies.cookies.find(c=>c.name.startsWith('mdbs_session_'))!;assert.ok(cookie);assert.equal(cookie.httpOnly,true);assert.equal(cookie.secure,true);assert.equal(cookie.sameSite,'Strict');
    assert.equal(await page.evaluate<number>(`fetch('/api/v1/security/context?database=synthetic_business').then(r=>r.status)`),200);
    assert.equal(await page.evaluate<number>(`fetch('/api/v1/security/admin/overview').then(r=>r.status)`),403);
    await preparePage();const restored=await page.evaluate<{csrf:string}>('drillSdk.getBrowserSession(authConfig)');assert.equal(restored.csrf,info.csrf);
    const refreshed=await page.evaluate<{csrf:string;absoluteExpiresAt:string}>('drillSdk.refreshBrowserSession(authConfig)');assert.notEqual(refreshed.csrf,info.csrf);assert.equal(refreshed.absoluteExpiresAt,info.absoluteExpiresAt);
    assert.equal(await page.evaluate<number>(`fetch('/api/v1/security/session/logout',{method:'POST',headers:{'x-modeldb-csrf':${JSON.stringify(info.csrf)}}}).then(r=>r.status)`),403);
    await app.close();app=undefined;
    app=await buildDualTrackFastify({...options,securityAuthentication:{enabled:false},securityRegistration:{descriptor:{...descriptor,registrationMode:'disabled'}}});
    const restart=await page.evaluate<{csrf:string}>('drillSdk.getBrowserSession(authConfig)');assert.equal(restart.csrf,refreshed.csrf);
    assert.equal(await page.evaluate<string>(`drillSdk.loginBrowserSession(authConfig,authBinding).then(()=> 'UNEXPECTED_SUCCESS',e=>e.code)`),'SECURITY_AUTHENTICATION_DISABLED');
    await page.evaluate('drillSdk.logoutBrowserSession(authConfig).then(()=>true)');
    assert.equal(await page.evaluate<number>(`fetch('/api/v1/security/session').then(r=>r.status)`),401);
    await app.close();app=undefined;
    // Closed/expired public registration windows must not invalidate an approved identity.
    app=await buildDualTrackFastify({...options,securityRegistration:{descriptor:{...descriptor,registrationMode:'disabled',issuedAtUtc:utc(now-7200000),expiresAtUtc:utc(now-3600000)}}});
    assert.match((await page.evaluate<{csrf:string}>('drillSdk.loginBrowserSession(authConfig,authBinding)')).csrf,/^[a-f0-9]{64}$/);
    await page.evaluate('drillSdk.logoutBrowserSession(authConfig).then(()=>true)');
    await app.close();app=undefined;
    const final=SecurityRegistry.open(dir);try{assert.equal(final.registrationStorageStatus().ledgerVersion,4);assert.equal(final.readRegistrationStorage().credentials.length,1);assert.equal(final.readRegistrationStorage().credentials[0]!.state,'active');assert.equal(final.listCredentials().length,0);assert.equal(final.auditEvents().filter(e=>e.action==='authentication.login').length,2);}finally{final.close();}
    assert.deepEqual(readFileSync(join(dir,'instance.key')),key);
    t.diagnostic(JSON.stringify({format:'modeldb.authentication-browser.v1',ok:true,browser:page.version,checks:{actualBrowserWebAuthnGet:true,freshSdkBundle:true,nativeTlsDpapiApproval:true,pendingDenied:true,httpOnlySecureStrict:true,dataScope:true,adminDenied:true,reloadRecovery:true,csrfRotation:true,logout:true,restartRecovery:true,disabledNewLogin:true,expiredRegistrationIndependent:true,noApiCredential:true,instanceKeyUnchanged:true},hardwareAuthenticatorTested:false,systemTrustInstalled:false}));
  }finally{await page?.close();await app?.close();}
});
