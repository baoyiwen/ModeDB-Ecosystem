import { verifyAuthenticationResponse } from '../../packages/server/node_modules/@simplewebauthn/server/esm/index.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { authenticationFixture } from '../fixtures/security-authentication.js';
import { DEVICE_AUTHENTICATION_API_V1 as API, assertDeviceAuthenticationBeginRequest, assertDeviceAuthenticationCompleteRequest } from '../../packages/shared/src/device-authentication-contracts.js';
import { AuthenticationService } from '../../packages/server/src/security/authentication-service.js';
import { origin } from '../fixtures/security-registration-integration.js';

for (const algorithm of [-7,-257] as const) {
  test(`real ${algorithm} signature issues only a public-key child, with recovery, rotation, CSRF and logout`, async()=>{
    const a=await authenticationFixture(algorithm);
    try {
      const b=await a.begin(), before=a.f.registry.listCredentials();
      const result=await a.service.complete(a.assertion(b.response),b.ceremonySecret,a.context);
      const v=a.f.registry.verifyBrowserSession(result.session,origin);
      assert.equal(v.sessionParent?.kind,'registered-public-key');assert.notEqual(v.securityAdmin,true);
      assert.deepEqual(v.credential.grants.map(g=>g.database),['synthetic_business']);assert.deepEqual(a.f.registry.listCredentials(),before);
      assert.equal(a.f.registry.readAuthenticationChallenge(b.response.challengeId)!.state,'succeeded');
      assert.equal(a.f.registry.readRegistrationStorage().credentials[0]!.counter,1);
      assert.equal(a.f.registry.auditEvents().filter(e=>e.action==='authentication.login').length,1);
      await a.reopen();a.f.registry.verifyBrowserSession(result.session,origin,v.csrf);
      assert.throws(()=>a.f.registry.verifyBrowserSession(result.session,origin,'a'.repeat(64)),{code:'SECURITY_CSRF_REQUIRED'});
      a.f.advance(29*60000);const rotated=a.f.registry.rotateSession(result.session);
      assert.throws(()=>a.f.registry.verifySession(result.session),{code:'SECURITY_CREDENTIAL_REVOKED'});
      const fresh=a.f.registry.verifyBrowserSession(rotated.session,origin);assert.equal(fresh.absoluteExpiresAt,v.absoluteExpiresAt);assert.notEqual(fresh.csrf,v.csrf);
      a.f.registry.revokeSession(rotated.session);assert.equal(a.f.registry.readRegistrationStorage().credentials[0]!.state,'active');
      assert.throws(()=>a.f.registry.verifySession(rotated.session),{code:'SECURITY_CREDENTIAL_REVOKED'});
    } finally {await a.close();}
  });
}
const badClients: Array<[string,(c:Record<string,unknown>)=>void]> = [
  ['wrong challenge',c=>{c.challenge=randomBytes(32).toString('base64url');}],['wrong origin',c=>{c.origin='https://other.example.test';}],['wrong type',c=>{c.type='webauthn.create';}],['iframe',c=>{c.crossOrigin=true;}],['topOrigin',c=>{c.topOrigin=origin;}],
];
for (const [name,edit] of badClients) {
  test('reject '+name+' even with a valid signature',async()=>{
    const a=await authenticationFixture();try {const b=await a.begin();await assert.rejects(()=>a.service.complete(a.assertion(b.response,1,edit),b.ceremonySecret,a.context),{code:'SECURITY_AUTHENTICATION_PROOF_INVALID'});assert.equal(a.f.registry.status().sessions,0);assert.equal(a.f.registry.readAuthenticationChallenge(b.response.challengeId)!.state,'rejected');}finally{await a.close();}
  });
}
for (const flags of [0,1,4,0x0d]) {
  test('reject missing presence/UV or changed device type: '+flags,async()=>{
    const a=await authenticationFixture();try{const b=await a.begin();await assert.rejects(()=>a.service.complete(a.assertion(b.response,1,()=>{},flags),b.ceremonySecret,a.context),{code:'SECURITY_AUTHENTICATION_PROOF_INVALID'});}finally{await a.close();}
  });
}
for (const mode of ['missing-cookie','wrong-cookie','wrong-handle','missing-handle','wrong-hint','unknown-key','bad-signature','wrong-rp'] as const) {
  test('reject '+mode,async()=>{
    const a=await authenticationFixture();try{
      const b=await a.service.begin({...a.binding,...(mode==='wrong-hint'?{rawId:randomBytes(32).toString('base64url')}:{})},a.context),p=a.assertion(b.response);
      let cookie:string|undefined=b.ceremonySecret;
      if(mode==='missing-cookie')cookie=undefined;if(mode==='wrong-cookie')cookie=randomBytes(32).toString('base64url');
      if(mode==='wrong-handle')p.credential.response.userHandle=randomBytes(32).toString('base64url');if(mode==='missing-handle')p.credential.response.userHandle=null;
      if(mode==='unknown-key')p.credential.rawId=p.credential.id=randomBytes(32).toString('base64url');
      if(mode==='bad-signature')p.credential.response.signature=randomBytes(64).toString('base64url');
      if(mode==='wrong-rp'){const raw=Buffer.from(p.credential.response.authenticatorData,'base64url');raw[0]^=1;p.credential.response.authenticatorData=raw.toString('base64url');}
      await assert.rejects(()=>a.service.complete(p,cookie,a.context),{code:'SECURITY_AUTHENTICATION_PROOF_INVALID'});assert.equal(a.f.registry.status().sessions,0);
    }finally{await a.close();}
  });
}
test('non-discoverable hint permits absent userHandle but still requires the exact signature',async()=>{
  const a=await authenticationFixture();try{const b=await a.begin(true),p=a.assertion(b.response);p.credential.response.userHandle=null;await a.service.complete(p,b.ceremonySecret,a.context);}finally{await a.close();}
});
test('single-use claim rejects competing/replayed proofs and duplicate single-device counters',async()=>{
  const a=await authenticationFixture();try{
    const b=await a.begin(),p=a.assertion(b.response);
    const results=await Promise.allSettled([a.service.complete(p,b.ceremonySecret,a.context),a.service.complete(p,b.ceremonySecret,a.context)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    await assert.rejects(()=>a.service.complete(p,b.ceremonySecret,a.context),{code:'SECURITY_AUTHENTICATION_CHALLENGE_REPLAYED'});
    const c=await a.begin();await assert.rejects(()=>a.service.complete(a.assertion(c.response),c.ceremonySecret,a.context),{code:'SECURITY_AUTHENTICATION_PROOF_INVALID'});
    const x=await a.begin(),y=await a.begin();const races=await Promise.allSettled([a.service.complete(a.assertion(x.response,2),x.ceremonySecret,a.context),a.service.complete(a.assertion(y.response,2),y.ceremonySecret,a.context)]);assert.equal(races.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(a.f.registry.readRegistrationStorage().credentials[0]!.counter,2);
  }finally{await a.close();}
});
test('multi-device counter rollback alone does not reject a valid synchronized passkey',async()=>{
  const a=await authenticationFixture(-7,true);try{for(const count of [5,1,0]){const b=await a.begin();await a.service.complete(a.assertion(b.response,count),b.ceremonySecret,a.context);}assert.equal(a.f.registry.readRegistrationStorage().credentials[0]!.counter,5);}finally{await a.close();}
});
for(const reason of ['expiry','restart','reset','disabled-key','disabled-user','registration-closed','descriptor-expired'] as const){
  test('lifecycle '+reason,async()=>{
    const a=await authenticationFixture();try{
      const b=await a.begin();
      if(reason==='expiry')a.f.advance(60000);if(reason==='restart')await a.reopen();if(reason==='reset')a.f.registry.resetAccess();
      if(reason==='disabled-key'||reason==='disabled-user'){const s=a.f.registry.readRegistrationStorage();if(reason==='disabled-key'){s.credentials[0]!.state='disabled';s.credentials[0]!.disabledAtUtc=new Date(a.f.now).toISOString();}else{s.users[0]!.enabled=false;}a.f.registry.commitRegistrationStorage(a.f.registry.status().revision,s);}
      if(reason==='registration-closed'||reason==='descriptor-expired'){
        a.service.close();const service=new AuthenticationService(a.f.registry,{enabled:true},{...a.f.descriptor,registrationMode:'disabled',expiresAtUtc:new Date(a.f.now-1).toISOString()},()=>a.f.now);const next=await service.begin(a.binding,a.context);await service.complete(a.assertion(next.response),next.ceremonySecret,a.context);service.close();
      }else{await assert.rejects(()=>a.service.complete(a.assertion(b.response),b.ceremonySecret,a.context));assert.equal(a.f.registry.status().sessions,0);}
    }finally{await a.close();}
  });
}
test('authentication config is explicit; disabled service does not authorize or migrate legacy storage',async()=>{
  const a=await authenticationFixture();try{
    const before=a.f.registry.status().revision;
    const disabled=new AuthenticationService(a.f.registry,{enabled:false},a.f.descriptor,()=>a.f.now);assert.equal(disabled.capabilities().mode,'disabled');assert.equal(a.f.registry.status().revision,before);await assert.rejects(()=>disabled.begin(a.binding,a.context),{code:'SECURITY_AUTHENTICATION_DISABLED'});disabled.close();
    assert.throws(()=>new AuthenticationService(a.f.registry,{enabled:true}),{code:'SECURITY_INVALID_CONFIG'});
  }finally{await a.close();}
});
test('HTTP cookie lifecycle, precise admission and CSRF use the existing session routes',async()=>{
  const a=await authenticationFixture();try{
    const headers={host:'modeldb-a.example.test',origin,'sec-fetch-site':'same-origin','content-type':'application/json','x-forwarded-proto':'https','x-forwarded-for':'192.0.2.10'};
    const begin=await a.app.inject({url:API.begin,method:'POST',headers,payload:a.binding});assert.equal(begin.statusCode,201);
    const nonce=String(begin.headers['set-cookie']);assert.match(nonce,/HttpOnly; SameSite=Strict; Secure/);assert.equal(JSON.stringify(begin.json()).includes('ceremonySecret'),false);
    const complete=await a.app.inject({url:API.complete,method:'POST',headers:{...headers,cookie:nonce.split(';')[0]},payload:a.assertion(begin.json())});assert.equal(complete.statusCode,200,complete.body);
    const set=complete.headers['set-cookie'] as string[],session=set.find(c=>c.startsWith('mdbs_session_'))!,cookie=session.split(';')[0],info=complete.json();assert.match(session,/HttpOnly; SameSite=Strict; Secure/);assert.equal(info.session,undefined);assert.equal(info.securityAdmin,false);
    assert.equal((await a.app.inject({url:'/api/v1/security/session',headers:{...headers,cookie}})).json().csrf,info.csrf);
    assert.equal((await a.app.inject({url:'/api/v1/security/session/refresh',method:'POST',headers:{...headers,cookie},payload:{}})).statusCode,403);
    const refreshed=await a.app.inject({url:'/api/v1/security/session/refresh',method:'POST',headers:{...headers,cookie,'x-modeldb-csrf':info.csrf},payload:{}});assert.equal(refreshed.statusCode,200,refreshed.body);
    assert.notEqual(refreshed.json().csrf,info.csrf);assert.equal(refreshed.json().absoluteExpiresAt,info.absoluteExpiresAt);
    assert.equal((await a.app.inject({url:'/api/v1/security/session',headers:{...headers,cookie}})).statusCode,401);
    const next=(refreshed.headers['set-cookie'] as string[])[0].split(';')[0];
    const logout=await a.app.inject({url:'/api/v1/security/session/logout',method:'POST',headers:{...headers,cookie:next,'x-modeldb-csrf':refreshed.json().csrf},payload:{}});assert.equal(logout.statusCode,200);assert.match(String(logout.headers['set-cookie']),/Max-Age=0/);
    assert.equal((await a.app.inject({url:'/api/v1/security/session',headers:{...headers,cookie:next}})).statusCode,401);
    for(const bad of [{host:'other.example.test'},{origin:'https://other.example.test'},{'sec-fetch-site':'cross-site'},{'x-forwarded-proto':'http'}]){const r=await a.app.inject({url:API.begin,method:'POST',headers:{...headers,...bad},payload:a.binding});assert.equal(r.statusCode,403);assert.equal(r.headers['set-cookie'],undefined);assert.equal(r.headers['access-control-allow-origin'],undefined);}
    const query=await a.app.inject({url:API.begin+'?x=1',method:'POST',headers,payload:a.binding});assert.equal(query.statusCode,400);
    assert.equal((await a.app.inject({url:API.begin,method:'OPTIONS',headers})).statusCode,501);
    assert.equal(a.f.registry.readRegistrationStorage().credentials[0]!.state,'active');
  }finally{await a.close();}
});
test('strict public contracts reject secrets, noncanonical binary, unknown fields and excessive bodies',async()=>{
  const a=await authenticationFixture();try{
    assert.throws(()=>assertDeviceAuthenticationBeginRequest({...a.binding,token:'synthetic'}));
    assert.throws(()=>assertDeviceAuthenticationBeginRequest({...a.binding,rawId:'AA='}));
    const b=await a.begin(),p=a.assertion(b.response);
    assert.throws(()=>assertDeviceAuthenticationCompleteRequest({...p,credential:{...p.credential,privateKey:'synthetic'}}));
    p.credential.response.signature='A'.repeat(2000);assert.throws(()=>assertDeviceAuthenticationCompleteRequest(p));
  }finally{await a.close();}
});

for (const change of ['expiry','reset','disable-key','close','source'] as const) {
  test('rechecks authority after asynchronous verification: '+change, async()=>{
    const a=await authenticationFixture();let service:AuthenticationService|undefined;
    try{
      a.service.close();service=new AuthenticationService(a.f.registry,{enabled:true},a.f.descriptor,()=>a.f.now,async options=>{
        const result=await verifyAuthenticationResponse(options);
        if(change==='expiry')a.f.advance(60000);
        if(change==='reset')a.f.registry.resetAccess();
        if(change==='disable-key'){const s=a.f.registry.readRegistrationStorage();s.credentials[0]!.state='disabled';s.credentials[0]!.disabledAtUtc=new Date(a.f.now).toISOString();a.f.registry.commitRegistrationStorage(a.f.registry.status().revision,s);}
        if(change==='close')service!.close();
        if(change==='source')sourceDenied=true;
        return result;
      });
      let sourceDenied=false;const context={...a.context,recheck:()=>{if(sourceDenied)throw Error('synthetic source changed');}};
      const b=await service.begin(a.binding,context);await assert.rejects(()=>service!.complete(a.assertion(b.response),b.ceremonySecret,context));assert.equal(a.f.registry.status().sessions,0);
    }finally{service?.close();await a.close();}
  });
}

test('proof queue is bounded at four active and 32 waiting; local maintenance remains available',async()=>{
  const a=await authenticationFixture(-7,true);a.service.close();let releaseGate!:()=>void;
  const gate=new Promise<void>(done=>{releaseGate=done;});
  const service=new AuthenticationService(a.f.registry,{enabled:true},a.f.descriptor,()=>a.f.now,async options=>{await gate;return verifyAuthenticationResponse(options);});
  try{
    const requests=[];for(let i=0;i<37;i++){requests.push(await service.begin(a.binding,a.context));}
    const work=requests.map(b=>service.complete(a.assertion(b.response,0),b.ceremonySecret,a.context));
    const settled=Promise.allSettled(work);await new Promise<void>(done=>setImmediate(done));
    assert.equal(service.metrics().activeProofs,4);assert.equal(service.metrics().queuedProofs,32);
    const list=a.f.local({action:'registration.list',instanceId:a.f.instanceId}) as {applications:unknown[]};assert.ok(list.applications.length>0);
    releaseGate();const results=await settled;assert.equal(results.filter(r=>r.status==='fulfilled').length,36);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.deepEqual({...service.metrics(),budgetRows:0},{activeProofs:0,queuedProofs:0,budgetRows:0});
  }finally{releaseGate();service.close();await a.close();}
});

test('rate limits use attributed source and instance budgets and reset only in a new window',async()=>{
  const a=await authenticationFixture();try{
    for(let i=0;i<10;i++)a.service.admit('begin',a.context.source);
    assert.throws(()=>a.service.admit('begin',a.context.source),{code:'SECURITY_AUTHENTICATION_RATE_LIMITED'});
    for(let i=0;i<20;i++)a.service.admit('complete',a.context.source);
    assert.throws(()=>a.service.admit('complete',a.context.source),{code:'SECURITY_AUTHENTICATION_RATE_LIMITED'});
    a.f.advance(60000);a.service.admit('begin',a.context.source);
    for(let i=0;i<119;i++)a.service.admit('begin',{...a.context.source,clientIp:'192.0.2.'+(i+20)});
    assert.throws(()=>a.service.admit('begin',{...a.context.source,clientIp:'192.0.2.250'}),{code:'SECURITY_AUTHENTICATION_RATE_LIMITED'});
  }finally{await a.close();}
});
