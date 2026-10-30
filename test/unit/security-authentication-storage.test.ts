import { verifyAuthenticationResponse } from '../../packages/server/node_modules/@simplewebauthn/server/esm/index.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';
import { AuthenticationService } from '../../packages/server/src/security/authentication-service.js';
import { syntheticProtector, origin, utc } from '../fixtures/security-registration-integration.js';
import { authenticationFixture } from '../fixtures/security-authentication.js';

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'ModeDB-Authentication-Storage-')),dir=join(root,'security'),protector=syntheticProtector(randomBytes(32));
  let registry=SecurityRegistry.open(dir,{protector});const instance=registry.status().instanceId;
  return {dir,protector,instance,get registry(){return registry;},
    reopen(point?:string){registry.close();registry=SecurityRegistry.open(dir,{protector,onCommitPoint:p=>{if(p===point)throw Error('synthetic interruption');}});},
    read(){return JSON.parse(protector.unprotect(readFileSync(join(dir,'registry.mds'),'utf8'),'modeldb-registry-v1:'+instance).toString());},
    close(){registry.close();}};
}
for(const version of [1,2,3]){
  test(`V${version} migration to V4 is explicit, CAS, atomic, preserves old credentials and is idempotent`,()=>{
    const f=fixture();try{
      if(version===2)f.registry.migrateRegistrationStorage(f.registry.status().revision);if(version===3)f.registry.migrateSessionStorage(f.registry.status().revision);
      const p=f.registry.createPrincipal('Synthetic'),token=f.registry.createCredential(p.id,'Synthetic API',[]),session=f.registry.createSession(token.token);
      const before=f.read(),bytes=readFileSync(join(f.dir,'registry.mds')),key=readFileSync(join(f.dir,'instance.key'));
      f.reopen();assert.deepEqual(readFileSync(join(f.dir,'registry.mds')),bytes);
      new AuthenticationService(f.registry,{enabled:false}).close();assert.equal(f.registry.registrationStorageStatus().ledgerVersion,version);
      const d={format:'modeldb.device-registration-connection.v1' as const,version:1 as const,instanceId:f.instance,serverOrigin:origin,rpId:'modeldb-a.example.test',registrationMode:'disabled' as const,issuedAtUtc:utc(Date.now()-1000),expiresAtUtc:utc(Date.now()+3600000),deploymentDescriptorSha256:'a'.repeat(64),tls:{mode:'public-ca' as const,minVersion:'TLS1.2' as const}};
      assert.throws(()=>new AuthenticationService(f.registry,{enabled:true},d),{code:'SECURITY_INVALID_CONFIG'});assert.deepEqual(readFileSync(join(f.dir,'registry.mds')),bytes);
      assert.throws(()=>f.registry.migrateAuthenticationStorage(before.revision-1),{code:'SECURITY_POLICY_CONFLICT'});
      f.registry.migrateAuthenticationStorage(before.revision);const after=f.read();assert.equal(after.version,4);assert.equal(after.revision,before.revision+1);assert.deepEqual(after.authentication,{version:1,challenges:[]});
      for(const field of ['instanceId','policyVersion','accessEpoch','principals','keyReferences'])assert.deepEqual(after[field],before[field]);
      assert.deepEqual(after.events.slice(0,before.events.length),before.events);assert.deepEqual(readFileSync(join(f.dir,'instance.key')),key);
      f.reopen();f.registry.authenticate(token.token);f.registry.verifySession(session.session);const migrated=readFileSync(join(f.dir,'registry.mds'));
      f.registry.migrateAuthenticationStorage(f.registry.status().revision);f.registry.migrateSessionStorage(f.registry.status().revision);assert.deepEqual(readFileSync(join(f.dir,'registry.mds')),migrated);
    }finally{f.close();}
  });
}
for(const point of ['staged','journaled','replaced']){
  test('V4 migration recovery at '+point,()=>{
    const f=fixture();try{f.reopen(point);assert.throws(()=>f.registry.migrateAuthenticationStorage(f.registry.status().revision),{code:'SECURITY_STORE_WRITE_FAILED'});f.reopen();assert.equal(f.registry.registrationStorageStatus().ledgerVersion,point==='staged'?1:4);assert.equal(f.registry.auditEvents().filter(e=>e.action==='authentication.storage.migrate').length,point==='staged'?0:1);}finally{f.close();}
  });
}
for(const kind of ['missing-store','unknown-field','future-version','downgrade-with-store']){
  test('reject malformed authentication persistence: '+kind,()=>{
    const f=fixture();try{f.registry.migrateAuthenticationStorage(f.registry.status().revision);const raw=f.read();f.close();if(kind==='missing-store')delete raw.authentication;if(kind==='unknown-field')raw.authentication.privateKey='synthetic';if(kind==='future-version')raw.version=5;if(kind==='downgrade-with-store')raw.version=3;
      writeFileSync(join(f.dir,'registry.mds'),f.protector.protect(Buffer.from(JSON.stringify(raw)),'modeldb-registry-v1:'+f.instance));const bytes=readFileSync(join(f.dir,'registry.mds'));assert.throws(()=>f.reopen(),{code:'SECURITY_STORE_INVALID'});assert.deepEqual(readFileSync(join(f.dir,'registry.mds')),bytes);
    }finally{f.close();}
  });
}
test('login commit failure never exposes a session; restart does not retry the claimed proof',async()=>{
  const a=await authenticationFixture();try{const b=await a.begin();a.f.fail(true);await assert.rejects(()=>a.service.complete(a.assertion(b.response),b.ceremonySecret,a.context));a.f.fail(false);await a.reopen();assert.equal(a.f.registry.status().sessions,0);await assert.rejects(()=>a.service.complete(a.assertion(b.response),b.ceremonySecret,a.context));}finally{await a.close();}
});
test('absolute eight-hour expiry survives repeated sliding refreshes',async()=>{
  const a=await authenticationFixture();try{const b=await a.begin();let session=(await a.service.complete(a.assertion(b.response),b.ceremonySecret,a.context)).session;const end=Date.parse(a.f.registry.verifyBrowserSession(session,origin).absoluteExpiresAt);for(let i=0;i<16;i++){a.f.advance(29*60000);session=a.f.registry.rotateSession(session).session;assert.equal(Date.parse(a.f.registry.verifyBrowserSession(session,origin).absoluteExpiresAt),end);}a.f.advance(end-a.f.now);assert.throws(()=>a.f.registry.verifySession(session),{code:'SECURITY_CREDENTIAL_EXPIRED'});}finally{await a.close();}
});

for(const point of ['staged','journaled','replaced'] as const){
  test('verified login, counter and audit recover atomically after '+point,async()=>{
    let interrupted=false;const a=await authenticationFixture(-7,false,p=>{if(interrupted&&p===point)throw Error('synthetic login commit interruption');});a.service.close();
    const service=new AuthenticationService(a.f.registry,{enabled:true},a.f.descriptor,()=>a.f.now,async options=>{const result=await verifyAuthenticationResponse(options);interrupted=true;return result;});
    try{const b=await service.begin(a.binding,a.context);await assert.rejects(()=>service.complete(a.assertion(b.response),b.ceremonySecret,a.context),{code:'SECURITY_STORE_WRITE_FAILED'});interrupted=false;await a.reopen();const committed=point!=='staged';assert.equal(a.f.registry.status().sessions,committed?1:0);assert.equal(a.f.registry.readRegistrationStorage().credentials[0]!.counter,committed?1:0);assert.equal(a.f.registry.auditEvents().filter(e=>e.action==='authentication.login').length,committed?1:0);assert.equal(a.f.registry.readAuthenticationChallenge(b.response.challengeId)!.state,committed?'succeeded':'rejected');await assert.rejects(()=>a.service.complete(a.assertion(b.response),b.ceremonySecret,a.context));
    }finally{interrupted=false;service.close();await a.close();}
  });
}

test('1000 retained login challenges fail closed; expired records reclaim capacity and local list still works',async()=>{
  const a=await authenticationFixture();try{
    const b=await a.begin(),protector=syntheticProtector(a.f.key),purpose='modeldb-registry-v1:'+a.f.instanceId,path=join(a.f.dir,'registry.mds');
    const raw=JSON.parse(protector.unprotect(readFileSync(path,'utf8'),purpose).toString());
    const challenge=raw.authentication.challenges.find((c:{id:string})=>c.id===b.response.challengeId);
    raw.authentication.challenges=Array.from({length:1000},()=>({...challenge,id:randomUUID()}));
    a.f.registry.close();writeFileSync(path,protector.protect(Buffer.from(JSON.stringify(raw)),purpose));await a.reopen();
    await assert.rejects(()=>a.begin(),{code:'SECURITY_AUTHENTICATION_CAPACITY'});
    a.f.local({action:'registration.list',instanceId:a.f.instanceId});
    a.f.advance(60000);const next=await a.begin();assert.ok(next.response.challengeId);
  }finally{await a.close();}
});
