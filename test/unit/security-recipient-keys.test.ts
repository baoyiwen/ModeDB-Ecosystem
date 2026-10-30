import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { integrationFixture, syntheticProof, SID, syntheticProtector } from '../fixtures/security-registration-integration.js';
import { hostingFixture } from '../fixtures/security-hosting.js';
import { DEVICE_REGISTRATION_API_V1 as API } from '../../packages/shared/src/device-registration-contracts.js';
import type { RecipientChallenge, RecipientKeyPage } from '../../packages/shared/src/recipient-keys.js';
import { answerRecipientChallenge, recipientPublicKey, beginRecipientChallenge, emptyRecipientLedger } from '../../packages/server/src/security/recipient-keys.js';
import { isoCBOR } from '../../packages/server/node_modules/@simplewebauthn/server/esm/helpers/index.js';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';

const pairs=Array.from({length:4},()=>generateKeyPairSync('rsa',{modulusLength:3072}));
const pem=(i=0)=>pairs[i].publicKey.export({type:'spki',format:'pem'}).toString();
async function fixture(initialize=true,onCommitPoint?: Parameters<typeof integrationFixture>[1]) {
  const f=await integrationFixture(undefined,onCommitPoint);
  f.registry.migrateAuthenticationStorage(f.registry.status().revision);
  const b=await f.begin();assert.equal((await f.post(API.complete,syntheticProof(f.instanceId,b))).statusCode,202);
  const approved=f.local(f.decision(b.registrationId)) as {userId:string;credentialId:string};
  const command=(action:string,extra:Record<string,unknown>={})=>({action:'registration.recipient.'+action,instanceId:f.instanceId,...(action==='list'?{}:{revision:f.registry.status().revision,confirm:true}),...extra});
  const call=(action:string,extra:Record<string,unknown>={})=>f.local(command(action,extra));
  if(initialize) { call('initialize'); }
  const begin=(i=0)=>call('begin',{userId:approved.userId,publicKey:pem(i)}) as {revision:number;challenge:RecipientChallenge};
  const complete=(challenge:RecipientChallenge,i=0)=>call('complete',{response:answerRecipientChallenge(challenge,pairs[i].privateKey,f.now)});
  const page=()=>call('list') as RecipientKeyPage;
  return {f,...approved,command,call,begin,complete,page};
}
test('explicit V4 to V5 initialization preserves access and ordinary reopen does not migrate',async()=>{
  const x=await fixture(false);try{
    assert.equal(x.f.registry.registrationStorageStatus().ledgerVersion,4);await x.f.reopen();assert.equal(x.f.registry.registrationStorageStatus().ledgerVersion,4);
    const before=x.f.registry.securityCenterSnapshot();x.call('initialize');assert.equal(x.f.registry.registrationStorageStatus().ledgerVersion,5);
    const after=x.f.registry.securityCenterSnapshot();assert.deepEqual(after.credentials,before.credentials);assert.deepEqual(after.principals,before.principals);assert.deepEqual(after.keyReferences,before.keyReferences);
    await x.f.reopen();assert.equal(x.page().initialized,true);assert.ok(x.f.registry.readRegistrationStorage().credentials.some(c=>c.id===x.credentialId));
    const rev=x.f.registry.status().revision;x.call('initialize');assert.equal(x.f.registry.status().revision,rev);
  }finally{await x.f.stop();}
});
test('real OAEP proof associates a version; replacement and retirement retain historical keys',async()=>{
  const x=await fixture();try{
    const first=x.begin();assert.equal(first.challenge.keyVersion,1);x.complete(first.challenge);
    const one=x.page().keys[0];assert.equal(one.state,'active');assert.equal(one.fingerprint,recipientPublicKey(pem()).fingerprint);
    const second=x.begin(1);assert.equal(second.challenge.previousKeyId,one.id);x.complete(second.challenge,1);
    const page=x.page();assert.deepEqual(page.keys.map(k=>[k.keyVersion,k.state]),[[1,'retired'],[2,'active']]);
    x.call('retire',{id:page.keys[1].id});assert.equal(x.page().keys.filter(k=>k.state==='active').length,0);
    const third=x.begin(2);assert.equal(third.challenge.keyVersion,3);assert.equal(third.challenge.previousKeyId,null);x.complete(third.challenge,2);
    await x.f.reopen();assert.equal(x.page().keys.length,3);assert.equal(x.page().keys[0].fingerprint,one.fingerprint);
    const projection=JSON.stringify(x.page());assert.doesNotMatch(projection,/publicKey|proofHash|ciphertext|secret|privateKey/);
    const audit=JSON.stringify(x.f.registry.auditEvents());assert.doesNotMatch(audit,/BEGIN PUBLIC KEY|ciphertext|proofHash|modeldb.recipient-proof.v1/);
  }finally{await x.f.stop();}
});
test('wrong proof is consumed atomically; replay and unknown holder cannot take over',async()=>{
  const x=await fixture();try{
    const first=x.begin(),proof=answerRecipientChallenge(first.challenge,pairs[0].privateKey,x.f.now);
    assert.throws(()=>answerRecipientChallenge(first.challenge,pairs[1].privateKey,x.f.now),{code:'SECURITY_INVALID_REQUEST'});
    assert.throws(()=>x.call('complete',{response:{...proof,proof:'0'.repeat(64)}}),{code:'SECURITY_FORBIDDEN'});
    assert.throws(()=>x.call('complete',{response:proof}),{code:'SECURITY_POLICY_CONFLICT'});assert.equal(x.page().total,0);
    const current=x.begin();x.complete(current.challenge);
    assert.throws(()=>x.call('complete',{response:answerRecipientChallenge(current.challenge,pairs[0].privateKey,x.f.now)}),{code:'SECURITY_POLICY_CONFLICT'});
    assert.throws(()=>x.call('begin',{userId:randomUUID(),publicKey:pem(1)}),{code:'SECURITY_FORBIDDEN'});
    assert.throws(()=>x.begin(),{code:'SECURITY_INVALID_REQUEST'});
    const complete=x.f.registry.auditEvents().filter(e=>e.action==='registration.recipient.complete');assert.ok(complete.some(e=>e.result==='denied'));
  }finally{await x.f.stop();}
});
test('challenge labels bind every field and TTL; tampering and stale versions are rejected',async()=>{
  const x=await fixture();try{
    const a=x.begin(),b=x.begin(1);
    for(const extra of [{instanceId:randomUUID()},{userId:randomUUID()},{keyVersion:2},{previousKeyId:randomUUID()},{challengeId:randomUUID()},{fingerprint:'a'.repeat(64)},{expiresAtUtc:new Date(x.f.now+600000).toISOString()},{ciphertext:a.challenge.ciphertext.slice(1)}])assert.throws(()=>answerRecipientChallenge({...a.challenge,...extra},pairs[0].privateKey,x.f.now));
    x.complete(a.challenge);assert.throws(()=>x.complete(b.challenge,1),{code:'SECURITY_FORBIDDEN'});
    const c=x.begin(2),proof=answerRecipientChallenge(c.challenge,pairs[2].privateKey,x.f.now);x.f.advance(300000);
    assert.throws(()=>x.call('complete',{response:proof}),{code:'SECURITY_FORBIDDEN'});assert.throws(()=>answerRecipientChallenge(c.challenge,pairs[2].privateKey,x.f.now));
    assert.equal(x.page().keys[0].state,'active');
  }finally{await x.f.stop();}
});
test('login disable, revoke and user enable do not delete history or revive an in-flight challenge',async()=>{
  const x=await fixture();try{
    const a=x.begin();x.complete(a.challenge);const next=x.begin(1),proof=answerRecipientChallenge(next.challenge,pairs[1].privateKey,x.f.now);
    const local=(action:string,id:string)=>x.f.local({action,instanceId:x.f.instanceId,id,revision:x.f.registry.status().revision,confirm:true});
    local('registration.user.disable',x.userId);assert.equal(x.page().total,1);
    local('registration.user.enable',x.userId);assert.throws(()=>x.call('complete',{response:proof}),{code:'SECURITY_POLICY_CONFLICT'});
    local('registration.credential.revoke',x.credentialId);assert.equal(x.page().keys[0].state,'active');assert.throws(()=>x.begin(1),{code:'SECURITY_FORBIDDEN'});
    x.f.registry.resetAccess();assert.equal(x.page().keys[0].state,'retired');await x.f.reopen();assert.equal(x.page().total,1);
  }finally{await x.f.stop();}
});
test('reboot keeps TTL and proof state without extending or replaying an association',async()=>{
  const x=await fixture();try{
    const a=x.begin(),proof=answerRecipientChallenge(a.challenge,pairs[0].privateKey,x.f.now);await x.f.reopen();x.call('complete',{response:proof});
    await x.f.reopen();assert.throws(()=>x.call('complete',{response:proof}),{code:'SECURITY_POLICY_CONFLICT'});assert.equal(x.page().total,1);
  }finally{await x.f.stop();}
});
test('strict parser, key strength, pagination, namespaces and CAS reject malformed input',async()=>{
  const x=await fixture();try{
    for(const extra of [{confirm:false},{revision:-1},{sid:SID},{userId:x.userId+'\n'},{publicKey:pairs[0].privateKey.export({type:'pkcs8',format:'pem'}).toString()}])assert.throws(()=>x.call('begin',{userId:x.userId,publicKey:pem(),...extra}));
    const weak=generateKeyPairSync('rsa',{modulusLength:2048});assert.throws(()=>recipientPublicKey(weak.publicKey.export({type:'spki',format:'pem'}).toString()));
    for(const extra of [{limit:101},{limit:0},{offset:-1},{offset:0.5},{offset:10001},{confirm:true},{instanceId:randomUUID()}])assert.throws(()=>x.call('list',extra));
    const stale=x.command('begin',{userId:x.userId,publicKey:pem()});x.page();assert.throws(()=>x.f.local(stale),{code:'SECURITY_POLICY_CONFLICT'});
    assert.throws(()=>x.f.registry.manageRegistration(x.command('list')),{code:'SECURITY_LOCAL_IDENTITY_DENIED'});
    const a=x.begin();x.complete(a.challenge);const id=x.page().keys[0].id;x.call('retire',{id});assert.throws(()=>x.call('retire',{id}),{code:'SECURITY_POLICY_CONFLICT'});assert.throws(()=>x.call('enable',{id}));
  }finally{await x.f.stop();}
});
test('audit and protected-write failures never report success or replace historical keys',async()=>{
  const x=await fixture();try{
    const a=x.begin();x.complete(a.challenge);const b=x.begin(1),response=answerRecipientChallenge(b.challenge,pairs[1].privateKey,x.f.now),request=x.command('complete',{response});
    const auditLimit=(x.f.registry as unknown as {auditLimit:number});const original=auditLimit.auditLimit;auditLimit.auditLimit=x.f.registry.auditEvents().length;
    assert.throws(()=>x.f.local(request),{code:'SECURITY_AUDIT_CAPACITY'});auditLimit.auditLimit=original;assert.equal(x.page().total,1);
    x.f.fail(true);assert.throws(()=>x.call('complete',{response}),{code:'SECURITY_STORE_WRITE_FAILED'});await x.f.reopen();assert.equal(x.page().total,1);x.call('complete',{response});assert.equal(x.page().total,2);
  }finally{await x.f.stop();}
});
for(const point of ['staged','journaled','replaced'] as const)test('atomic association failure at '+point+' recovers with matching audit and history',async()=>{
  let fail=false;const x=await fixture(true,at=>{if(fail&&at===point)throw Error('synthetic fault');});try{
    const a=x.begin(),response=answerRecipientChallenge(a.challenge,pairs[0].privateKey,x.f.now);fail=true;
    assert.throws(()=>x.call('complete',{response}),{code:'SECURITY_STORE_WRITE_FAILED'});await x.f.reopen();
    const committed=point!=='staged';assert.equal(x.page().total,committed?1:0);
    assert.equal(x.f.registry.auditEvents().some(e=>e.action==='registration.recipient.complete'&&e.result==='succeeded'),committed);
    if(committed)assert.throws(()=>x.call('complete',{response}),{code:'SECURITY_POLICY_CONFLICT'});else x.call('complete',{response});
  }finally{await x.f.stop();}
});
test('corrupt/unknown recipient storage fails closed and preserves original bytes',async()=>{
  const x=await fixture();try{
    const a=x.begin();x.complete(a.challenge);await x.f.stop();
    const protector=syntheticProtector(x.f.key),path=join(x.f.dir,'registry.mds'),original=readFileSync(path),purpose='modeldb-registry-v1:'+x.f.instanceId;
    const state=JSON.parse(protector.unprotect(original.toString('utf8'),purpose).toString('utf8'));
    for(const change of [(s:any)=>{s.version=6;},(s:any)=>{s.recipients.keys[0].fingerprint='a'.repeat(64);},(s:any)=>{s.recipients.keys.push({...s.recipients.keys[0],id:randomUUID()});},(s:any)=>{s.version=4;}]){
      const next=structuredClone(state);change(next);const bytes=Buffer.from(protector.protect(Buffer.from(JSON.stringify(next)),purpose));writeFileSync(path,bytes);
      assert.throws(()=>SecurityRegistry.open(x.f.dir,{protector,now:()=>x.f.now}),{code:'SECURITY_STORE_INVALID'});assert.deepEqual(readFileSync(path),bytes);
    }
    writeFileSync(path,original);await x.f.resume();assert.equal(x.page().total,1);
  }finally{await x.f.stop();}
});
test('dedicated HTTP management validates Cookie, CSRF, Origin and data listener denial',async()=>{
  const x=await hostingFixture();try{
    x.f.registry.migrateAuthenticationStorage(x.f.registry.status().revision);
    const launch=x.launch(),paired=await fetch(x.managementOrigin+'/api/v1/security/pair',{method:'POST',headers:{origin:x.managementOrigin,'content-type':'application/json'},body:JSON.stringify({code:launch.code})});assert.equal(paired.status,200);
    const info=await paired.json() as {csrf:string},headers={origin:x.managementOrigin,cookie:paired.headers.getSetCookie()[0].split(';')[0],'x-modeldb-csrf':info.csrf,'content-type':'application/json'};
    const body={action:'registration.recipient.list',instanceId:x.f.instanceId};
    const call=(extra:Record<string,string>={},origin=x.managementOrigin)=>fetch(origin+'/api/v1/security/admin/control',{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
    assert.equal((await call()).status,200);
    for(const extra of [{cookie:''},{origin:'https://evil.invalid'},{'x-modeldb-csrf':''},{'x-forwarded-for':'127.0.0.1'}] as Record<string,string>[])assert.notEqual((await call(extra)).status,200);
    assert.equal((await call({origin:x.origin},x.origin)).status,404);
  }finally{await x.close();}
});
test('authentication RSA public keys cannot also be registered as encryption recipients',async()=>{
  const x=await fixture();try{
    const b=await x.f.begin(),r=syntheticProof(x.f.instanceId,b),att=isoCBOR.decodeFirst(Buffer.from(r.credential.response.attestationObject,'base64url')) as Map<string,Uint8Array>;
    const jwk=pairs[0].publicKey.export({format:'jwk'}),cose=isoCBOR.encode(new Map<number,unknown>([[1,3],[3,-257],[-1,Buffer.from(jwk.n!,'base64url')],[-2,Buffer.from(jwk.e!,'base64url')]]) as never);
    att.set('authData',Buffer.concat([Buffer.from(att.get('authData')!).subarray(0,87),Buffer.from(cose)]));r.credential.response.attestationObject=Buffer.from(isoCBOR.encode(att as never)).toString('base64url');
    assert.equal((await x.f.post(API.complete,r)).statusCode,202);x.f.local(x.f.decision(b.registrationId));assert.throws(()=>x.begin(),{code:'SECURITY_INVALID_REQUEST'});
  }finally{await x.f.stop();}
});
test('challenge capacity is bounded and elapsed challenges are collected without deleting versions',async()=>{
  const x=await fixture();try{
    const store=emptyRecipientLedger(),registration=x.f.registry.readRegistrationStorage();
    for(let i=0;i<128;i++)beginRecipientChallenge(store,x.f.instanceId,x.userId,pem(),x.f.now,registration);
    assert.throws(()=>beginRecipientChallenge(store,x.f.instanceId,x.userId,pem(),x.f.now,registration),{code:'SECURITY_RESPONSE_LIMIT'});
    beginRecipientChallenge(store,x.f.instanceId,x.userId,pem(),x.f.now+300000,registration);assert.equal(store.challenges.length,1);
    const first=x.begin();x.complete(first.challenge);const retained=x.page().keys[0];
    store.keys=Array.from({length:20},(_,i)=>({...retained,publicKey:pem(),id:randomUUID(),keyVersion:i+1,state:'retired' as const}));
    assert.throws(()=>beginRecipientChallenge(store,x.f.instanceId,x.userId,pem(1),x.f.now,registration),{code:'SECURITY_RESPONSE_LIMIT'});
  }finally{await x.f.stop();}
});
test('wrong instance, unknown proof and malformed proof cannot silently approve or consume a valid challenge',async()=>{
  const x=await fixture();try{
    const a=x.begin(),proof=answerRecipientChallenge(a.challenge,pairs[0].privateKey,x.f.now);
    for(const response of [{...proof,instanceId:randomUUID()},{...proof,proof:proof.proof+'\n'},{...proof,privateKey:'forged'},{...proof,challengeId:randomUUID()}])assert.throws(()=>x.call('complete',{response}));
    assert.equal(x.page().total,0);x.call('complete',{response:proof});assert.equal(x.page().total,1);
  }finally{await x.f.stop();}
});
test('pending and historical encryption keys cannot later become login keys or replacement credentials',async()=>{
  const x=await fixture();try{
    const challenge=x.begin();
    const pending=async()=>{
      const b=await x.f.begin(),r=syntheticProof(x.f.instanceId,b),att=isoCBOR.decodeFirst(Buffer.from(r.credential.response.attestationObject,'base64url')) as Map<string,Uint8Array>,jwk=pairs[0].publicKey.export({format:'jwk'});
      const cose=isoCBOR.encode(new Map<number,unknown>([[1,3],[3,-257],[-1,Buffer.from(jwk.n!,'base64url')],[-2,Buffer.from(jwk.e!,'base64url')]]) as never);
      att.set('authData',Buffer.concat([Buffer.from(att.get('authData')!).subarray(0,87),Buffer.from(cose)]));r.credential.response.attestationObject=Buffer.from(isoCBOR.encode(att as never)).toString('base64url');assert.equal((await x.f.post(API.complete,r)).statusCode,202);return b.registrationId;
    };
    const id=await pending();assert.throws(()=>x.f.local(x.f.decision(id)),{code:'SECURITY_FORBIDDEN'});
    x.complete(challenge.challenge);const key=x.page().keys[0];x.call('retire',{id:key.id});
    assert.throws(()=>x.f.local(x.f.decision(id)),{code:'SECURITY_FORBIDDEN'});
    assert.throws(()=>x.f.local({action:'registration.credential.replace',instanceId:x.f.instanceId,id:x.credentialId,applicationId:id,grants:[],revision:x.f.registry.status().revision,confirm:true}),{code:'SECURITY_FORBIDDEN'});
    assert.equal(x.page().keys[0].state,'retired');
  }finally{await x.f.stop();}
});
