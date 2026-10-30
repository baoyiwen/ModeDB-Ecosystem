import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ensureModelDbLayoutAtRoot } from '../../packages/server/src/modeldb-default-home.js';
import { loadModelDBServerConfig } from '../../packages/server/src/config-loader.js';
import { buildDualTrackFastify } from '../../packages/server/src/dual-track-app.js';
import { callLocalSecurity } from '../../packages/server/src/security/local-management-channel.js';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';
import type { DeviceRegistrationConnectionDescriptorV1 } from '../../packages/shared/src/device-registration-contracts.js';
import { DEVICE_REGISTRATION_API_V1 as API } from '../../packages/shared/src/device-registration-contracts.js';
import { fillPendingCapacity, scopes, utc } from '../fixtures/security-registration-integration.js';
import { registrationBrowser, waitFor } from '../fixtures/security-registration-browser.js';

test('required Chrome virtual authenticator, native HTTPS/DPAPI and local CLI cover approval, proof denial, competition, capacity and restart', {timeout:240000},async t=>{
  assert.equal(process.platform,'win32','Windows DPAPI/Named Pipe acceptance is required, not skippable');
  const root=mkdtempSync(join(tmpdir(),'ModeDB-Registration-Native-Flow-')),dir=join(root,'security');
  const config=ensureModelDbLayoutAtRoot(root),cfg=await loadModelDBServerConfig(config,{port:0});
  const registry=SecurityRegistry.open(dir),instanceId=registry.status().instanceId,key=readFileSync(join(dir,'instance.key'));registry.close();
  // Reserve a random loopback port for exact HTTPS Origin binding. A bind race fails this test.
  const reservation=createServer();await new Promise<void>((done,fail)=>{reservation.once('error',fail);reservation.listen(0,'127.0.0.1',done);});
  const address=reservation.address();assert.ok(address&&typeof address!=='string');const port=address.port;
  await new Promise<void>((done,fail)=>reservation.close(e=>e?fail(e):done()));
  const origin=`https://modeldb-a.example.test:${port}`,tls=fileURLToPath(new URL('../fixtures/security-registration-tls/',import.meta.url));
  const cert=new X509Certificate(readFileSync(join(tls,'modeldb-a.crt'))),spki=createHash('sha256').update(cert.publicKey.export({type:'spki',format:'der'})).digest();
  const now=Date.now();const descriptor:DeviceRegistrationConnectionDescriptorV1={format:'modeldb.device-registration-connection.v1',version:1,instanceId,serverOrigin:origin,rpId:'modeldb-a.example.test',registrationMode:'enabled',issuedAtUtc:utc(now-1000),expiresAtUtc:utc(now+3600000),deploymentDescriptorSha256:'a'.repeat(64),tls:{mode:'owner-pinned',minVersion:'TLS1.2',spkiSha256:spki.toString('hex')}};
  const options={...cfg,port,host:'127.0.0.1',publicBaseUrl:origin,securityNetwork:{transport:{mode:'tls' as const,certificateFile:join(tls,'modeldb-a.crt'),privateKeyFile:join(tls,'modeldb-a.key')}},securityRegistration:{descriptor,allowStorageMigration:true}};
  let app:Awaited<ReturnType<typeof buildDualTrackFastify>>|undefined,page:Awaited<ReturnType<typeof registrationBrowser>>|undefined;
  const cli=(args:string[])=>new Promise<{code:number|null;output:string}>((done,fail)=>{
    const child=spawn(process.execPath,['--import','tsx','packages/server/src/cli.ts','security',...args,'-c',config],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='';const timer=setTimeout(()=>{child.kill();fail(Error('REGISTRATION_NATIVE_CLI_TIMEOUT'));},30000);
    child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.once('error',e=>{clearTimeout(timer);fail(e);});child.once('close',code=>{clearTimeout(timer);done({code,output});});
  });
  const local=(input:unknown)=>callLocalSecurity(dir,input);
  const list=async()=>{const result=await cli(['registration-list','--instance',instanceId]);assert.equal(result.code,0,'Native CLI list failed');return JSON.parse(result.output) as {revision:number;applications:Array<{id:string;state:string;proofVerified:boolean;publicKeyFingerprint?:string}>};};
  try{
    app=await buildDualTrackFastify(options);page=await registrationBrowser(root,spki.toString('base64'));
    await page.call('Page.navigate',{url:origin+API.capabilities});
    await waitFor(()=>page!.evaluate<boolean>('document.readyState === "complete" && location.origin === '+JSON.stringify(origin)),Boolean);
    assert.equal(await page.evaluate<boolean>('isSecureContext && !!navigator.credentials && !!PublicKeyCredential'),true);
    await page.evaluate(`(() => {
      const api=${JSON.stringify(API)}, instanceId=${JSON.stringify(instanceId)}, format='modeldb.device-registration.v1';
      const decode=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
      const encode=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
      const post=async(path,body)=>{const r=await fetch(path,{method:'POST',credentials:'omit',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie'),cors:r.headers.get('access-control-allow-origin'),retry:r.headers.get('retry-after')};};
      globalThis.drill={api,post,requests:[],async begin(){const b=await post(api.begin,{format,version:1,instanceId,deploymentDescriptorSha256:'a'.repeat(64),displayName:'Virtual authenticator test',userVerification:'required'});if(b.status!==201)return {status:b.status,code:b.body.code,retry:b.retry};this.requests.push({begin:b.body,statusInput:{format,version:1,instanceId,registrationId:b.body.registrationId,continuationSecret:b.body.continuationSecret}});return {status:b.status,index:this.requests.length-1,id:b.body.registrationId};},async create(i){const r=this.requests[i],b=r.begin;const credential=await navigator.credentials.create({publicKey:{...b.publicKey,challenge:decode(b.publicKey.challenge),user:{...b.publicKey.user,id:decode(b.publicKey.user.id)}}});r.complete={...r.statusInput,deploymentDescriptorSha256:'a'.repeat(64),challengeId:b.challengeId,credential:{id:credential.id,rawId:encode(credential.rawId),type:credential.type,clientExtensionResults:credential.getClientExtensionResults(),response:{clientDataJSON:encode(credential.response.clientDataJSON),attestationObject:encode(credential.response.attestationObject),transports:credential.response.getTransports()}}};return true;}};
      return true;
    })()`);
    const begin=()=>page!.evaluate<{status:number;index:number;id:string;code?:string;retry?:string}>('drill.begin()');
    const a=await begin();assert.equal(a.status,201);await page.evaluate(`drill.create(${a.index})`);
    const pending=await page.evaluate<{status:number;state:string;cookie:unknown;cors:unknown}>(`(async()=>{const r=await drill.post(drill.api.complete,drill.requests[${a.index}].complete);return {status:r.status,state:r.body.state,cookie:r.cookie,cors:r.cors};})()`);
    assert.deepEqual(pending,{status:202,state:'pending',cookie:null,cors:null});
    const initial=await page.evaluate<{state:string;keys:string[]}>(`(async()=>{const r=await drill.post(drill.api.status,drill.requests[${a.index}].statusInput);return {state:r.body.state,keys:Object.keys(r.body)};})()`);assert.equal(initial.state,'pending');assert.equal(initial.keys.includes('credentialId'),false);
    const b=await begin();assert.equal(b.status,201);await page.evaluate(`drill.create(${b.index})`);
    const denied=await page.evaluate<{status:number;code:string}>(`(async()=>{const r=drill.requests[${b.index}];const data=JSON.parse(atob(r.complete.credential.response.clientDataJSON.replace(/-/g,'+').replace(/_/g,'/')));data.challenge='A'.repeat(43);r.complete.credential.response.clientDataJSON=btoa(JSON.stringify(data)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');const result=await drill.post(drill.api.complete,r.complete);return {status:result.status,code:result.body.code};})()`);
    assert.deepEqual(denied,{status:401,code:'SECURITY_REGISTRATION_PROOF_INVALID'});
    const c=await begin();assert.equal(c.status,201);await page.evaluate(`drill.create(${c.index})`);
    const race=await page.evaluate<number[]>(`Promise.all([drill.post(drill.api.complete,drill.requests[${c.index}].complete),drill.post(drill.api.complete,drill.requests[${c.index}].complete)]).then(r=>r.map(x=>x.status).sort())`);assert.deepEqual(race,[202,409]);
    const d=await begin();assert.equal(d.status,201);
    let entries=await list();assert.equal(entries.applications.find(r=>r.id===a.id)!.proofVerified,true);assert.match(entries.applications.find(r=>r.id===a.id)!.publicKeyFingerprint!,/^[a-f0-9]{64}$/);
    const grants=join(root,'synthetic-grants.json');writeFileSync(grants,JSON.stringify(scopes));
    const approved=await cli(['registration-approve','--instance',instanceId,'--id',a.id,'--revision',String(entries.revision),'--name','Virtual test operator','--grants-file',grants,'--yes']);assert.equal(approved.code,0,'Native CLI approval failed');
    const decision=JSON.parse(approved.output) as {state:string;credentialId:string};assert.equal(decision.state,'approved');
    entries=await list();const revision=entries.revision;
    const rejected=await cli(['registration-reject','--instance',instanceId,'--id',d.id,'--revision',String(revision),'--yes']);assert.equal(rejected.code,0,'Native CLI rejection failed');
    await assert.rejects(()=>local({action:'registration.approve',instanceId,id:c.id,revision,confirm:true,name:'Stale revision',grants:scopes}),{code:'SECURITY_POLICY_CONFLICT'});
    const current=await list();
    await local({action:'registration.reject',instanceId,id:c.id,revision:current.revision,confirm:true});
    await waitFor(()=>page!.evaluate<string>(`drill.post(drill.api.status,drill.requests[${a.index}].statusInput).then(r=>r.body.state || r.body.code)`),v=>v==='approved',10000);
    const rpc=await page.evaluate<number>(`fetch('/api/v1/rpc',{method:'POST',credentials:'omit',headers:{'content-type':'application/json','authorization':'Bearer '+${JSON.stringify(decision.credentialId)}},body:JSON.stringify({atlas:'synthetic_business',body:{op:'executeQuery',snapshot:{}}})}).then(r=>r.status)`);assert.equal(rpc,401);
    const cookies=await page.call<{cookies:unknown[]}>('Network.getCookies',{urls:[origin]});assert.equal(cookies.cookies.length,0);
    const status=await local({action:'status'}) as {sessions:number;credentials:number};assert.equal(status.sessions,0);assert.equal(status.credentials,0);
    await app.close();app=undefined;
    const r=SecurityRegistry.open(dir);try{
      const store=r.readRegistrationStorage();assert.equal(store.applications.find(x=>x.id===a.id)!.state,'approved');assert.equal(store.applications.find(x=>x.id===b.id)!.state,'rejected');assert.equal(store.applications.find(x=>x.id===d.id)!.state,'rejected');assert.deepEqual(store.credentials[0]!.grants,scopes);
      assert.equal(r.auditEvents().filter(e=>e.action==='registration.approve'&&e.result==='succeeded').length,1);
      // Wait for earlier challenges to elapse, then reclaim them through a valid
      // transition. Otherwise startup reclamation changes the boundary mid-test.
      const remaining=Math.max(0,...store.challenges.map(ch=>Date.parse(ch.expiresAtUtc)-Date.now()));
      assert.ok(remaining<=60000);
      if(remaining>0)await new Promise<void>(done=>setTimeout(done,remaining+100));
      store.challenges=[];r.commitRegistrationStorage(r.status().revision,store);
      // Capacity-only trusted setup; the browser exercises the actual 1000-challenge boundary.
      fillPendingCapacity(r,Date.now(),999);
    }finally{r.close();}
    app=await buildDualTrackFastify(options);
    const boundary=await begin();assert.equal(boundary.status,201);await page.evaluate(`drill.create(${boundary.index})`);
    assert.equal(await page.evaluate<number>(`drill.post(drill.api.complete,drill.requests[${boundary.index}].complete).then(r=>r.status)`),202);
    const full=await begin();assert.equal(full.status,503);assert.equal(full.code,'SECURITY_REGISTRATION_CAPACITY');assert.equal(full.retry,'60');
    const pageAtCapacity=await list();
    await local({action:'registration.reject',instanceId,id:boundary.id,revision:pageAtCapacity.revision,confirm:true});
    await app.close();app=undefined;
    app=await buildDualTrackFastify({...options,securityRegistration:{descriptor:{...descriptor,registrationMode:'disabled'}}});
    const disabled=await page.evaluate<{mode:string}>('fetch(drill.api.capabilities,{credentials:"omit"}).then(r=>r.json())');assert.equal(disabled.mode,'disabled');
    const restored=await page.evaluate<{state:string;keys:string[]}>(`drill.post(drill.api.status,drill.requests[${a.index}].statusInput).then(r=>({state:r.body.state,keys:Object.keys(r.body)}))`);assert.equal(restored.state,'approved');assert.equal(restored.keys.includes('grants'),false);
    assert.deepEqual(readFileSync(join(dir,'instance.key')),key);
    t.diagnostic(JSON.stringify({format:'modeldb.registration-virtual-authenticator.v1',ok:true,browser:page.version,checks:{actualBrowserWebAuthn:true,nativeHttpsDpapiCli:true,approval:true,proofRejected:true,singleUseCompetition:true,revisionConflict:true,outstandingChallengeCapacity1000:true,localRepairAtCapacity:true,restartWithRegistrationDisabled:true,noBusinessSession:true,instanceKeyUnchanged:true},capacityPreparation:'Synthetic unverified issued records fill all but one challenge slot; real browser exercises boundary, not 1000 authenticators',hardwareAuthenticatorTested:false,systemTrustInstalled:false}));
  }finally{await page?.close();await app?.close();}
});
