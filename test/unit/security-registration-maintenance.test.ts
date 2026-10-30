/** DR-P2.4 acceptance: isolated real software signatures; native OS pipe/CLI covered explicitly. */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import type { SecurityGrant } from '@mode-db/shared';
import { authenticationFixture } from '../fixtures/security-authentication.js';
import { pendingSoftwareIdentity } from '../fixtures/security-registration-identity.js';
import { SID, origin, syntheticProtector } from '../fixtures/security-registration-integration.js';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';
import { parseRegistrationMaintenance, sameRegistrationPublicKey } from '../../packages/server/src/security/registration-maintenance.js';
import { isoCBOR } from '../../packages/server/node_modules/@simplewebauthn/server/esm/helpers/index.js';
import { dispatchLocalSecurity, callLocalSecurity, startLocalSecurityChannel } from '../../packages/server/src/security/local-management-channel.js';
import { WindowsSecretProtector } from '../../packages/server/src/security/windows-secret-protector.js';
import { runRegistrationApprovalCli } from '../../packages/server/src/cli-security-registration.js';
import { ensureModelDbLayoutAtRoot } from '../../packages/server/src/modeldb-default-home.js';
import type { AtomicCommitPoint } from '../../packages/common/src/atomic-file.js';

const full:SecurityGrant[]=[{database:'synthetic_business',resource:'*',actions:['model.read','model.write']}];
const read:SecurityGrant[]=[{database:'synthetic_business',resource:'*',actions:['model.read']}];
interface Result {revision:number;credentialId:string;userId:string;replacementCredentialId:string;registrationId:string;state:string;enabled:boolean;grants:SecurityGrant[]}
interface CredentialPage {revision:number;credentials:Array<{id:string;userId:string;principalId:string;state:string;publicKeyFingerprint:string;grants:SecurityGrant[]}>;total:number;offset:number;nextOffset:number|null}
interface UserPage {revision:number;users:Array<{id:string;principalId:string;enabled:boolean;credentialCount:number}>;total:number;nextOffset:number|null}
async function fixture(onCommitPoint?: (point:AtomicCommitPoint)=>void) {
  const a=await authenticationFixture(-7,false,onCommitPoint,full),{f}=a;
  const begin=await a.begin(),login=await a.service.complete(a.assertion(begin.response),begin.ceremonySecret,a.context);
  const verified=f.registry.verifySession(login.session),key=f.registry.readRegistrationStorage().credentials[0];
  const request=(action:string,id=key.id,extra:Record<string,unknown>={})=>({action,instanceId:f.instanceId,id,revision:f.registry.status().revision,confirm:true,...extra});
  const local=(action:string,id=key.id,extra:Record<string,unknown>={})=>f.local(request(action,id,extra)) as Result;
  const credentials=(extra:Record<string,unknown>={})=>f.local({action:'registration.credentials.list',instanceId:f.instanceId,...extra}) as CredentialPage;
  const users=()=>f.local({action:'registration.users.list',instanceId:f.instanceId}) as UserPage;
  const approve=async()=>{const pending=await pendingSoftwareIdentity(a);f.local({...f.decision(pending.applicationId),name:undefined,principalId:verified.credential.principalId,grants:full});return pending;};
  return {a,f,key,login,verified,request,local,credentials,users,approve,async close(){await a.close();}};
}

test('key replacement recognizes equivalent ES256/RSA material across COSE encodings and rejects invalid keys',()=>{
  for(const rsa of [false,true]){
    const make=()=>{
      const pair=rsa?generateKeyPairSync('rsa',{modulusLength:2048}):generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=pair.publicKey.export({format:'jwk'});
      return rsa?new Map<number,number|Uint8Array>([[1,3],[3,-257],[-1,Buffer.from(jwk.n!,'base64url')],[-2,Buffer.from(jwk.e!,'base64url')]]):new Map<number,number|Uint8Array>([[1,2],[3,-7],[-1,1],[-2,Buffer.from(jwk.x!,'base64url')],[-3,Buffer.from(jwk.y!,'base64url')]]);
    };
    const encode=(key:Map<number,number|Uint8Array>)=>Buffer.from(isoCBOR.encode(key)).toString('base64url'),key=make(),original=encode(key);
    const reordered=encode(new Map(Array.from(key.entries()).reverse()));assert.notEqual(reordered,original);assert.equal(sameRegistrationPublicKey(original,reordered),true);assert.equal(sameRegistrationPublicKey(original,encode(make())),false);
    if(rsa){key.set(-1,Buffer.concat([Buffer.from([0]),key.get(-1) as Uint8Array]));assert.equal(sameRegistrationPublicKey(original,encode(key)),true);}
    assert.throws(()=>sameRegistrationPublicKey(original,'AA'),{code:'SECURITY_FORBIDDEN'});
  }
});

test('maintenance schemas reject identity injection, mixed namespaces, wrong types and unbounded pages',()=>{
  const base={action:'registration.credential.disable',instanceId:randomUUID(),id:randomUUID(),revision:1,confirm:true};
  for(const extra of [{actor:{principalId:SID}},{role:'admin'},{sid:SID},{instanceId:'localhost'},{id:'api-token'},{revision:-1},{revision:1.2},{revision:'1'},{confirm:false},{action:'registration.credential.reset'},{grants:[]}])assert.throws(()=>parseRegistrationMaintenance({...base,...extra}));
  for(const extra of [{offset:-1},{offset:10001},{offset:0.5},{limit:0},{limit:101},{userId:'bad-id'},{confirm:true}])assert.throws(()=>parseRegistrationMaintenance({action:'registration.credentials.list',instanceId:base.instanceId,...extra}));
  assert.throws(()=>parseRegistrationMaintenance({...base,action:'registration.credential.replace',applicationId:randomUUID()}));
  assert.throws(()=>parseRegistrationMaintenance({...base,action:'registration.credential.replace',applicationId:randomUUID(),grants:[],principalId:randomUUID()}));
  assert.doesNotThrow(()=>parseRegistrationMaintenance({...base,action:'registration.credential.replace',applicationId:randomUUID(),grants:[]}));
});

test('only the verified OS context can maintain identities; public login cannot obtain maintenance privileges',async()=>{
  const x=await fixture();try{
    for(const action of ['registration.credentials.list','registration.user.disable','registration.credential.disable','registration.credential.replace'])assert.throws(()=>dispatchLocalSecurity(x.f.registry,x.request(action)),{code:'SECURITY_LOCAL_IDENTITY_DENIED'});
    assert.throws(()=>x.f.local(x.request('registration.credential.disable',x.key.id,{role:'admin',sid:SID})),{code:'SECURITY_INVALID_REQUEST'});
    assert.equal(x.f.registry.readRegistrationStorage().credentials[0].state,'active');
    assert.notEqual(x.f.registry.verifyBrowserSession(x.login.session,origin).securityAdmin,true);
    const r=await x.a.app.inject({method:'POST',url:'/security/registration/v1/credential/disable',payload:x.request('registration.credential.disable')});assert.equal(r.statusCode,401);
  }finally{await x.close();}
});

test('local credential and user lists project only bounded review metadata and leave V1 un-migrated',async()=>{
  const x=await fixture();try{
    await x.approve();const other=x.f.registry.createPrincipal('Unrelated application');const api=x.f.registry.createCredential(other.id,'Independent API',read);
    const page=x.credentials({limit:1}),users=x.users(),store=x.f.registry.readRegistrationStorage();
    assert.equal(page.total,2);assert.equal(page.nextOffset,1);assert.equal(users.total,1);assert.equal(users.users[0].credentialCount,2);
    assert.equal(x.credentials({offset:1,limit:1,userId:x.key.userId}).credentials.length,1);
    assert.equal(x.credentials({userId:randomUUID()}).total,0);
    assert.equal(page.credentials[0].publicKeyFingerprint,createHash('sha256').update(Buffer.from(x.key.publicKeyCose,'base64url')).digest('hex'));
    assert.ok(!page.credentials.some(c=>c.id===api.credential.id));
    const text=JSON.stringify([page,users]);for(const hidden of [x.key.rawId,x.key.publicKeyCose,store.applications[0].userHandle,store.applications[0].continuationSecretHash,x.login.session,api.token])assert.equal(text.includes(hidden),false);
    page.credentials[0].grants.length=0;assert.deepEqual(x.f.registry.verifySession(x.login.session).credential.grants,full);
    const root=mkdtempSync(join(tmpdir(),'ModeDB-Maintenance-V1-')),r=SecurityRegistry.open(join(root,'security'),{protector:syntheticProtector(x.f.key)});
    try{for(const action of ['registration.users.list','registration.credentials.list'])r.withLocalActor(SID,()=>dispatchLocalSecurity(r,{action,instanceId:r.status().instanceId}));assert.equal(r.registrationStorageStatus().ledgerVersion,1);}finally{r.close();}
  }finally{await x.close();}
});

for(const action of ['disable','revoke'] as const)test(`credential ${action} invalidates only its own key and sessions and persists a minimal OS audit`,async()=>{
  const x=await fixture();try{
    const second=await x.approve(),sibling=await second.login();const api=x.f.registry.createCredential(x.verified.credential.principalId,'Independent API',read),apiSession=x.f.registry.createSession(api.token);
    const before=x.f.registry.status(),notifications:Array<readonly string[]>=[];const off=x.f.registry.onInvalidation(e=>notifications.push(e.credentialIds));
    const result=x.local('registration.credential.'+action);off();
    assert.equal(result.state,action==='disable'?'disabled':'revoked');assert.equal(result.revision,before.revision+1);assert.equal(x.f.registry.status().policyVersion,before.policyVersion+1);assert.deepEqual(notifications,[[x.key.id]]);
    assert.throws(()=>x.f.registry.verifySession(x.login.session),{code:'SECURITY_CREDENTIAL_REVOKED'});x.f.registry.verifySession(sibling.session);x.f.registry.verifySession(apiSession.session);
    const event=x.f.registry.auditEvents().at(-1)!;assert.equal(event.actor.principalId,SID);assert.equal(event.action,'registration.credential.'+action);assert.equal(event.source.transport,'local-ipc');assert.equal(event.resource?.credentialId,x.key.id);assert.equal(event.policyVersion,x.f.registry.status().policyVersion);
    assert.ok(!JSON.stringify(event).includes('synthetic_business'));await x.a.reopen();assert.throws(()=>x.f.registry.verifySession(x.login.session),{code:'SECURITY_CREDENTIAL_REVOKED'});x.f.registry.verifySession(sibling.session);
  }finally{await x.close();}
});

test('enabling requires disabled state and a live user, preserves reduced grants and never revives old sessions',async()=>{
  const x=await fixture();try{
    assert.throws(()=>x.local('registration.credential.enable'),{code:'SECURITY_POLICY_CONFLICT'});
    x.local('registration.credential.disable');x.f.advance(1000);x.local('registration.credential.restrict',x.key.id,{grants:read});
    x.local('registration.user.disable',x.key.userId);assert.throws(()=>x.local('registration.credential.enable'),{code:'SECURITY_FORBIDDEN'});
    x.local('registration.user.enable',x.key.userId);x.local('registration.credential.enable');
    assert.throws(()=>x.f.registry.verifySession(x.login.session),{code:'SECURITY_CREDENTIAL_REVOKED'});
    const b=await x.a.begin(),fresh=await x.a.service.complete(x.a.assertion(b.response,2),b.ceremonySecret,x.a.context);assert.deepEqual(x.f.registry.verifySession(fresh.session).credential.grants,read);
    x.local('registration.credential.revoke');assert.throws(()=>x.local('registration.credential.enable'),{code:'SECURITY_POLICY_CONFLICT'});
  }finally{await x.close();}
});

test('user disable covers every registered key while API identity stays independent; enabling requires fresh login',async()=>{
  const x=await fixture();try{
    const second=await x.approve(),session=await second.login(),api=x.f.registry.createCredential(x.verified.credential.principalId,'Independent API',read);
    x.local('registration.user.disable',x.key.userId);for(const token of [x.login.session,session.session])assert.throws(()=>x.f.registry.verifySession(token),{code:'SECURITY_CREDENTIAL_REVOKED'});x.f.registry.authenticate(api.token);
    await assert.rejects(()=>second.login(2),{code:'SECURITY_AUTHENTICATION_PROOF_INVALID'});
    x.local('registration.user.enable',x.key.userId);for(const token of [x.login.session,session.session])assert.throws(()=>x.f.registry.verifySession(token),{code:'SECURITY_CREDENTIAL_REVOKED'});
    x.f.registry.verifySession((await second.login(3)).session);assert.equal(x.users().users[0].enabled,true);
  }finally{await x.close();}
});

test('terminal states, wrong namespaces, missing confirmation and stale CAS fail with audited denials',async()=>{
  const x=await fixture();try{
    const page=x.credentials(),stale=x.request('registration.credential.disable',x.key.id,{revision:page.revision});x.users();
    assert.throws(()=>x.f.local(stale),{code:'SECURITY_POLICY_CONFLICT'});
    for(const extra of [{instanceId:randomUUID()},{confirm:false},{id:randomUUID()},{id:x.key.userId}])assert.throws(()=>x.f.local(x.request('registration.credential.disable',x.key.id,extra)));
    x.local('registration.credential.revoke');for(const action of ['enable','disable','revoke','replace','restrict'])assert.throws(()=>x.local('registration.credential.'+action,x.key.id,{...(action==='replace'?{applicationId:randomUUID()}:{}),...(['replace','restrict'].includes(action)?{grants:[]}: {})}),{code:'SECURITY_POLICY_CONFLICT'});
    assert.equal(x.f.registry.auditEvents().at(-1)!.result,'denied');assert.equal(x.f.registry.readRegistrationStorage().credentials.length,1);
  }finally{await x.close();}
});

test('formal reduction accepts subsets only and cannot widen a resource or mutate an exact release digest',async()=>{
  const x=await fixture();try{
    for(const grants of [[...full,{database:'other',resource:'*',actions:['model.read']}],[{...full[0],actions:['schema.manage']}],[{...full[0],resource:'Item'}]])assert.throws(()=>x.local('registration.credential.restrict',x.key.id,{grants}),{code:'SECURITY_INVALID_REQUEST'});
    const r=x.local('registration.credential.restrict',x.key.id,{grants:read});assert.deepEqual(r.grants,read);assert.deepEqual(x.f.registry.verifySession(x.login.session).credential.grants,read);
    x.local('registration.credential.restrict',x.key.id,{grants:[]});assert.deepEqual(x.f.registry.verifySession(x.login.session).credential.grants,[]);
  }finally{await x.close();}
});

for(const disabled of [false,true])test(`atomic replacement of ${disabled?'disabled':'active'} key preserves its user, revokes old sessions and requires a new valid proof`,async()=>{
  const x=await fixture();try{
    const material=readFileSync(join(x.f.dir,'instance.key')),before=x.f.registry.listCredentials();
    if(disabled)x.local('registration.credential.disable');
    const pending=await pendingSoftwareIdentity(x.a),policy=x.f.registry.status().policyVersion;
    const result=x.local('registration.credential.replace',x.key.id,{applicationId:pending.applicationId,grants:read});
    assert.equal(result.state,'revoked');assert.notEqual(result.replacementCredentialId,x.key.id);assert.equal(result.userId,x.key.userId);assert.deepEqual(result.grants,read);assert.equal(x.f.registry.status().policyVersion,policy+1);
    const store=x.f.registry.readRegistrationStorage(),key=store.credentials.find(c=>c.id===result.replacementCredentialId)!;assert.equal(store.users.length,1);assert.equal(key.state,'active');assert.equal(key.userId,x.key.userId);assert.deepEqual(key.grants,read);
    assert.equal(x.f.registry.status().sessions,1);assert.deepEqual(x.f.registry.listCredentials(),before);assert.throws(()=>x.f.registry.verifySession(x.login.session),{code:'SECURITY_CREDENTIAL_REVOKED'});
    const b=await x.a.begin();await assert.rejects(()=>x.a.service.complete(x.a.assertion(b.response,2),b.ceremonySecret,x.a.context),{code:'SECURITY_AUTHENTICATION_PROOF_INVALID'});
    const fresh=await pending.login();assert.deepEqual(x.f.registry.verifySession(fresh.session).credential.grants,read);
    const event=x.f.registry.auditEvents().find(e=>e.action==='registration.credential.replace')!;assert.equal(event.resource?.credentialId,x.key.id);assert.equal(event.taskId,pending.applicationId);assert.ok(!JSON.stringify(event).includes(key.publicKeyCose));
    await x.a.reopen();x.f.registry.verifySession(fresh.session);assert.throws(()=>x.f.registry.verifySession(x.login.session),{code:'SECURITY_CREDENTIAL_REVOKED'});assert.deepEqual(readFileSync(join(x.f.dir,'instance.key')),material);
  }finally{await x.close();}
});

test('replacement never inherits old grants; explicit empty grants remain zero scope',async()=>{
  const x=await fixture();try{const pending=await pendingSoftwareIdentity(x.a);x.local('registration.credential.replace',x.key.id,{applicationId:pending.applicationId,grants:[]});assert.deepEqual(x.f.registry.verifySession((await pending.login()).session).credential.grants,[]);}finally{await x.close();}
});

for(const mode of ['unverified','expired','approved','user-disabled','same-key','same-key-reencoded'] as const)test(`replacement rejects ${mode} candidate and leaves old credential and target application intact`,async()=>{
  const x=await fixture();try{
    let id:string;
    if(mode==='unverified')id=(await x.f.begin()).registrationId;
    else if(mode==='approved')id=x.key.applicationId;
    else{const sameKey=mode==='same-key'||mode==='same-key-reencoded';const pending=await pendingSoftwareIdentity(x.a,sameKey?{publicKeyCose:x.key.publicKeyCose,reencode:mode==='same-key-reencoded'}:undefined);id=pending.applicationId;if(mode==='expired')x.f.advance(86400001);if(mode==='user-disabled')x.local('registration.user.disable',x.key.userId);
      if(sameKey){
        const state=x.f.registry.readRegistrationStorage(),app=state.applications.find(a=>a.id===id)!;assert.ok(app.candidate);
        assert.equal(app.candidate.publicKeyCose===x.key.publicKeyCose,mode==='same-key');assert.notEqual(app.candidate.rawId,x.key.rawId);
      }
    }
    const state=x.f.registry.readRegistrationStorage();assert.throws(()=>x.local('registration.credential.replace',x.key.id,{applicationId:id,grants:read}));
    assert.deepEqual(x.f.registry.readRegistrationStorage().credentials,state.credentials);assert.deepEqual(x.f.registry.readRegistrationStorage().applications,state.applications);
  }finally{await x.close();}
});

test('lost credentials are revoked first; a fresh application needs explicit owner association and approval before login',async()=>{
  const x=await fixture();try{
    x.local('registration.credential.revoke');const pending=await pendingSoftwareIdentity(x.a);await assert.rejects(()=>pending.login(),{code:'SECURITY_AUTHENTICATION_PROOF_INVALID'});
    assert.throws(()=>x.local('registration.credential.replace',x.key.id,{applicationId:pending.applicationId,grants:full}),{code:'SECURITY_POLICY_CONFLICT'});
    x.f.local({...x.f.decision(pending.applicationId),name:undefined,principalId:x.verified.credential.principalId,grants:read});const fresh=await pending.login(2);assert.equal(x.f.registry.verifySession(fresh.session).sessionParent?.kind,'registered-public-key');assert.deepEqual(x.f.registry.verifySession(fresh.session).credential.grants,read);assert.equal(x.f.registry.readRegistrationStorage().credentials.find(c=>c.id===x.key.id)!.state,'revoked');
  }finally{await x.close();}
});

test('per-user tombstone capacity also applies to replacement; it cannot partially revoke the old key',async()=>{
  const x=await fixture();try{
    for(let i=1;i<20;i++){x.f.advance(60001);await x.approve();}const pending=await pendingSoftwareIdentity(x.a);
    assert.throws(()=>x.local('registration.credential.replace',x.key.id,{applicationId:pending.applicationId,grants:read}),{code:'SECURITY_RESPONSE_LIMIT'});
    assert.equal(x.f.registry.readRegistrationStorage().credentials.length,20);assert.equal(x.f.registry.readRegistrationStorage().credentials[0].state,'active');assert.equal(x.f.registry.readRegistrationStorage().applications.find(a=>a.id===pending.applicationId)!.state,'pending');x.f.registry.verifySession(x.login.session);
  }finally{await x.close();}
});

test('explicit CLI rejects missing configs, duplicate flags, unrelated namespaces and invalid grant files before loading a config',async()=>{
  for(const action of ['registration-credentials-list','registration-users-list','registration-credential-disable','registration-credential-enable','registration-credential-revoke','registration-user-disable','registration-user-enable','registration-credential-restrict','registration-credential-replace']){
    await assert.rejects(()=>runRegistrationApprovalCli([action,'--instance',randomUUID()]),{code:'SECURITY_INVALID_REQUEST'});
    await assert.rejects(()=>runRegistrationApprovalCli([action,'-c','missing.json','--role','admin']),{code:'SECURITY_INVALID_REQUEST'});
    await assert.rejects(()=>runRegistrationApprovalCli([action,'-c','missing.json','--config','missing.json']),{code:'SECURITY_INVALID_REQUEST'});
  }
  const root=mkdtempSync(join(tmpdir(),'ModeDB-Maintenance-CLI-')),file=join(root,'oversize.json');writeFileSync(file,' '.repeat(32769));
  await assert.rejects(()=>runRegistrationApprovalCli(['registration-credential-replace','-c','missing.json','--grants-file',file]),{code:'SECURITY_INVALID_REQUEST'});
});

test('audit capacity rejects an entire maintenance transaction without changing state or key files',async()=>{
  const x=await fixture();let r:SecurityRegistry|undefined;
  try{
    const limit=x.f.registry.auditEvents().length;x.f.registry.close();r=SecurityRegistry.open(x.f.dir,{protector:syntheticProtector(x.f.key),now:()=>x.f.now,auditLimit:limit});
    assert.throws(()=>r!.withLocalActor(SID,()=>dispatchLocalSecurity(r!,{action:'registration.credential.revoke',instanceId:x.f.instanceId,id:x.key.id,revision:r!.status().revision,confirm:true})),{code:'SECURITY_AUDIT_CAPACITY'});
    assert.equal(r.readRegistrationStorage().credentials[0].state,'active');r.verifySession(x.login.session);
  }finally{r?.close();await x.close();}
});

for(const action of ['credential.disable','user.disable','credential.replace'] as const)for(const point of ['staged','journaled','replaced'] as const)test(`${action} ${point} interruption recovers one complete identity/session/audit transaction`,async()=>{
  let armed=false;const x=await fixture(p=>{if(armed&&p===point)throw Error('SYNTHETIC_MAINTENANCE_FAULT');});
  try{
    const pending=action==='credential.replace'?await pendingSoftwareIdentity(x.a):undefined;
    const id=action==='user.disable'?x.key.userId:x.key.id,command=x.request('registration.'+action,id,pending?{applicationId:pending.applicationId,grants:read}:{});
    armed=true;assert.throws(()=>x.f.local(command),{code:'SECURITY_STORE_WRITE_FAILED'});armed=false;await x.a.reopen();
    const committed=point!=='staged',state=x.f.registry.readRegistrationStorage();assert.equal(x.f.registry.auditEvents().filter(e=>e.action==='registration.'+action&&e.result==='succeeded').length,committed?1:0);
    if(committed)assert.throws(()=>x.f.registry.verifySession(x.login.session),{code:'SECURITY_CREDENTIAL_REVOKED'});else x.f.registry.verifySession(x.login.session);
    if(action==='credential.replace'){
      assert.equal(state.credentials.length,committed?2:1);assert.equal(state.applications.find(a=>a.id===pending!.applicationId)!.state,committed?'approved':'pending');
      if(committed){const fresh=await pending!.login();assert.deepEqual(x.f.registry.verifySession(fresh.session).credential.grants,read);const b=await x.a.begin();await assert.rejects(()=>x.a.service.complete(x.a.assertion(b.response,2),b.ceremonySecret,x.a.context),{code:'SECURITY_AUTHENTICATION_PROOF_INVALID'});}
      else{await assert.rejects(()=>pending!.login(),{code:'SECURITY_AUTHENTICATION_PROOF_INVALID'});const b=await x.a.begin();x.f.registry.verifySession((await x.a.service.complete(x.a.assertion(b.response,2),b.ceremonySecret,x.a.context)).session);}
    }
    else if(action==='user.disable')assert.equal(state.users[0].enabled,!committed);else assert.equal(state.credentials[0].state,committed?'disabled':'active');
  }finally{armed=false;await x.close();}
});

test('required native Windows DPAPI and actual CLI maintain, replace and recover a software-signed identity', {timeout:180000},async()=>{
  assert.equal(process.platform,'win32','Native Windows is required, never skip this acceptance');
  const a=await authenticationFixture(-7,false,undefined,full,new WindowsSecretProtector()),{f}=a;
  let channel:Awaited<ReturnType<typeof startLocalSecurityChannel>>|undefined;
  try{
    const config=ensureModelDbLayoutAtRoot(f.root),unicodeConfig=join(f.root,'维护配置.json'),grants=join(f.root,'grants.json');copyFileSync(config,unicodeConfig);writeFileSync(grants,JSON.stringify(read));
    const old=f.registry.readRegistrationStorage().credentials[0],begin=await a.begin(),login=await a.service.complete(a.assertion(begin.response),begin.ceremonySecret,a.context),material=readFileSync(join(f.dir,'instance.key'));
    channel=await startLocalSecurityChannel(f.dir,f.registry);
    const cli=(args:string[])=>new Promise<{code:number|null;output:string}>((done,fail)=>{
      const child=spawn(process.execPath,['--import','tsx','packages/server/src/cli.ts','security',...args,'--instance',f.instanceId,'-c',unicodeConfig],{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';const timer=setTimeout(()=>{child.kill();fail(Error('SYNTHETIC_CLI_TIMEOUT'));},30000);
      child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.once('error',fail);child.once('close',code=>{clearTimeout(timer);done({code,output});});
    });
    const list=async()=>{const r=await cli(['registration-credentials-list']);assert.equal(r.code,0,r.output);return JSON.parse(r.output) as CredentialPage;};
    const command=async(action:string,id:string,extra:string[]=[])=>{const page=await list(),r=await cli([action,'--id',id,'--revision',String(page.revision),'--yes',...extra]);assert.equal(r.code,0,r.output);return JSON.parse(r.output) as Result;};
    assert.equal((await list()).credentials[0].state,'active');
    await command('registration-credential-disable',old.id);assert.throws(()=>f.registry.verifySession(login.session),{code:'SECURITY_CREDENTIAL_REVOKED'});
    await command('registration-credential-restrict',old.id,['--grants-file',grants]);await command('registration-credential-enable',old.id);
    const user=await cli(['registration-users-list']);assert.equal(user.code,0,user.output);assert.equal((JSON.parse(user.output) as UserPage).users[0].id,old.userId);
    const pending=await pendingSoftwareIdentity(a);const replaced=await command('registration-credential-replace',old.id,['--application',pending.applicationId,'--grants-file',grants]);const fresh=await pending.login();assert.deepEqual(f.registry.verifySession(fresh.session).credential.grants,read);
    await command('registration-user-disable',old.userId);assert.throws(()=>f.registry.verifySession(fresh.session),{code:'SECURITY_CREDENTIAL_REVOKED'});await command('registration-user-enable',old.userId);assert.throws(()=>f.registry.verifySession(fresh.session),{code:'SECURITY_CREDENTIAL_REVOKED'});const enabled=await pending.login(2);f.registry.verifySession(enabled.session);
    await command('registration-credential-revoke',replaced.replacementCredentialId);assert.throws(()=>f.registry.verifySession(enabled.session),{code:'SECURITY_CREDENTIAL_REVOKED'});
    await assert.rejects(()=>callLocalSecurity(f.dir,{action:'registration.credentials.list',instanceId:f.instanceId,role:'admin'}),{code:'SECURITY_INVALID_REQUEST'});
    const events=f.registry.auditEvents().filter(e=>e.action==='registration.credential.replace');assert.equal(events.length,1);assert.equal(events[0].actor.principalId,new WindowsSecretProtector().currentIdentity());
    await channel.close();channel=undefined;await a.reopen();assert.ok(f.registry.readRegistrationStorage().credentials.every(c=>c.state==='revoked'));assert.deepEqual(readFileSync(join(f.dir,'instance.key')),material);assert.equal(f.registry.listCredentials().length,0);
  }finally{await channel?.close();await a.close();}
});
