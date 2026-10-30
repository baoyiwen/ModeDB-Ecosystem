import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import type { SecurityGrant } from '@mode-db/shared';
import type { AtomicCommitPoint } from '../../packages/common/src/atomic-file.js';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';
import { assertLocalSecurityCaller, callLocalSecurity, dispatchLocalSecurity, startLocalSecurityChannel } from '../../packages/server/src/security/local-management-channel.js';
import type { SecretProtector } from '../../packages/server/src/security/windows-secret-protector.js';
import { WindowsSecretProtector } from '../../packages/server/src/security/windows-secret-protector.js';
import { parseRegistrationApprovalRequest } from '../../packages/server/src/security/registration-approval.js';
import { ensureModelDbLayoutAtRoot } from '../../packages/server/src/modeldb-default-home.js';
import { runRegistrationApprovalCli } from '../../packages/server/src/cli-security-registration.js';
import { RegistrationService } from '../../packages/server/src/security/registration-service.js';

const start = Date.UTC(2026,9,27), sid='S-1-5-21-100-200-300-400';
const utc=(n:number)=>new Date(n).toISOString();
const scopes: SecurityGrant[]=[{database:'synthetic_business',resource:'*',actions:['model.read','model.write']}];
interface Page { instanceId:string;revision:number;applications:Array<{id:string;state:string;proofVerified:boolean;publicKeyFingerprint?:string}>;total:number;nextOffset:number|null }
interface Decision {registrationId:string;state:string;revision:number;principalId:string;userId:string;credentialId:string;grants:SecurityGrant[]}

/** Trusted persistence fixture only; random public-key bytes are not a WebAuthn proof. */
function seed(registry: SecurityRegistry, now=start, verified=true, secret=randomBytes(32)) {
  const store=registry.readRegistrationStorage(),id=randomUUID();
  store.applications.push({id,instanceId:registry.status().instanceId,serverOrigin:'https://modeldb-a.example.test',rpId:'modeldb-a.example.test',
    deploymentDescriptorSha256:'a'.repeat(64),displayName:'Untrusted device note',userHandle:randomBytes(32).toString('base64url'),
    continuationSecretHash:createHash('sha256').update(secret).digest('hex'),createdAtUtc:utc(now),expiresAtUtc:utc(now+86400000),state:'pending'});
  store.challenges.push({id:randomUUID(),applicationId:id,purpose:'registration',challengeHash:'c'.repeat(64),state:'issued',createdAtUtc:utc(now),expiresAtUtc:utc(now+60000)});
  registry.commitRegistrationStorage(registry.status().revision,store);
  if(verified){
    const next=registry.readRegistrationStorage(),app=next.applications.find(a=>a.id===id)!,challenge=next.challenges.find(c=>c.applicationId===id)!;
    challenge.state='consumed';challenge.finishedAtUtc=utc(now);
    app.candidate={rawId:randomBytes(32).toString('base64url'),publicKeyCose:randomBytes(77).toString('base64url'),algorithm:-7,counter:0,deviceType:'multiDevice',backedUp:true};
    app.verifiedAtUtc=utc(now);registry.commitRegistrationStorage(registry.status().revision,next);
  }
  return id;
}
function fixture(auditLimit=10000){
  const root=mkdtempSync(join(tmpdir(),'ModeDB-Registration-Approval-')),dir=join(root,'security'),key=randomBytes(32);
  let now=start,failure=false,point:AtomicCommitPoint|undefined;
  const protector: SecretProtector={id:'test-only-aes-gcm',ensureDirectory(p){mkdirSync(p,{recursive:true});},
    protect(bytes,purpose){if(failure){throw Error('injected ENOSPC');}const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(purpose));return Buffer.concat([iv,c.update(bytes),c.final(),c.getAuthTag()]).toString('base64');},
    unprotect(value,purpose){const b=Buffer.from(value,'base64'),d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAAD(Buffer.from(purpose));d.setAuthTag(b.subarray(-16));return Buffer.concat([d.update(b.subarray(12,-16)),d.final()]);}};
  const options={protector,auditLimit,now:()=>now,onCommitPoint(p:AtomicCommitPoint){if(p===point){throw Error('injected interruption');}}};
  let registry=SecurityRegistry.open(dir,options);registry.migrateRegistrationStorage(registry.status().revision);
  const secret=randomBytes(32),id=seed(registry,start,true,secret);
  const local=(r:unknown)=>registry.withLocalActor(sid,()=>dispatchLocalSecurity(registry,r));
  const approve=(extra:Record<string,unknown>={})=>({action:'registration.approve',instanceId:registry.status().instanceId,id,revision:registry.status().revision,confirm:true,name:'Verified operator',grants:scopes,...extra});
  const list=()=>local({action:'registration.list',instanceId:registry.status().instanceId}) as Page;
  return {root,dir,id,secret:secret.toString('base64url'),options,protector,local,approve,list,get registry(){return registry;},
    setTime(n:number){now=n;},fail(b:boolean){failure=b;},fault(p?:AtomicCommitPoint){point=p;},
    reopen(){registry.close();failure=false;point=undefined;registry=SecurityRegistry.open(dir,options);},close(){registry.close();}};
}

test('approval requires a verified local actor context; JSON role and SID cannot establish it',()=>{
  const f=fixture();try{
    assert.throws(()=>f.registry.manageRegistration(f.approve()),{code:'SECURITY_LOCAL_IDENTITY_DENIED'});
    assert.throws(()=>dispatchLocalSecurity(f.registry,{...f.approve(),role:'admin',sid}),{code:'SECURITY_LOCAL_IDENTITY_DENIED'});
    assert.equal(f.registry.readRegistrationStorage().credentials.length,0);
  }finally{f.close();}
});
test('the parent broker check rejects foreign or malformed SIDs and accepts owner/SYSTEM only',()=>{
  assert.doesNotThrow(()=>assertLocalSecurityCaller(sid,sid));assert.doesNotThrow(()=>assertLocalSecurityCaller('S-1-5-18',sid));
  for(const caller of ['S-1-5-21-100-200-300-401','Administrator','127.0.0.1',sid+'\n']){
    assert.throws(()=>assertLocalSecurityCaller(caller,sid),{code:'SECURITY_LOCAL_IDENTITY_DENIED'});
  }
});
test('local lists are bounded metadata with stable fingerprints; V1 lists do not migrate',()=>{
  const f=fixture();try{
    const page=f.list();assert.equal(page.total,1);assert.equal(page.revision,f.registry.status().revision);
    const store=f.registry.readRegistrationStorage(),candidate=store.applications[0]!.candidate!;
    assert.equal(page.applications[0]!.publicKeyFingerprint,createHash('sha256').update(Buffer.from(candidate.publicKeyCose,'base64url')).digest('hex'));
    const json=JSON.stringify(page);for(const hidden of [candidate.rawId,candidate.publicKeyCose,store.applications[0]!.userHandle,store.applications[0]!.continuationSecretHash])assert.equal(json.includes(hidden),false);
    assert.equal((f.local({action:'registration.list',instanceId:page.instanceId,offset:1,limit:1}) as Page).applications.length,0);
    for(const limit of [0,101,1.5])assert.throws(()=>f.local({action:'registration.list',instanceId:page.instanceId,limit}),{code:'SECURITY_INVALID_REQUEST'});
    const root=mkdtempSync(join(tmpdir(),'ModeDB-Approval-V1-')),r=SecurityRegistry.open(join(root,'security'),f.options);
    try{r.withLocalActor(sid,()=>r.manageRegistration({action:'registration.list',instanceId:r.status().instanceId}));assert.equal(r.registrationStorageStatus().ledgerVersion,1);}finally{r.close();}
  }finally{f.close();}
});
test('approval atomically creates an operator, user, scoped public-key credential and audit, but no token or session',()=>{
  const f=fixture();try{
    const before=f.registry.status(),result=f.local(f.approve()) as Decision;
    assert.equal(result.state,'approved');assert.equal(result.revision,before.revision+1);assert.deepEqual(result.grants,scopes);
    const s=f.registry.readRegistrationStorage();assert.equal(s.applications[0]!.state,'approved');assert.equal(s.credentials.length,1);assert.equal(s.users.length,1);
    assert.equal(s.users[0]!.principalId,result.principalId);assert.equal(s.credentials[0]!.userId,s.users[0]!.id);
    assert.equal(f.registry.status().policyVersion,before.policyVersion+1);assert.equal(f.registry.status().sessions,0);assert.equal(f.registry.listCredentials().length,0);
    const event=f.registry.auditEvents().at(-1)!;assert.equal(event.action,'registration.approve');assert.equal(event.actor.principalId,sid);assert.equal(event.source.transport,'local-ipc');assert.equal(event.taskId,f.id);
    const log=JSON.stringify(event);for(const hidden of ['Verified operator','synthetic_business',s.credentials[0]!.publicKeyCose])assert.equal(log.includes(hidden),false);
    result.grants.length=0;assert.deepEqual(f.registry.readRegistrationStorage().credentials[0]!.grants,scopes);
    f.reopen();assert.equal(f.registry.readRegistrationStorage().credentials[0]!.id,result.credentialId);
    assert.throws(()=>f.registry.authenticate(result.credentialId),{code:'SECURITY_CREDENTIAL_INVALID'});
  }finally{f.close();}
});
test('existing enabled operators reuse a user while application principals and disabled users are rejected',()=>{
  const f=fixture();try{
    const p=f.registry.createPrincipal('Existing operator','operator');
    const first=f.local(f.approve({name:undefined,principalId:p.id})) as Decision;
    const id=seed(f.registry),second=f.local(f.approve({id,name:undefined,principalId:p.id})) as Decision;
    assert.equal(second.userId,first.userId);assert.equal(f.registry.readRegistrationStorage().users.length,1);
    const untrusted=f.registry.createPrincipal('Application');const third=seed(f.registry);
    assert.throws(()=>f.local(f.approve({id:third,name:undefined,principalId:untrusted.id})),{code:'SECURITY_FORBIDDEN'});
    const s=f.registry.readRegistrationStorage();s.users[0]!.enabled=false;f.registry.commitRegistrationStorage(f.registry.status().revision,s);
    assert.throws(()=>f.local(f.approve({id:third,name:undefined,principalId:p.id})),{code:'SECURITY_FORBIDDEN'});
    assert.equal(f.registry.readRegistrationStorage().credentials.length,2);
  }finally{f.close();}
});
test('approved public polling returns only status, never the approved principal, grants or a business session',()=>{
  const f=fixture();let service:RegistrationService|undefined;
  try{
    const approved=f.local(f.approve()) as Decision;
    service=new RegistrationService(f.registry,undefined,undefined,()=>start);
    const result=service.status({format:'modeldb.device-registration.v1',version:1,instanceId:f.registry.status().instanceId,registrationId:f.id,continuationSecret:f.secret},
      {requestId:randomUUID(),source:{peerIp:'127.0.0.1',clientIp:'127.0.0.1',clientIpBasis:'socket',secure:true},recheck(){}});
    assert.equal(result.state,'approved');const json=JSON.stringify(result);
    for(const hidden of [approved.principalId,approved.userId,approved.credentialId,'synthetic_business',f.secret])assert.equal(json.includes(hidden),false);
    assert.equal(f.registry.status().sessions,0);assert.equal(f.registry.listCredentials().length,0);
  }finally{service?.close();f.close();}
});
test('older V2 credentials without a grants field load with empty scopes and inherit no Bearer privileges',()=>{
  const f=fixture();try{
    const approved=f.local(f.approve()) as Decision;
    f.registry.createCredential(approved.principalId,'Unrelated application credential',scopes);
    const instanceId=f.registry.status().instanceId;f.registry.close();
    const raw=JSON.parse(f.protector.unprotect(readFileSync(join(f.dir,'registry.mds'),'utf8'),'modeldb-registry-v1:'+instanceId).toString());
    delete raw.registration.credentials[0].grants;
    writeFileSync(join(f.dir,'registry.mds'),f.protector.protect(Buffer.from(JSON.stringify(raw)),'modeldb-registry-v1:'+instanceId));
    f.reopen();const page=f.list() as unknown as {applications:Array<{grants:SecurityGrant[]}>};
    assert.deepEqual(page.applications[0]!.grants,[]);assert.equal(f.registry.readRegistrationStorage().credentials[0]!.grants,undefined);
  }finally{f.close();}
});
test('unverified, expired and future-dated applications cannot be approved',()=>{
  const f=fixture();try{
    const id=seed(f.registry,start,false);assert.throws(()=>f.local(f.approve({id})),{code:'SECURITY_FORBIDDEN'});
    f.setTime(start-1);assert.throws(()=>f.local(f.approve()),{code:'SECURITY_POLICY_CONFLICT'});
    f.setTime(start+86400000);assert.throws(()=>f.local(f.approve()),{code:'SECURITY_POLICY_CONFLICT'});
    assert.equal(f.list().applications[0]!.state,'expired');assert.equal(f.registry.readRegistrationStorage().credentials.length,0);
  }finally{f.close();}
});
test('rejection is terminal and also consumes an unfinished application challenge',()=>{
  const f=fixture();try{
    const id=seed(f.registry,start,false),request={action:'registration.reject',instanceId:f.registry.status().instanceId,id,revision:f.registry.status().revision,confirm:true};
    assert.equal((f.local(request) as Decision).state,'rejected');
    const s=f.registry.readRegistrationStorage();assert.equal(s.challenges.find(c=>c.applicationId===id)!.state,'rejected');
    assert.throws(()=>f.local(f.approve({id})),{code:'SECURITY_POLICY_CONFLICT'});
    assert.equal(f.registry.auditEvents().at(-2)!.action,'registration.reject');
  }finally{f.close();}
});
test('stale revisions and terminal decisions reject without creating duplicate principals or credentials',()=>{
  const f=fixture();try{
    const request=f.approve();f.list();assert.throws(()=>f.local(request),{code:'SECURITY_POLICY_CONFLICT'});
    f.local(f.approve());assert.throws(()=>f.local(f.approve()),{code:'SECURITY_POLICY_CONFLICT'});
    assert.throws(()=>f.local({action:'registration.reject',instanceId:f.registry.status().instanceId,id:f.id,revision:f.registry.status().revision,confirm:true}),{code:'SECURITY_POLICY_CONFLICT'});
    assert.equal(f.registry.readRegistrationStorage().credentials.length,1);assert.equal(f.registry.readRegistrationStorage().users.length,1);
  }finally{f.close();}
});
test('wrong instance, missing confirmation, identity injection and ambiguous operator selection fail with audited denials',()=>{
  const f=fixture();try{
    for(const extra of [{instanceId:randomUUID()},{confirm:false},{role:'admin'},{actor:{principalId:sid}},{name:' A '},{principalId:randomUUID()},{name:undefined}]){
      assert.throws(()=>f.local(f.approve(extra)));assert.equal(f.registry.auditEvents().at(-1)!.result,'denied');
    }
    assert.equal(f.registry.readRegistrationStorage().credentials.length,0);
  }finally{f.close();}
});
test('approval grants require exact databases, known actions and pinned callable releases; explicit empty scopes remain denied by default',()=>{
  const f=fixture();try{
    for(const grants of [undefined,[{database:'*',resource:'*',actions:['model.read']}],[{...scopes[0],database:'a\n'}],
      [{...scopes[0],actions:['admin']}],[{...scopes[0],actions:[]}],[{...scopes[0],role:'admin'}],
      [{database:'a',resource:'*',actions:['callable.query'],releaseDigest:'a'.repeat(64)}],
      [{database:'a',resource:'published',actions:['callable.query']}],Array(101).fill(scopes[0])]){
      assert.throws(()=>f.local(f.approve({grants})),{code:'SECURITY_INVALID_REQUEST'});
    }
    f.local(f.approve({grants:[]}));assert.deepEqual(f.registry.readRegistrationStorage().credentials[0]!.grants,[]);
    assert.doesNotThrow(()=>parseRegistrationApprovalRequest({...f.approve(),grants:[{database:'a',resource:'published',actions:['callable.query'],releaseDigest:'a'.repeat(64)}]}));
  }finally{f.close();}
});
test('stored registration scopes cannot be replaced and reset revokes the approved identity without changing key files',()=>{
  const f=fixture();try{
    f.local(f.approve());const original=readFileSync(join(f.dir,'instance.key'));
    const s=f.registry.readRegistrationStorage();s.credentials[0]!.grants=[];
    assert.throws(()=>f.registry.commitRegistrationStorage(f.registry.status().revision,s),{code:'SECURITY_REGISTRATION_SCHEMA_INVALID'});
    f.registry.resetAccess();assert.equal(f.registry.readRegistrationStorage().credentials[0]!.state,'revoked');
    assert.deepEqual(readFileSync(join(f.dir,'instance.key')),original);
  }finally{f.close();}
});
test('approval respects per-operator capacity without creating partial user or credential rows',()=>{
  const f=fixture();try{
    const first=f.local(f.approve()) as Decision;
    for(let i=1;i<20;i++){
      const id=seed(f.registry);f.local(f.approve({id,name:undefined,principalId:first.principalId}));
    }
    const id=seed(f.registry);
    assert.throws(()=>f.local(f.approve({id,name:undefined,principalId:first.principalId})),{code:'SECURITY_RESPONSE_LIMIT'});
    const s=f.registry.readRegistrationStorage();assert.equal(s.credentials.length,20);assert.equal(s.users.length,1);
    assert.equal(s.applications.find(a=>a.id===id)!.state,'pending');
  }finally{f.close();}
});
test('CLI rejects missing explicit config, duplicate or unrelated options and oversized grants before loading any configuration',async()=>{
  for(const args of [ ['registration-list','--instance',randomUUID()],
    ['registration-list','-c','missing.json','--config','missing.json'],['registration-list','-c','missing.json','--role','admin'],
    ['registration-approve','-c','missing.json','--id',randomUUID()],['registration-unknown'] ]){
    await assert.rejects(()=>runRegistrationApprovalCli(args),{code:'SECURITY_INVALID_REQUEST'});
  }
  const root=mkdtempSync(join(tmpdir(),'ModeDB-Approval-CLI-Input-')),file=join(root,'oversized.json');writeFileSync(file,' '.repeat(32769));
  await assert.rejects(()=>runRegistrationApprovalCli(['registration-approve','-c','missing.json','--grants-file',file]),{code:'SECURITY_INVALID_REQUEST'});
});
test('protection write failure never reports approved and persists no partial operator association',()=>{
  const f=fixture();try{
    const request=f.approve();f.fail(true);assert.throws(()=>f.local(request),{code:'SECURITY_STORE_WRITE_FAILED'});
    f.reopen();assert.equal(f.registry.readRegistrationStorage().applications[0]!.state,'pending');assert.equal(f.registry.readRegistrationStorage().users.length,0);
  }finally{f.close();}
});
test('audit capacity refuses the whole approval transaction',()=>{
  const f=fixture(20);try{
    while(f.registry.auditEvents().length<20)f.registry.recordRejectedMaintenance();
    assert.throws(()=>f.local(f.approve()),{code:'SECURITY_AUDIT_CAPACITY'});
    assert.equal(f.registry.readRegistrationStorage().credentials.length,0);
  }finally{f.close();}
});
for(const point of ['staged','journaled','replaced'] as const){
  test('approval recovers a consistent identity and audit after '+point+' failure',()=>{
    const f=fixture();try{
      const request=f.approve();f.fault(point);assert.throws(()=>f.local(request),{code:'SECURITY_STORE_WRITE_FAILED'});
      f.reopen();const s=f.registry.readRegistrationStorage(),committed=point==='staged'?0:1;
      assert.equal(s.credentials.length,committed);assert.equal(s.users.length,committed);
      assert.equal(f.registry.auditEvents().filter(e=>e.action==='registration.approve' && e.result==='succeeded').length,committed);
      assert.equal(s.applications[0]!.state,committed?'approved':'pending');
    }finally{f.close();}
  });
}

test('required Windows DPAPI and actual local CLI list/approve/reject preserve OS attribution and issue no access secrets',async()=>{
  assert.equal(process.platform,'win32','Windows is required; this acceptance must not be skipped');
  const root=mkdtempSync(join(tmpdir(),'ModeDB-Approval-CLI-中文-')),config=ensureModelDbLayoutAtRoot(root),dir=join(root,'security');
  let registry=SecurityRegistry.open(dir),channel:Awaited<ReturnType<typeof startLocalSecurityChannel>>|undefined;
  try{
    registry.migrateRegistrationStorage(registry.status().revision);const id=seed(registry,Date.now()),other=seed(registry,Date.now(),false);
    const instanceId=registry.status().instanceId;channel=await startLocalSecurityChannel(dir,registry);
    const cli=(args:string[])=>new Promise<{code:number|null;output:string}>((done,reject)=>{
      const child=spawn(process.execPath,['--import','tsx','packages/server/src/cli.ts','security',...args,'-c',config],{windowsHide:true,stdio:['ignore','pipe','pipe']});
      let output='';const timer=setTimeout(()=>{child.kill();reject(Error('CLI timeout'));},30000);
      child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.once('error',reject);child.once('close',code=>{clearTimeout(timer);done({code,output});});
    });
    const listed=await cli(['registration-list','--instance',instanceId]);assert.equal(listed.code,0,listed.output);const page=JSON.parse(listed.output) as Page;
    const grantsFile=join(root,'grants.json');writeFileSync(grantsFile,JSON.stringify(scopes));
    const approved=await cli(['registration-approve','--instance',instanceId,'--id',id,'--revision',String(page.revision),'--name','测试操作员','--grants-file',grantsFile,'--yes']);
    assert.equal(approved.code,0,approved.output);assert.equal((JSON.parse(approved.output) as Decision).state,'approved');
    const wrong=await cli(['registration-reject','--instance',instanceId,'--id',id,'--revision',String(registry.status().revision),'--yes']);assert.notEqual(wrong.code,0);
    const rejected=await cli(['registration-reject','--instance',instanceId,'--id',other,'--revision',String(registry.status().revision),'--yes']);assert.equal(rejected.code,0,rejected.output);
    await assert.rejects(()=>callLocalSecurity(dir,{action:'registration.list',instanceId,role:'admin'}),{code:'SECURITY_INVALID_REQUEST'});
    assert.equal(registry.status().sessions,0);assert.equal(registry.listCredentials().length,0);
    const owner=new WindowsSecretProtector().currentIdentity();assert.equal(registry.auditEvents().find(e=>e.action==='registration.approve')!.actor.principalId,owner);
    await channel.close();channel=undefined;registry.close();registry=SecurityRegistry.open(dir);
    assert.equal(registry.readRegistrationStorage().applications.find(a=>a.id===id)!.state,'approved');
    assert.equal(registry.readRegistrationStorage().applications.find(a=>a.id===other)!.state,'rejected');
  }finally{await channel?.close();registry.close();}
});
