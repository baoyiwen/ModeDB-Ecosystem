/** Synthetic integration support. Never loads a repository configuration or runtime directory. */
import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from '../../packages/server/node_modules/fastify/fastify.js';
import { isoCBOR } from '../../packages/server/node_modules/@simplewebauthn/server/esm/helpers/index.js';
import { verifyRegistrationResponse } from '../../packages/server/node_modules/@simplewebauthn/server/esm/index.js';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';
import { RegistrationService } from '../../packages/server/src/security/registration-service.js';
import { installRegistrationRoutes } from '../../packages/server/src/security/registration-routes.js';
import { SecurityNetworkPolicy } from '../../packages/server/src/security/network-policy.js';
import { dispatchLocalSecurity } from '../../packages/server/src/security/local-management-channel.js';
import type { AtomicCommitPoint } from '../../packages/common/src/atomic-file.js';
import type { SecretProtector } from '../../packages/server/src/security/windows-secret-protector.js';
import { DEVICE_REGISTRATION_API_V1 as API, DEVICE_REGISTRATION_FORMAT as FORMAT, type DeviceRegistrationBeginResponseV1, type DeviceRegistrationConnectionDescriptorV1 } from '../../packages/shared/src/device-registration-contracts.js';

export const SID = 'S-1-5-21-100-200-300-400';
export const scopes = [{ database:'synthetic_business', resource:'*', actions:['model.read' as const] }];
export const sha = (b:string|Uint8Array) => createHash('sha256').update(b).digest();
export const utc = (n:number) => new Date(n).toISOString();
export const origin = 'https://modeldb-a.example.test';
export function syntheticProtector(key:Buffer, fail:()=>boolean=()=>false):SecretProtector {
  return {id:'integration-only-aes-gcm', ensureDirectory(p){mkdirSync(p,{recursive:true});},
    protect(bytes,purpose){if(fail())throw Error('injected protection failure');const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(purpose));return Buffer.concat([iv,c.update(bytes),c.final(),c.getAuthTag()]).toString('base64');},
    unprotect(value,purpose){const b=Buffer.from(value,'base64'),d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAAD(Buffer.from(purpose));d.setAuthTag(b.subarray(-16));return Buffer.concat([d.update(b.subarray(12,-16)),d.final()]);}};
}
export function statusInput(instanceId:string,b:DeviceRegistrationBeginResponseV1){return {format:FORMAT,version:1,instanceId,registrationId:b.registrationId,continuationSecret:b.continuationSecret};}
/** Software-generated none response, parsed by the real library; this is not browser/hardware evidence. */
export function syntheticProof(instanceId:string,b:DeviceRegistrationBeginResponseV1,flags=0x45){
  const {publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=publicKey.export({format:'jwk'});
  const cose=isoCBOR.encode(new Map<number,number|Uint8Array>([[1,2],[3,-7],[-1,1],[-2,Buffer.from(jwk.x!,'base64url')],[-3,Buffer.from(jwk.y!,'base64url')]]));
  const id=randomBytes(32),length=Buffer.alloc(2);length.writeUInt16BE(id.length);
  const authData=Buffer.concat([sha('modeldb-a.example.test'),Buffer.from([flags]),Buffer.alloc(4),Buffer.alloc(16),length,id,Buffer.from(cose)]);
  const att=isoCBOR.encode(new Map<string,unknown>([['fmt','none'],['attStmt',new Map()],['authData',authData]]) as never);
  return {...statusInput(instanceId,b),deploymentDescriptorSha256:'a'.repeat(64),challengeId:b.challengeId,credential:{id:id.toString('base64url'),rawId:id.toString('base64url'),type:'public-key',clientExtensionResults:{},response:{clientDataJSON:Buffer.from(JSON.stringify({type:'webauthn.create',challenge:b.publicKey.challenge,origin,crossOrigin:false})).toString('base64url'),attestationObject:Buffer.from(att).toString('base64url')}}};
}
export async function integrationFixture(verify=verifyRegistrationResponse,onCommitPoint?: (point: AtomicCommitPoint)=>void,protectorOverride?:SecretProtector){
  const root=mkdtempSync(join(tmpdir(),'ModeDB-Registration-Integration-')),dir=join(root,'security'),key=randomBytes(32);
  let now=Date.UTC(2026,9,27),failure=false,registry=SecurityRegistry.open(dir,{protector:protectorOverride??syntheticProtector(key,()=>failure),now:()=>now,onCommitPoint});
  const instanceId=registry.status().instanceId;
  const descriptor:DeviceRegistrationConnectionDescriptorV1={format:'modeldb.device-registration-connection.v1',version:1,instanceId,serverOrigin:origin,rpId:'modeldb-a.example.test',registrationMode:'enabled',issuedAtUtc:utc(now-1000),expiresAtUtc:utc(now+3600000),deploymentDescriptorSha256:'a'.repeat(64),tls:{mode:'public-ca',minVersion:'TLS1.2'}};
  let app:ReturnType<typeof Fastify>,service:RegistrationService;
  const start=async()=>{
    service=new RegistrationService(registry,{descriptor,allowStorageMigration:true},{publicBaseUrl:origin,mode:'proxy'},()=>now,verify);
    app=Fastify({logger:false});
    const network=new SecurityNetworkPolicy({transport:{mode:'proxy',trustedProxies:['127.0.0.1/32']},data:{allowListEnabled:false}},{host:'127.0.0.1',port:0,publicBaseUrl:origin,directory:root});
    await installRegistrationRoutes(app,service,network);
    await app.ready();
  };
  await start();
  const post=(path:string,body:unknown)=>app.inject({url:path,method:'POST',headers:{host:'modeldb-a.example.test',origin,'sec-fetch-site':'same-origin','content-type':'application/json','x-forwarded-proto':'https','x-forwarded-for':'192.0.2.10'},payload:body as object});
  const local=(r:unknown)=>registry.withLocalActor(SID,()=>dispatchLocalSecurity(registry,r));
  const decision=(id:string,action='registration.approve',revision=registry.status().revision)=>({action,instanceId,id,revision,confirm:true,...(action==='registration.approve'?{name:'Synthetic approved operator',grants:scopes}:{})});
  return {root,dir,key,instanceId,descriptor,post,local,decision,get registry(){return registry;},get service(){return service;},get now(){return now;},
    advance(ms:number){now+=ms;},fail(b:boolean){failure=b;},
    async begin(){const r=await post(API.begin,{format:FORMAT,version:1,instanceId,deploymentDescriptorSha256:'a'.repeat(64),displayName:'Synthetic integration device',userVerification:'required'});if(r.statusCode!==201)throw Error('INTEGRATION_BEGIN_FAILED:'+String(r.json().code));return r.json() as DeviceRegistrationBeginResponseV1;},
    async stop(){await app.close();registry.close();},
    async reopen(){await app.close();registry.close();failure=false;registry=SecurityRegistry.open(dir,{protector:protectorOverride??syntheticProtector(key),now:()=>now});await start();},
    async resume(){registry=SecurityRegistry.open(dir,{protector:protectorOverride??syntheticProtector(key),now:()=>now});await start();},
  };
}

/** Capacity-only trusted storage setup: unverified applications with issued challenges, no public keys. */
export function fillPendingCapacity(registry:SecurityRegistry,now:number,count:number){
  const store=registry.readRegistrationStorage(),instanceId=registry.status().instanceId;
  for(let i=0;i<count;i++){
    const id=randomUUID();
    store.applications.push({id,instanceId,serverOrigin:origin,rpId:'modeldb-a.example.test',deploymentDescriptorSha256:'a'.repeat(64),displayName:'Synthetic capacity setup',userHandle:randomBytes(32).toString('base64url'),continuationSecretHash:sha(randomBytes(32)).toString('hex'),createdAtUtc:utc(now),expiresAtUtc:utc(now+86400000),state:'pending'});
    store.challenges.push({id:randomUUID(),applicationId:id,purpose:'registration',challengeHash:sha(randomBytes(32)).toString('hex'),state:'issued',createdAtUtc:utc(now),expiresAtUtc:utc(now+60000)});
  }
  registry.commitRegistrationStorage(registry.status().revision,store);
}
