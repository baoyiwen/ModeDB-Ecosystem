/** Real software signatures and a synthetic isolated registry; never reads production material. */
import type { AtomicCommitPoint } from '../../packages/common/src/atomic-file.js';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import Fastify from '../../packages/server/node_modules/fastify/fastify.js';
import { isoCBOR } from '../../packages/server/node_modules/@simplewebauthn/server/esm/helpers/index.js';
import { AuthenticationService } from '../../packages/server/src/security/authentication-service.js';
import { installAuthenticationRoutes } from '../../packages/server/src/security/authentication-routes.js';
import { installRegistryEntrypoints } from '../../packages/server/src/security/registry-entrypoints.js';
import { SecurityNetworkPolicy } from '../../packages/server/src/security/network-policy.js';
import { WriteSerializationGate } from '../../packages/server/src/write-serialization-gate.js';
import { DEVICE_AUTHENTICATION_FORMAT as FORMAT, type DeviceAuthenticationBeginResponseV1 } from '../../packages/shared/src/device-authentication-contracts.js';
import { integrationFixture, statusInput, sha, origin } from './security-registration-integration.js';
import { DEVICE_REGISTRATION_API_V1 as REG } from '../../packages/shared/src/device-registration-contracts.js';
import type { SecurityGrant } from '@mode-db/shared';
import type { SecretProtector } from '../../packages/server/src/security/windows-secret-protector.js';

export async function authenticationFixture(algorithm: -7 | -257 = -7, multiDevice = false, onCommitPoint?: (point: AtomicCommitPoint)=>void, approvalGrants?: readonly SecurityGrant[], protectorOverride?:SecretProtector) {
  const f = await integrationFixture(undefined,onCommitPoint,protectorOverride);
  const pair = algorithm === -7 ? generateKeyPairSync('ec',{namedCurve:'prime256v1'}) : generateKeyPairSync('rsa',{modulusLength:2048});
  const jwk = pair.publicKey.export({format:'jwk'});
  const cose = isoCBOR.encode(algorithm === -7 ? new Map<number, number|Uint8Array>([[1,2],[3,-7],[-1,1],[-2,Buffer.from(jwk.x!,'base64url')],[-3,Buffer.from(jwk.y!,'base64url')]]) : new Map<number, number|Uint8Array>([[1,3],[3,-257],[-1,Buffer.from(jwk.n!,'base64url')],[-2,Buffer.from(jwk.e!,'base64url')]]));
  const raw = randomBytes(32), rawId = raw.toString('base64url'), reg = await f.begin(), length = Buffer.alloc(2); length.writeUInt16BE(raw.length);
  const flags = multiDevice ? 0x5d : 0x45;
  const authData = Buffer.concat([sha('modeldb-a.example.test'),Buffer.from([flags]),Buffer.alloc(4),Buffer.alloc(16),length,raw,Buffer.from(cose)]);
  const att = isoCBOR.encode(new Map<string,unknown>([['fmt','none'],['attStmt',new Map()],['authData',authData]]) as never);
  const complete = {...statusInput(f.instanceId,reg),deploymentDescriptorSha256:'a'.repeat(64),challengeId:reg.challengeId,credential:{id:rawId,rawId,type:'public-key',clientExtensionResults:{},response:{clientDataJSON:Buffer.from(JSON.stringify({type:'webauthn.create',challenge:reg.publicKey.challenge,origin,crossOrigin:false})).toString('base64url'),attestationObject:Buffer.from(att).toString('base64url')}}};
  const submitted = await f.post(REG.complete,complete);
  if (submitted.statusCode !== 202) { throw Error('SYNTHETIC_ENROLLMENT_FAILED'); }
  f.local({...f.decision(reg.registrationId),...(approvalGrants ? {grants:approvalGrants} : {})});
  const binding = {format:FORMAT,version:1 as const,instanceId:f.instanceId,deploymentDescriptorSha256:'a'.repeat(64)};
  const context = {source:{peerIp:'127.0.0.1',clientIp:'192.0.2.10',clientIpBasis:'trusted-proxy' as const,secure:true},requestId:'synthetic-authentication',recheck:()=>{}};
  let service = new AuthenticationService(f.registry,{enabled:true,allowStorageMigration:true},f.descriptor,()=>f.now);
  let app:ReturnType<typeof Fastify>;
  const start = async () => {
    app = Fastify({logger:false});
    const network = new SecurityNetworkPolicy({transport:{mode:'proxy',trustedProxies:['127.0.0.1/32']},data:{allowListEnabled:false}},{host:'127.0.0.1',port:0,publicBaseUrl:origin,directory:f.root});
    network.setPairedOriginVerifier(o=>f.registry.allowsBrowserOrigin(o));
    await installAuthenticationRoutes(app,service,network,f.registry);
    installRegistryEntrypoints({app,registry:f.registry,network,dispatcher:{} as never,designerWorkspace:f.root,workspace:f.root,writeGate:new WriteSerializationGate(),getEngine:async()=>{throw Error('UNUSED_SYNTHETIC_ENGINE');},listDatabases:()=>[],catalog:async()=>{throw Error('UNUSED_SYNTHETIC_CATALOG');}});
    await app.ready();
  };
  await start();
  const assertion = (b:DeviceAuthenticationBeginResponseV1, counter = 1, edit: (client: Record<string,unknown>)=>void = ()=>{}, overrideFlags = multiDevice ? 0x1d : 0x05) => {
    const client:Record<string,unknown> = {type:'webauthn.get',challenge:b.publicKey.challenge,origin,crossOrigin:false}; edit(client);
    const data = Buffer.from(JSON.stringify(client)), count = Buffer.alloc(4);count.writeUInt32BE(counter);
    const auth = Buffer.concat([sha('modeldb-a.example.test'),Buffer.from([overrideFlags]),count]);
    return {...binding,challengeId:b.challengeId,credential:{id:rawId,rawId,type:'public-key' as const,clientExtensionResults:{},response:{clientDataJSON:data.toString('base64url'),authenticatorData:auth.toString('base64url'),signature:sign('sha256',Buffer.concat([auth,sha(data)]),pair.privateKey).toString('base64url'),userHandle:reg.publicKey.user.id as string|null}}};
  };
  return {f,binding,context,rawId,assertion,get service(){return service;},get app(){return app;},
    begin:(hint = false)=>service.begin({...binding,...(hint?{rawId}:{})},context),
    async reopen(){await app.close();await f.reopen();service=new AuthenticationService(f.registry,{enabled:true},f.descriptor,()=>f.now);await start();},
    async close(){await app.close();await f.stop();},
  };
}
