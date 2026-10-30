import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { verifyRegistrationResponse } from '../../packages/server/node_modules/@simplewebauthn/server/esm/index.js';
import { DEVICE_REGISTRATION_API_V1 as API, assertDeviceRegistrationStatusResponse } from '../../packages/shared/src/device-registration-contracts.js';
import { integrationFixture, syntheticProof, statusInput, scopes, sha, fillPendingCapacity } from '../fixtures/security-registration-integration.js';

test('HTTP registration, OS-local approval and private status retain exact identity, grants and audit after restart',async()=>{
  const f=await integrationFixture();try{
    const key=readFileSync(join(f.dir,'instance.key')),b=await f.begin(),proof=syntheticProof(f.instanceId,b);
    const pending=await f.post(API.complete,proof);assert.equal(pending.statusCode,202);assert.equal(pending.json().state,'pending');
    const page=f.local({action:'registration.list',instanceId:f.instanceId}) as {revision:number;applications:Array<{id:string;proofVerified:boolean;publicKeyFingerprint:string}>};
    const app=page.applications.find(a=>a.id===b.registrationId)!;assert.equal(app.proofVerified,true);
    assert.equal(app.publicKeyFingerprint,sha(Buffer.from(f.registry.readRegistrationStorage().applications[0]!.candidate!.publicKeyCose,'base64url')).toString('hex'));
    const approved=f.local(f.decision(b.registrationId,'registration.approve',page.revision)) as {credentialId:string;principalId:string};
    const response=await f.post(API.status,statusInput(f.instanceId,b));assert.equal(response.statusCode,200);assertDeviceRegistrationStatusResponse(response.json());assert.equal(response.json().state,'approved');
    assert.equal(response.headers['set-cookie'],undefined);assert.equal(response.headers['access-control-allow-origin'],undefined);
    assert.deepEqual(Object.keys(response.json()).sort(),['approvedAtUtc','createdAtUtc','expiresAtUtc','format','instanceId','registrationId','state','version']);
    assert.equal(f.registry.status().sessions,0);assert.equal(f.registry.listCredentials().length,0);
    assert.throws(()=>f.registry.authenticate(approved.credentialId),{code:'SECURITY_CREDENTIAL_INVALID'});
    await f.reopen();
    const store=f.registry.readRegistrationStorage();assert.equal(store.credentials[0]!.id,approved.credentialId);assert.deepEqual(store.credentials[0]!.grants,scopes);
    assert.equal(store.users[0]!.principalId,approved.principalId);assert.equal(store.credentials[0]!.rawId,proof.credential.rawId);
    assert.equal((await f.post(API.status,statusInput(f.instanceId,b))).json().state,'approved');
    assert.deepEqual(readFileSync(join(f.dir,'instance.key')),key);
    const audit=JSON.stringify(f.registry.auditEvents());
    for(const secret of [b.continuationSecret,b.publicKey.challenge,proof.credential.rawId,proof.credential.response.clientDataJSON,proof.credential.response.attestationObject])assert.equal(audit.includes(secret),false,'Audit must exclude registration material');
    assert.equal(f.registry.auditEvents().filter(e=>e.action==='registration.approve'&&e.result==='succeeded').length,1);
  }finally{await f.stop();}
});

test('HTTP invalid proof is terminal, cannot be approved and never creates a partial identity',async()=>{
  const f=await integrationFixture();try{
    const b=await f.begin(),r=await f.post(API.complete,syntheticProof(f.instanceId,b,0x41));
    assert.equal(r.statusCode,401);assert.equal(r.json().code,'SECURITY_REGISTRATION_PROOF_INVALID');
    assert.throws(()=>f.local(f.decision(b.registrationId)),{code:'SECURITY_POLICY_CONFLICT'});
    await f.reopen();const store=f.registry.readRegistrationStorage();assert.equal(store.applications[0]!.state,'rejected');assert.equal(store.credentials.length,0);assert.equal(store.users.length,0);
    assert.equal((await f.post(API.status,statusInput(f.instanceId,b))).json().state,'rejected');
  }finally{await f.stop();}
});

test('in-flight verified HTTP completion loses to local rejection; two decisions with one revision commit at most once',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
  const f=await integrationFixture(async opts=>{entered();await gate;return verifyRegistrationResponse(opts);});
  try{
    const b=await f.begin(),attempt=f.post(API.complete,syntheticProof(f.instanceId,b));
    // Injection is lazy; start it before awaiting the verifier rendezvous.
    const completion=Promise.resolve(attempt);await ready;
    f.local(f.decision(b.registrationId,'registration.reject'));release();
    const result=await completion;assert.equal(result.statusCode,409);assert.equal(result.json().code,'SECURITY_REGISTRATION_CONFLICT');
    const next=await f.begin();assert.equal((await f.post(API.complete,syntheticProof(f.instanceId,next))).statusCode,202);
    const revision=f.registry.status().revision;
    const results=await Promise.allSettled([Promise.resolve().then(()=>f.local(f.decision(next.registrationId,'registration.approve',revision))),Promise.resolve().then(()=>f.local(f.decision(next.registrationId,'registration.reject',revision)))]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    const failed=results.find(r=>r.status==='rejected') as PromiseRejectedResult;assert.equal(failed.reason.code,'SECURITY_POLICY_CONFLICT');
    await f.reopen();assert.equal(f.registry.readRegistrationStorage().credentials.length,1);assert.equal(f.registry.readRegistrationStorage().applications[0]!.state,'rejected');
  }finally{release();await f.stop();}
});

test('HTTP capacity refuses new admission while a verified local rejection remains available',async()=>{
  const f=await integrationFixture();try{
    fillPendingCapacity(f.registry,f.now,999);
    const b=await f.begin();assert.equal((await f.post(API.complete,syntheticProof(f.instanceId,b))).statusCode,202);
    const r=await f.post(API.begin,{format:'modeldb.device-registration.v1',version:1,instanceId:f.instanceId,deploymentDescriptorSha256:'a'.repeat(64),displayName:'Overflow',userVerification:'required'});
    assert.equal(r.statusCode,503);assert.equal(r.json().code,'SECURITY_REGISTRATION_CAPACITY');assert.equal(r.headers['retry-after'],'60');
    f.local(f.decision(b.registrationId,'registration.reject'));assert.equal(f.registry.readRegistrationStorage().applications.find(a=>a.id===b.registrationId)!.state,'rejected');
    assert.equal(f.registry.readRegistrationStorage().credentials.length,0);
    f.advance(60001);await f.reopen();assert.equal(f.registry.readRegistrationStorage().applications.filter(a=>a.state==='pending').length,0);
  }finally{await f.stop();}
});

test('HTTP final candidate write failure returns stable 503; restart rejects consumed work without a candidate or access',async()=>{
  let verified!:()=>void;const gate=new Promise<void>(r=>verified=r);
  let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
  const f=await integrationFixture(async opts=>{const proof=await verifyRegistrationResponse(opts);entered();await gate;return proof;});
  try{
    const b=await f.begin(),completion=Promise.resolve(f.post(API.complete,syntheticProof(f.instanceId,b)));await ready;
    f.fail(true);verified();const r=await completion;assert.equal(r.statusCode,503);assert.equal(r.json().code,'SECURITY_REGISTRATION_CAPACITY');assert.equal(r.headers['retry-after'],'60');
    assert.deepEqual(Object.keys(r.json()).sort(),['code','format','requestId','retryAfterSeconds','version']);
    await f.reopen();const store=f.registry.readRegistrationStorage();assert.equal(store.applications[0]!.state,'rejected');assert.equal(store.applications[0]!.candidate,undefined);assert.equal(store.credentials.length,0);assert.equal(store.users.length,0);
    assert.equal(f.registry.status().sessions,0);assert.equal((await f.post(API.complete,syntheticProof(f.instanceId,b))).statusCode,409);
  }finally{verified();f.fail(false);await f.stop();}
});

for(const point of ['staged','journaled','replaced'] as const){
  test('full HTTP-to-approval child process hard exit at '+point+' recovers identity and audit together',async()=>{
    const f=await integrationFixture();try{
      const b=await f.begin();assert.equal((await f.post(API.complete,syntheticProof(f.instanceId,b))).statusCode,202);
      const revision=f.registry.status().revision,request=f.decision(b.registrationId,'registration.approve',revision),key=readFileSync(join(f.dir,'instance.key'));
      await f.stop();
      const child=spawnSync(process.execPath,['--import','tsx',resolve('test/fixtures/security-registration-approval-child.ts')],{cwd:resolve('.'),windowsHide:true,encoding:'utf8',timeout:30000,input:JSON.stringify({directory:f.dir,key:f.key.toString('base64'),now:f.now,point,request})});
      assert.equal(child.status,86,'Child must terminate at the selected durable point');assert.equal(child.stdout,'');assert.equal(child.stderr,'');
      await f.resume();const store=f.registry.readRegistrationStorage(),committed=point==='staged'?0:1;
      assert.equal(store.credentials.length,committed);assert.equal(store.users.length,committed);assert.equal(store.applications[0]!.state,committed?'approved':'pending');
      assert.equal(f.registry.auditEvents().filter(e=>e.action==='registration.approve'&&e.result==='succeeded').length,committed);
      if(committed)assert.deepEqual(store.credentials[0]!.grants,scopes);
      assert.equal((await f.post(API.status,statusInput(f.instanceId,b))).json().state,committed?'approved':'pending');assert.equal(f.registry.status().sessions,0);
      assert.deepEqual(readFileSync(join(f.dir,'instance.key')),key);
    }finally{await f.stop();}
  });
}
