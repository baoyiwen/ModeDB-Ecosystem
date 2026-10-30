import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { fileURLToPath } from 'node:url';
import Fastify from '../../packages/server/node_modules/fastify/fastify.js';
import { isoCBOR } from '../../packages/server/node_modules/@simplewebauthn/server/esm/helpers/index.js';
import { verifyRegistrationResponse } from '../../packages/server/node_modules/@simplewebauthn/server/esm/index.js';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';
import { RegistrationService, type RegistrationConfig } from '../../packages/server/src/security/registration-service.js';
import { installRegistrationRoutes } from '../../packages/server/src/security/registration-routes.js';
import { SecurityNetworkPolicy } from '../../packages/server/src/security/network-policy.js';
import { installSecurityNetworkBoundary } from '../../packages/server/src/security/network-boundary.js';
import { type SecretProtector } from '../../packages/server/src/security/windows-secret-protector.js';
import { ensureModelDbLayoutAtRoot } from '../../packages/server/src/modeldb-default-home.js';
import { loadModelDBServerConfig } from '../../packages/server/src/config-loader.js';
import { buildDualTrackFastify } from '../../packages/server/src/dual-track-app.js';
import { DEVICE_REGISTRATION_API_V1 as API, DEVICE_REGISTRATION_FORMAT as FORMAT,
  assertDeviceRegistrationBeginResponse, assertDeviceRegistrationStatusResponse,
  type DeviceRegistrationBeginResponseV1, type DeviceRegistrationConnectionDescriptorV1 } from '../../packages/shared/src/device-registration-contracts.js';

const origin = 'https://modeldb-a.example.test';
const rpId = 'modeldb-a.example.test';
const start = Date.UTC(2026,9,27);
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest();
const utc = (ms: number) => new Date(ms).toISOString();

function fixture(verify?: typeof verifyRegistrationResponse, auditLimit?: number) {
  const root=mkdtempSync(join(tmpdir(),'ModeDB-Registration-Runtime-')), dir=join(root,'security'), key=randomBytes(32);
  let now=start, broken=false, brokenCandidate=false;
  const protector: SecretProtector={id:'synthetic-aes-gcm',ensureDirectory(p){mkdirSync(p,{recursive:true});},
    protect(bytes,purpose){if(broken || (brokenCandidate && JSON.parse(Buffer.from(bytes).toString()).registration?.applications.some((a:{candidate?:unknown})=>a.candidate)))throw new Error('injected ENOSPC');const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(purpose));const out=Buffer.concat([c.update(bytes),c.final()]);return Buffer.concat([iv,c.getAuthTag(),out]).toString('base64');},
    unprotect(value,purpose){const b=Buffer.from(value,'base64'),c=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAuthTag(b.subarray(12,28));c.setAAD(Buffer.from(purpose));return Buffer.concat([c.update(b.subarray(28)),c.final()]);}};
  let registry=SecurityRegistry.open(dir,{protector,now:()=>now,auditLimit});
  const descriptor: DeviceRegistrationConnectionDescriptorV1={format:'modeldb.device-registration-connection.v1',version:1,instanceId:registry.status().instanceId,
    serverOrigin:origin,rpId,registrationMode:'enabled',issuedAtUtc:utc(start),expiresAtUtc:utc(start+86400000),deploymentDescriptorSha256:'a'.repeat(64),tls:{mode:'public-ca',minVersion:'TLS1.2'}};
  let service: RegistrationService | undefined;
  const context={source:{peerIp:'127.0.0.1',clientIp:'192.0.2.10',clientIpBasis:'socket' as const,secure:true},requestId:randomUUID(),recheck() {}};
  const enable=(config: RegistrationConfig={descriptor,allowStorageMigration:true})=>service=new RegistrationService(registry,config,{publicBaseUrl:origin,mode:'proxy'},()=>now,verify);
  return {root,dir,descriptor,context,enable,protector,
    get registry(){return registry;}, get service(){return service!;}, setTime(n:number){now=n;}, get now(){return now;}, setFailure(b:boolean){broken=b;},
    setCandidateFailure(b:boolean){brokenCandidate=b;},
    reopen(){service?.close();registry.close();registry=SecurityRegistry.open(dir,{protector,now:()=>now});return enable();},
    close(){service?.close();registry.close();}};
}
const beginInput=(f: ReturnType<typeof fixture>)=>({format:FORMAT,version:1,instanceId:f.descriptor.instanceId,deploymentDescriptorSha256:'a'.repeat(64),displayName:'Synthetic B',userVerification:'required'});
const statusInput=(f: {descriptor:DeviceRegistrationConnectionDescriptorV1},b:DeviceRegistrationBeginResponseV1)=>({format:FORMAT,version:1,instanceId:f.descriptor.instanceId,registrationId:b.registrationId,continuationSecret:b.continuationSecret});
/** Synthetic authenticator attestation=none. The real library parses CBOR/COSE and enforces RP/UP/UV. */
function proof(f: {descriptor:DeviceRegistrationConnectionDescriptorV1},b:DeviceRegistrationBeginResponseV1,opts:{origin?:string;rp?:string;flags?:number;id?:Buffer;challenge?:string;fmt?:string}={}) {
  const {publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=publicKey.export({format:'jwk'});
  const cose=isoCBOR.encode(new Map<number,number|Uint8Array>([[1,2],[3,-7],[-1,1],[-2,Buffer.from(jwk.x!,'base64url')],[-3,Buffer.from(jwk.y!,'base64url')]]));
  const id=opts.id??randomBytes(32),len=Buffer.alloc(2);len.writeUInt16BE(id.length);
  const authData=Buffer.concat([hash(opts.rp??rpId),Buffer.from([opts.flags??0x45]),Buffer.alloc(4),Buffer.alloc(16),len,id,Buffer.from(cose)]);
  const att=isoCBOR.encode(new Map<string,unknown>([['fmt',opts.fmt??'none'],['attStmt',new Map()],['authData',authData]]) as never);
  const clientData=Buffer.from(JSON.stringify({type:'webauthn.create',challenge:opts.challenge??b.publicKey.challenge,origin:opts.origin??origin,crossOrigin:false}));
  return {...statusInput(f,b),deploymentDescriptorSha256:'a'.repeat(64),challengeId:b.challengeId,
    credential:{id:id.toString('base64url'),rawId:id.toString('base64url'),type:'public-key',clientExtensionResults:{},response:{clientDataJSON:clientData.toString('base64url'),attestationObject:Buffer.from(att).toString('base64url')}}};
}

test('omitted/disabled configuration leaves V1 unchanged; enabled requires exact binding, valid window and explicit migration',()=>{
  const f=fixture();try{
    const s=new RegistrationService(f.registry);assert.equal(s.capabilities().mode,'disabled');s.close();
    const rev=f.registry.status().revision;
    for(const config of [{descriptor:f.descriptor},{descriptor:{...f.descriptor,instanceId:randomUUID()},allowStorageMigration:true},
      {descriptor:{...f.descriptor,issuedAtUtc:utc(start+1000)},allowStorageMigration:true},
      {descriptor:{...f.descriptor,rpId:'other.example.test'},allowStorageMigration:true}]) assert.throws(()=>f.enable(config));
    assert.equal(f.registry.status().revision,rev);assert.equal(f.registry.registrationStorageStatus().ledgerVersion,1);
    const disabled=f.enable({descriptor:{...f.descriptor,registrationMode:'disabled'}});assert.equal(disabled.capabilities().mode,'disabled');disabled.close();
    f.enable();assert.equal(f.registry.registrationStorageStatus().mode,'enabled');assert.equal(f.registry.registrationStorageStatus().ledgerVersion,2);
  }finally{f.close();}
});

test('begin persists independent secret/challenge digests and no session or grant; public schemas and projection remain valid',async()=>{
  const f=fixture();try{f.enable();const b=await f.service.begin(beginInput(f),f.context);assertDeviceRegistrationBeginResponse(b);
    const store=f.registry.readRegistrationStorage();assert.equal(store.applications.length,1);assert.notEqual(b.continuationSecret,b.publicKey.challenge);
    assert.equal(store.applications[0]!.continuationSecretHash,hash(Buffer.from(b.continuationSecret,'base64url')).toString('hex'));
    const publicAudit=JSON.stringify(f.registry.auditEvents());assert.equal(publicAudit.includes(b.continuationSecret),false);assert.equal(publicAudit.includes(b.publicKey.challenge),false);
    const st=f.service.status(statusInput(f,b),f.context);assertDeviceRegistrationStatusResponse(st);assert.equal(st.state,'pending');
    assert.equal(f.registry.status().sessions,0);assert.equal(f.registry.listCredentials().length,0);
  }finally{f.close();}
});

test('expired configured windows start disabled without migrating V1 and preserve proof-verified applications for private polling',async()=>{
  const f=fixture();try{
    const old={...f.descriptor,issuedAtUtc:utc(start-86400000),expiresAtUtc:utc(start-1)};
    f.enable({descriptor:old});assert.equal(f.service.capabilities().mode,'disabled');assert.equal(f.registry.registrationStorageStatus().ledgerVersion,1);f.service.close();
    f.enable({descriptor:{...f.descriptor,expiresAtUtc:utc(start+60000)},allowStorageMigration:true});
    const b=await f.service.begin(beginInput(f),f.context);await f.service.complete(proof(f,b),f.context);
    f.setTime(start+60001);assert.equal(f.service.capabilities().mode,'disabled');assert.equal(f.service.status(statusInput(f,b),f.context).state,'pending');
    assert.ok(f.registry.readRegistrationStorage().applications[0]!.candidate);
  }finally{f.close();}
});

test('direct TLS registration rejects a missing certificate, wrong certificate host and wrong owner pin before migration',()=>{
  const f=fixture();try{
    const cert=readFileSync(fileURLToPath(new URL('../fixtures/security-registration-tls/modeldb-a.crt',import.meta.url)));
    for(const [descriptor,certificate] of [[f.descriptor,undefined],[{...f.descriptor,serverOrigin:'https://other.example.test',rpId:'other.example.test'},cert],
      [{...f.descriptor,tls:{mode:'owner-pinned',minVersion:'TLS1.2',spkiSha256:'b'.repeat(64)}},cert]] as const){
      assert.throws(()=>new RegistrationService(f.registry,{descriptor:descriptor as DeviceRegistrationConnectionDescriptorV1,allowStorageMigration:true},
        {mode:'tls',publicBaseUrl:descriptor.serverOrigin,certificate},()=>start),{code:'SECURITY_INVALID_CONFIG'});
    }
    assert.equal(f.registry.registrationStorageStatus().ledgerVersion,1);
  }finally{f.close();}
});

test('the actual pinned WebAuthn library validates a synthetic none attestation; only a pending candidate is persisted',async()=>{
  const f=fixture();try{f.enable();const b=await f.service.begin(beginInput(f),f.context);const input=proof(f,b);
    const st=await f.service.complete(input,f.context);assert.equal(st.state,'pending');assertDeviceRegistrationStatusResponse(st);
    const store=f.registry.readRegistrationStorage();assert.equal(store.challenges[0]!.state,'consumed');assert.equal(store.applications[0]!.candidate?.rawId,input.credential.rawId);
    assert.equal(store.credentials.length,0);assert.equal(store.users.length,0);assert.equal(f.registry.status().sessions,0);
    const log=JSON.stringify(f.registry.auditEvents());assert.equal(log.includes(input.credential.response.attestationObject),false);assert.equal(log.includes(b.continuationSecret),false);
    f.reopen();assert.equal(f.registry.readRegistrationStorage().applications[0]!.candidate?.rawId,input.credential.rawId);
  }finally{f.close();}
});

for(const [name,opts] of Object.entries({origin:{origin:'https://evil.example.test'},rp:{rp:'evil.example.test'},uv:{flags:0x41},up:{flags:0x44},challenge:{challenge:randomBytes(32).toString('base64url')},fmt:{fmt:'packed'}})) {
  test('proof '+name+' substitution is rejected by the library/admission and consumes the challenge',async()=>{
    const f=fixture();try{f.enable();const b=await f.service.begin(beginInput(f),f.context);
      await assert.rejects(()=>f.service.complete(proof(f,b,opts),f.context),{code:'SECURITY_REGISTRATION_PROOF_INVALID'});
      const store=f.registry.readRegistrationStorage();assert.equal(store.challenges[0]!.state,'consumed');assert.equal(store.applications[0]!.state,'rejected');assert.equal(store.applications[0]!.candidate,undefined);
      await assert.rejects(()=>f.service.complete(proof(f,b),f.context),{code:'SECURITY_REGISTRATION_CHALLENGE_REPLAYED'});
    }finally{f.close();}
  });
}

test('parallel complete requests verify at most once and a restart never resurrects a claimed challenge',async()=>{
  let calls=0, finish!:()=>void;
  const gate=new Promise<void>(r=>finish=r);
  const f=fixture(async options=>{calls++;await gate;return verifyRegistrationResponse(options);});
  try{f.enable();const b=await f.service.begin(beginInput(f),f.context),input=proof(f,b);
    const a=f.service.complete(input,f.context);await new Promise(r=>setImmediate(r));
    await assert.rejects(()=>f.service.complete(input,f.context),{code:'SECURITY_REGISTRATION_CHALLENGE_REPLAYED'});
    finish();assert.equal((await a).state,'pending');assert.equal(calls,1);
    const b2=await f.service.begin(beginInput(f),f.context),store=f.registry.readRegistrationStorage();
    const challenge=store.challenges.find(c=>c.id===b2.challengeId)!;challenge.state='consumed';challenge.finishedAtUtc=utc(f.now);
    f.registry.commitRegistrationStorage(f.registry.status().revision,store);
    f.reopen();assert.equal(f.registry.readRegistrationStorage().applications.find(a=>a.id===b2.registrationId)!.state,'rejected');
  }finally{finish();f.close();}
});

test('status secret/instance/ID mismatches return the same NOT_FOUND; poll interval is per valid application',async()=>{
  const f=fixture();try{f.enable();const b=await f.service.begin(beginInput(f),f.context),req=statusInput(f,b);
    for(const change of [{continuationSecret:randomBytes(32).toString('base64url')},{instanceId:randomUUID()},{registrationId:randomUUID()}])assert.throws(()=>f.service.status({...req,...change},f.context),{code:'SECURITY_REGISTRATION_NOT_FOUND'});
    assert.equal(f.service.status(req,f.context).state,'pending');assert.throws(()=>f.service.status(req,f.context),{code:'SECURITY_REGISTRATION_RATE_LIMITED'});
    f.setTime(start+5000);assert.equal(f.service.status(req,f.context).state,'pending');
  }finally{f.close();}
});

test('elapsed challenge/application storage is reclaimed and expired windows refuse new admission without deleting registered data',async()=>{
  const f=fixture();try{f.enable();const b=await f.service.begin(beginInput(f),f.context);
    f.setTime(start+60000);f.service.expire(f.context);const store=f.registry.readRegistrationStorage();assert.equal(store.challenges.length,0);assert.equal(store.applications[0]!.state,'rejected');
    f.setTime(start+86400000);f.service.expire(f.context);assert.equal(f.registry.readRegistrationStorage().applications.length,0);
    await assert.rejects(()=>f.service.begin(beginInput(f),f.context),{code:'SECURITY_REGISTRATION_DISABLED'});
    assert.throws(()=>f.service.connection(),{code:'SECURITY_REGISTRATION_EXPIRED'});assert.equal(f.service.capabilities().mode,'disabled');
    assert.throws(()=>f.service.status(statusInput(f,b),f.context),{code:'SECURITY_REGISTRATION_NOT_FOUND'});
  }finally{f.close();}
});

test('begin collects elapsed completed challenges and records both audits in one durable transaction',async()=>{
  const f=fixture();try{
    f.enable();const first=await f.service.begin(beginInput(f),f.context);
    await f.service.complete(proof(f,first),f.context);
    f.setTime(start+61000);
    const revision=f.registry.status().revision, events=f.registry.auditEvents().length;
    const second=await f.service.begin(beginInput(f),f.context);
    assert.equal(f.registry.status().revision,revision+1);
    const store=f.registry.readRegistrationStorage();
    assert.equal(store.applications.find(a=>a.id===first.registrationId)!.state,'pending');
    assert.ok(store.applications.find(a=>a.id===first.registrationId)!.candidate);
    assert.deepEqual(store.challenges.map(c=>c.id),[second.challengeId]);
    assert.deepEqual(f.registry.auditEvents().slice(events).map(e=>e.action),['registration.expire','registration.begin']);
  }finally{f.close();}
});

test('background sweep persists abandoned admission but defers already completed garbage until a public transaction',async(t)=>{
  t.mock.timers.enable({apis:['setInterval']});
  const f=fixture();try{
    f.enable();const first=await f.service.begin(beginInput(f),f.context);
    await f.service.complete(proof(f,first),f.context);
    f.setTime(start+61000);const revision=f.registry.status().revision;
    t.mock.timers.tick(30000);
    assert.equal(f.registry.status().revision,revision);
    const second=await f.service.begin(beginInput(f),f.context);
    f.setTime(start+122000);t.mock.timers.tick(30000);
    const store=f.registry.readRegistrationStorage();
    assert.equal(store.applications.find(a=>a.id===second.registrationId)!.state,'rejected');
    assert.equal(store.challenges.length,0);
    assert.equal(f.registry.status().revision,revision+2);
  }finally{f.close();t.mock.timers.reset();}
});

test('merged garbage collection and begin fail closed without publishing either audit or partial state',async()=>{
  const f=fixture();try{
    f.enable();const first=await f.service.begin(beginInput(f),f.context);
    await f.service.complete(proof(f,first),f.context);
    const before=readFileSync(join(f.dir,'registry.mds'));
    f.setTime(start+61000);f.setFailure(true);
    await assert.rejects(()=>f.service.begin(beginInput(f),f.context),{code:'SECURITY_STORE_WRITE_FAILED'});
    assert.deepEqual(readFileSync(join(f.dir,'registry.mds')),before);
    assert.throws(()=>f.registry.readRegistrationStorage(),{code:'SECURITY_CLOSED'});
  }finally{f.close();}
});

test('merged begin reserves capacity for both audit records and refuses a one-slot ledger atomically',async()=>{
  const f=fixture(undefined,20);try{
    f.enable();const first=await f.service.begin(beginInput(f),f.context);
    await f.service.complete(proof(f,first),f.context);
    while(f.registry.auditEvents().length<19)f.registry.recordSecurityEvent({version:1,eventId:randomUUID(),timestampUtc:utc(f.now),category:'authentication',action:'synthetic.capacity',result:'succeeded',actor:{identityTrust:'unverified'},source:{transport:'http'},policyVersion:f.registry.status().policyVersion});
    const before=readFileSync(join(f.dir,'registry.mds')), revision=f.registry.status().revision;
    f.setTime(start+61000);
    await assert.rejects(()=>f.service.begin(beginInput(f),f.context),{code:'SECURITY_AUDIT_CAPACITY'});
    assert.equal(f.registry.status().revision,revision);
    assert.equal(f.registry.auditEvents().length,19);
    assert.deepEqual(readFileSync(join(f.dir,'registry.mds')),before);
  }finally{f.close();}
});

test('reset/window/source changes during asynchronous proof verification fail closed without a candidate',async()=>{
  for(const kind of ['reset','close','source','timeout']) {
    let finish!:()=>void;const gate=new Promise<void>(r=>finish=r);const f=fixture(async opts=>{await gate;return verifyRegistrationResponse(opts);});
    try{f.enable();const b=await f.service.begin(beginInput(f),f.context);let checks=0;
      const context={...f.context,recheck(){if(kind==='source' && ++checks>1)throw new Error('source was revoked');}};
      const attempt=f.service.complete(proof(f,b),context);await new Promise(r=>setImmediate(r));
      if(kind==='reset')f.registry.resetAccess();if(kind==='close')f.service.close();if(kind==='timeout')f.setTime(start+60001);
      finish();await assert.rejects(attempt);assert.equal(f.registry.readRegistrationStorage().applications[0]!.candidate,undefined);
      assert.equal(f.registry.status().sessions,0);
    }finally{finish();f.close();}
  }
});

test('duplicate raw credential IDs cannot become two pending candidates',async()=>{
  const f=fixture();try{f.enable();const raw=randomBytes(32),a=await f.service.begin(beginInput(f),f.context),b=await f.service.begin(beginInput(f),f.context);
    await f.service.complete(proof(f,a,{id:raw}),f.context);await assert.rejects(()=>f.service.complete(proof(f,b,{id:raw}),f.context),{code:'SECURITY_REGISTRATION_PROOF_INVALID'});
    assert.equal(f.registry.readRegistrationStorage().applications.filter(a=>a.candidate).length,1);
  }finally{f.close();}
});

test('source and global budgets are bounded, shared descriptor budget is enforced and successful reads are sampled',()=>{
  const f=fixture();try{f.enable();
    for(let i=0;i<5;i++)f.service.admit('begin',f.context.source);
    assert.throws(()=>f.service.admit('begin',f.context.source),{code:'SECURITY_REGISTRATION_RATE_LIMITED'});
    f.setTime(start+60000);
    for(let i=0;i<300;i++)f.service.admit(i%2?'capabilities':'descriptor',{...f.context.source,clientIp:'192.0.2.'+(i%20)});
    assert.throws(()=>f.service.admit('descriptor',{...f.context.source,clientIp:'203.0.113.1'}),{code:'SECURITY_REGISTRATION_RATE_LIMITED'});
    for(let i=0;i<100;i++)f.service.observe('capabilities',f.context);
    assert.deepEqual({...f.service.metrics(),budgetRows:0},{activeProofs:0,queuedProofs:0,budgetRows:0,observed:100,saved:1,suppressed:99});
  }finally{f.close();}
});

test('bounded proof queue refuses overflow and leaves a local registry operation available',async()=>{
  let finish!:()=>void;const gate=new Promise<void>(r=>finish=r),f=fixture(async opts=>{await gate;return verifyRegistrationResponse(opts);});
  try{f.enable();
    const inputs=[];for(let i=0;i<37;i++){const b=await f.service.begin(beginInput(f),f.context);inputs.push(proof(f,b));}
    const work=inputs.map(input=>f.service.complete(input,f.context).then(()=>true,()=>false));
    await new Promise(r=>setImmediate(r));assert.equal(f.service.metrics().activeProofs,4);assert.equal(f.service.metrics().queuedProofs,32);
    assert.ok(f.registry.createPrincipal('Synthetic local repair','operator').id);
    finish();const results=await Promise.all(work);assert.equal(results.filter(Boolean).length,36);assert.equal(f.service.metrics().activeProofs,0);
  }finally{finish();f.close();}
});

test('storage/protection failure never returns begin success or invents an empty registry',async()=>{
  const f=fixture();try{f.enable();const before=readFileSync(join(f.dir,'registry.mds'));f.setFailure(true);
    await assert.rejects(()=>f.service.begin(beginInput(f),f.context),{code:'SECURITY_STORE_WRITE_FAILED'});
    assert.deepEqual(readFileSync(join(f.dir,'registry.mds')),before);f.setFailure(false);f.reopen();assert.equal(f.registry.readRegistrationStorage().applications.length,0);
  }finally{f.close();}
});

test('final candidate persistence failure preserves a consumed challenge; restart rejects the abandoned attempt',async()=>{
  const f=fixture();try{f.enable();const b=await f.service.begin(beginInput(f),f.context);f.setCandidateFailure(true);
    await assert.rejects(()=>f.service.complete(proof(f,b),f.context));f.setCandidateFailure(false);f.reopen();
    const store=f.registry.readRegistrationStorage();assert.equal(store.challenges[0]!.state,'consumed');assert.equal(store.applications[0]!.state,'rejected');assert.equal(store.applications[0]!.candidate,undefined);
  }finally{f.close();}
});

test('HTTP routes enforce same-origin/Host/Fetch Metadata before parsing, omit CORS/cookies, bound bodies and never authenticate a registration',async()=>{
  const f=fixture(),app=Fastify({logger:false});
  try{f.enable();const network=new SecurityNetworkPolicy({transport:{mode:'proxy',trustedProxies:['127.0.0.1/32']},data:{allowListEnabled:false}},
      {host:'127.0.0.1',port:0,publicBaseUrl:origin,directory:f.root});
    installSecurityNetworkBoundary(app,network);await installRegistrationRoutes(app,f.service,network);
    const headers={host:rpId,origin,'sec-fetch-site':'same-origin','content-type':'application/json','x-forwarded-proto':'https','x-forwarded-for':'192.0.2.11'};
    const capabilities=await app.inject({url:API.capabilities,headers});assert.equal(capabilities.statusCode,200);assert.equal(capabilities.json().mode,'enabled');
    const download=await app.inject({url:API.descriptor,headers});assert.equal(download.statusCode,200);assert.match(download.headers['content-disposition']!,/attachment/);assert.equal(download.headers['set-cookie'],undefined);assert.equal(download.headers['access-control-allow-origin'],undefined);assert.equal(download.headers['cache-control'],'no-store');
    const before=f.registry.readRegistrationStorage().applications.length;
    for(const change of [{origin:'https://evil.example.test'},{host:'evil.example.test'},{'sec-fetch-site':'cross-site'},{'x-forwarded-proto':'http'}]) {
      const r=await app.inject({url:API.begin,method:'POST',headers:{...headers,...change},payload:'{broken'});assert.equal(r.statusCode,403);assert.ok(r.json().code.startsWith('SECURITY_REGISTRATION_'));assert.equal(r.headers['access-control-allow-origin'],undefined);
    }
    assert.equal(f.registry.readRegistrationStorage().applications.length,before);
    f.setTime(start+60000);
    const preflight=await app.inject({url:API.begin,method:'OPTIONS',headers});assert.equal(preflight.headers['access-control-allow-origin'],undefined);assert.notEqual(preflight.statusCode,200);
    const urlSecret=await app.inject({url:API.status+'?continuationSecret=synthetic',method:'POST',headers,payload:{}});assert.equal(urlSecret.statusCode,400);
    const huge=await app.inject({url:API.begin,method:'POST',headers,payload:JSON.stringify({text:'x'.repeat(131072)})});assert.equal(huge.statusCode,400);
    const begin=await app.inject({url:API.begin,method:'POST',headers,payload:beginInput(f)});assert.equal(begin.statusCode,201);const b=begin.json();
    const completed=await app.inject({url:API.complete,method:'POST',headers,payload:proof(f,b)});assert.equal(completed.statusCode,202);assert.equal(completed.json().state,'pending');assert.equal(completed.headers['set-cookie'],undefined);
    assert.equal(f.registry.listCredentials().length,0);assert.equal(f.registry.status().sessions,0);
  }finally{await app.close();f.close();}
});

test('native Windows DPAPI Server exposes disabled-by-default discovery, then isolated HTTPS registration without CORS or business access', {timeout:180000}, async()=>{
  assert.equal(process.platform,'win32');
  const root=mkdtempSync(join(tmpdir(),'ModeDB-Registration-Native-'));
  const config=ensureModelDbLayoutAtRoot(root), cfg=await loadModelDBServerConfig(config,{port:0});
  let app: Awaited<ReturnType<typeof buildDualTrackFastify>> | undefined;
  try{
    app=await buildDualTrackFastify(cfg);
    const cap=await app.inject({url:API.capabilities});assert.equal(cap.statusCode,200);assert.equal(cap.json().mode,'disabled');
    const instanceId=cap.json().instanceId;
    assert.equal((await app.inject({url:API.begin,method:'POST',payload:{}})).statusCode,403);
    await app.close();app=undefined;
    const registry=SecurityRegistry.open(join(root,'security'));assert.equal(registry.registrationStorageStatus().ledgerVersion,1);registry.close();
    const now=Date.now(), descriptor:DeviceRegistrationConnectionDescriptorV1={format:'modeldb.device-registration-connection.v1',version:1,instanceId,serverOrigin:origin,rpId,
      registrationMode:'enabled',issuedAtUtc:utc(now-1000),expiresAtUtc:utc(now+3600000),deploymentDescriptorSha256:'a'.repeat(64),tls:{mode:'owner-pinned',minVersion:'TLS1.2',spkiSha256:hash(new X509Certificate(readFileSync(fileURLToPath(new URL('../fixtures/security-registration-tls/modeldb-a.crt',import.meta.url)))).publicKey.export({type:'spki',format:'der'})).toString('hex')}};
    const tlsRoot=fileURLToPath(new URL('../fixtures/security-registration-tls/',import.meta.url));
    app=await buildDualTrackFastify({...cfg,publicBaseUrl:origin,securityNetwork:{transport:{mode:'tls',certificateFile:join(tlsRoot,'modeldb-a.crt'),privateKeyFile:join(tlsRoot,'modeldb-a.key')}},securityRegistration:{descriptor,allowStorageMigration:true}});
    const address=app.server.address();assert.ok(address&&typeof address!=='string');
    const send=(path:string,method='GET',payload?:unknown,overrides:Record<string,string>={})=>new Promise<{status:number;headers:import('node:http').IncomingHttpHeaders;body:Record<string,unknown>}>((resolve,reject)=>{
      const bytes=payload===undefined?undefined:JSON.stringify(payload);
      const req=httpsRequest({hostname:rpId,port:address.port,path,method,family:4,ca:readFileSync(join(tlsRoot,'modeldb-a.crt')),
        lookup:(_host,_options,cb)=>cb(null,'127.0.0.1',4),headers:{host:rpId,origin,'sec-fetch-site':'same-origin',...(bytes?{'content-type':'application/json','content-length':String(Buffer.byteLength(bytes))}:{}),...overrides}},res=>{
          let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,body:JSON.parse(body)}));});req.on('error',reject);if(bytes)req.write(bytes);req.end();
    });
    const downloaded=await send(API.descriptor);assert.equal(downloaded.status,200);assert.equal(downloaded.headers['access-control-allow-origin'],undefined);
    const bad=await send(API.begin,'POST',{},{origin:'https://evil.example.test'});assert.equal(bad.status,403);assert.equal(bad.headers['access-control-allow-origin'],undefined);
    const r=await send(API.begin,'POST',{format:FORMAT,version:1,instanceId,deploymentDescriptorSha256:'a'.repeat(64),displayName:'Synthetic native B',userVerification:'required'});
    assert.equal(r.status,201);assertDeviceRegistrationBeginResponse(r.body);assert.equal(r.headers['set-cookie'],undefined);
    const complete=await send(API.complete,'POST',proof({descriptor},r.body));assert.equal(complete.status,202);assert.equal(complete.body.state,'pending');assert.equal(complete.headers['set-cookie'],undefined);
    const rpc=await send('/api/v1/rpc','POST',{atlas:'synthetic',body:{op:'executeQuery',snapshot:{}}});assert.equal(rpc.status,401);
    const ws=await send('/v2/ws');assert.notEqual(ws.status,200);
  }finally{await app?.close();}
});
