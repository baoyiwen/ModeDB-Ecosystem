import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {hostingFixture} from '../fixtures/security-hosting.js';
import {syntheticProof,scopes,SID} from '../fixtures/security-registration-integration.js';
import {DEVICE_REGISTRATION_API_V1 as API} from '../../packages/shared/src/device-registration-contracts.js';

async function fixture(){
  const x=await hostingFixture(),launch=x.launch();
  const paired=await fetch(x.managementOrigin+'/api/v1/security/pair',{method:'POST',headers:{origin:x.managementOrigin,'content-type':'application/json'},body:JSON.stringify({code:launch.code})});
  assert.equal(paired.status,200);
  const info=await paired.json() as {csrf:string},cookie=paired.headers.getSetCookie()[0].split(';')[0];
  const headers={origin:x.managementOrigin,cookie,'x-modeldb-csrf':info.csrf,'content-type':'application/json'};
  const call=async(body:unknown,extra:Record<string,string>={},origin=x.managementOrigin)=>{
    const r=await fetch(origin+'/api/v1/security/admin/control',{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
    return {status:r.status,body:await r.json() as Record<string,any>};
  };
  const command=(action:string,id?:string,extra:Record<string,unknown>={})=>({action,instanceId:x.f.instanceId,...(id?{id,revision:x.f.registry.status().revision,confirm:true}:{}),...extra});
  const pending=async()=>{const b=await x.f.begin();const r=await x.f.post(API.complete,syntheticProof(x.f.instanceId,b));assert.equal(r.statusCode,202);return b.registrationId;};
  return {...x,headers,cookie,info,call,command,pending};
}
test('dedicated admin command checks listener, Cookie, Origin, CSRF, proxy headers and extra fields',async()=>{
  const x=await fixture();try{
    const input=x.command('registration.list');
    assert.equal((await x.call(input)).status,200);
    // Host spoofing is covered by native http.request in security-hosting.test.ts;
    // Node fetch owns Host and can ignore a caller override.
    for(const extra of [{cookie:''},{'x-modeldb-csrf':''},{origin:'https://evil.invalid'},{'x-forwarded-for':'127.0.0.1'}] as Record<string,string>[])assert.notEqual((await x.call(input,extra)).status,200,JSON.stringify(extra));
    assert.equal((await x.call(input,{origin:x.origin},x.origin)).status,404);
    assert.equal((await x.call({...input,sid:SID})).status,400);
    assert.equal((await x.call({...input,instanceId:randomUUID()})).status,403);
  }finally{await x.close();}
});
test('ordinary paired data identity and forged actor context cannot acquire registration administration',async()=>{
  const x=await fixture();try{
    const pairing=x.f.registry.createLocalBrowserPairing(x.managementOrigin,['synthetic_business']);
    const data=x.f.registry.consumePairing(pairing.code,x.managementOrigin);
    const v=x.f.registry.verifyBrowserSession(data.session,x.managementOrigin);
    assert.throws(()=>x.f.registry.withManagementActor({actor:v.actor,source:{transport:'http'}},()=>x.f.registry.manageHostedIdentity(data.session,x.managementOrigin,v.csrf,x.command('registration.list'))),{code:'SECURITY_LOCAL_IDENTITY_DENIED'});
    assert.throws(()=>x.f.registry.withManagementActor({actor:v.actor,source:{transport:'http'}},()=>x.f.registry.manageRegistration(x.command('registration.list'))),{code:'SECURITY_LOCAL_IDENTITY_DENIED'});
    assert.throws(()=>x.f.registry.manageRegistration(x.command('registration.list')),{code:'SECURITY_LOCAL_IDENTITY_DENIED'});
  }finally{await x.close();}
});
test('bounded metadata pages, explicit confirmation and CAS approval preserve exact grants and HTTP audit actor',async()=>{
  const x=await fixture();try{
    const id=await x.pending(),another=await x.pending();
    const list=await x.call(x.command('registration.list',undefined,{limit:1}));assert.equal(list.body.total,2);assert.equal(list.body.nextOffset,1);
    assert.doesNotMatch(JSON.stringify(list.body),/rawId|publicKeyCose|continuationSecret|secretHash|userHandle/);
    const stale=x.command('registration.approve',id,{name:'Synthetic admin UI',grants:scopes});
    await x.call(x.command('registration.list'));
    assert.equal((await x.call(stale)).body.error,'SECURITY_POLICY_CONFLICT');
    assert.equal((await x.call(x.command('registration.approve',id,{name:'Synthetic admin UI',grants:scopes,confirm:false}))).body.error,'SECURITY_CONFIRMATION_REQUIRED');
    const approved=await x.call(x.command('registration.approve',id,{name:'Synthetic admin UI',grants:scopes}));assert.equal(approved.status,200);assert.deepEqual(approved.body.grants,scopes);
    assert.equal((await x.call(x.command('registration.reject',another))).status,200);
    const event=x.f.registry.auditEvents().find(e=>e.action==='registration.approve'&&e.result==='succeeded')!;
    assert.equal(event.source.transport,'http');assert.notEqual(event.actor.principalId,SID);assert.ok(event.requestId);assert.equal(event.source.peerIp,'127.0.0.1');
    assert.equal(x.f.registry.securityCenterSnapshot().sessions.length,1,'Approval issues no session');
  }finally{await x.close();}
});
test('HTTP user/key enable-disable, irreversible revoke, reductions and atomic replacement reuse CLI validation',async()=>{
  const x=await fixture();try{
    const id=await x.pending();const approved=await x.call(x.command('registration.approve',id,{name:'Synthetic admin UI',grants:scopes})),key=approved.body.credentialId,user=approved.body.userId;
    for(const [action,target] of [['registration.user.disable',user],['registration.user.enable',user],['registration.credential.disable',key],['registration.credential.enable',key]])assert.equal((await x.call(x.command(action,target))).status,200,action);
    assert.equal((await x.call(x.command('registration.credential.restrict',key,{grants:[]}))).status,200);
    assert.notEqual((await x.call(x.command('registration.credential.restrict',key,{grants:scopes}))).status,200,'No expansion');
    const next=await x.pending();
    const replaced=await x.call(x.command('registration.credential.replace',key,{applicationId:next,grants:scopes}));assert.equal(replaced.status,200);assert.ok(replaced.body.replacementCredentialId);
    assert.equal((await x.call(x.command('registration.credential.enable',key))).body.error,'SECURITY_POLICY_CONFLICT');
    assert.equal((await x.call(x.command('registration.credential.revoke',replaced.body.replacementCredentialId))).status,200);
    const keys=await x.call(x.command('registration.credentials.list')),users=await x.call(x.command('registration.users.list'));
    assert.equal(keys.body.credentials.length,2);assert.ok(keys.body.credentials.every((c:{state:string})=>c.state==='revoked'));assert.equal(users.body.users.length,1);
    assert.doesNotMatch(JSON.stringify(keys.body),/publicKeyCose|rawId|secretHash/);
  }finally{await x.close();}
});
test('session maintenance is paginated, CAS protected, namespace strict and can revoke the current management session',async()=>{
  const x=await fixture();try{
    const page=await x.call(x.command('registration.sessions.list',undefined,{limit:1})),session=page.body.sessions[0];
    assert.equal(page.status,200);assert.equal(session.securityAdmin,true);assert.doesNotMatch(JSON.stringify(page.body),/secretHash|mdbs_v1_/);
    for(const extra of [{id:'api-token'},{id:session.id+'\n'},{instanceId:x.f.instanceId+'\n'},{id:randomUUID(),revision:-1},{id:randomUUID(),confirm:false},{id:randomUUID(),sid:SID}])assert.notEqual((await x.call(x.command('registration.session.revoke',session.id,extra))).status,200);
    assert.equal((await x.call(x.command('registration.session.revoke',randomUUID()))).status,404);
    const stale=x.command('registration.session.revoke',session.id);await x.call(x.command('registration.sessions.list'));
    assert.equal((await x.call(stale)).body.error,'SECURITY_POLICY_CONFLICT');
    assert.equal((await x.call(x.command('registration.session.revoke',session.id))).status,200);
    assert.equal((await x.call(x.command('registration.list'))).status,401);
  }finally{await x.close();}
});
for(const action of ['registration.list','registration.users.list','registration.credentials.list','registration.sessions.list'])test(action+' rejects unbounded or malformed pages',async()=>{
  const x=await fixture();try{for(const extra of [{limit:101},{limit:0},{offset:-1},{offset:0.5},{limit:'10'},{confirm:true},{actor:{principalId:SID}}])assert.equal((await x.call(x.command(action,undefined,extra))).status,400);}finally{await x.close();}
});
test('audit-capacity failure prevents an admin mutation and preserves pending state',async()=>{
  const x=await fixture();try{
    const id=await x.pending();const command=x.command('registration.approve',id,{name:'Synthetic full audit',grants:[]});
    // Use the existing capacity boundary rather than changing any real on-disk materials.
    const current=x.f.registry.auditEvents().length;
    (x.f.registry as unknown as {auditLimit:number}).auditLimit=current;
    const result=await x.call(command);assert.equal(result.status,503);
    assert.equal(x.f.registry.readRegistrationStorage().applications.find(a=>a.id===id)!.state,'pending');
  }finally{await x.close();}
});
