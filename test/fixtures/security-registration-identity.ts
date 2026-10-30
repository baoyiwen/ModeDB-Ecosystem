/** A fresh software public key and real none/get proofs for an existing isolated test instance. */
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '../../packages/server/node_modules/@simplewebauthn/server/esm/helpers/index.js';
import { DEVICE_REGISTRATION_API_V1 as REG } from '../../packages/shared/src/device-registration-contracts.js';
import type { DeviceAuthenticationBeginResponseV1 } from '../../packages/shared/src/device-authentication-contracts.js';
import type { authenticationFixture } from './security-authentication.js';
import { statusInput, sha, origin } from './security-registration-integration.js';

export async function pendingSoftwareIdentity(a: Awaited<ReturnType<typeof authenticationFixture>>, untrustedCandidate?: { publicKeyCose: string; reencode?: boolean }) {
  const {f}=a, pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=pair.publicKey.export({format:'jwk'});
  // none registration does not prove possession; exercise re-use of a declared old public key too.
  let cose=untrustedCandidate ? Buffer.from(untrustedCandidate.publicKeyCose,'base64url') : isoCBOR.encode(new Map<number,number|Uint8Array>([[1,2],[3,-7],[-1,1],[-2,Buffer.from(jwk.x!,'base64url')],[-3,Buffer.from(jwk.y!,'base64url')]]));
  if(untrustedCandidate?.reencode)cose=isoCBOR.encode(new Map(Array.from((isoCBOR.decodeFirst(cose) as Map<number,unknown>).entries()).reverse()) as never);
  const b=await f.begin(),raw=randomBytes(32),rawId=raw.toString('base64url'),size=Buffer.alloc(2);size.writeUInt16BE(raw.length);
  const auth=Buffer.concat([sha('modeldb-a.example.test'),Buffer.from([0x45]),Buffer.alloc(4),Buffer.alloc(16),size,raw,Buffer.from(cose)]);
  const att=isoCBOR.encode(new Map<string,unknown>([['fmt','none'],['attStmt',new Map()],['authData',auth]]) as never);
  const r=await f.post(REG.complete,{...statusInput(f.instanceId,b),deploymentDescriptorSha256:'a'.repeat(64),challengeId:b.challengeId,credential:{id:rawId,rawId,type:'public-key',clientExtensionResults:{},response:{clientDataJSON:Buffer.from(JSON.stringify({type:'webauthn.create',challenge:b.publicKey.challenge,origin,crossOrigin:false})).toString('base64url'),attestationObject:Buffer.from(att).toString('base64url')}}});
  if(r.statusCode!==202)throw Error('SYNTHETIC_NEW_IDENTITY_FAILED');
  const assertion=(challenge:DeviceAuthenticationBeginResponseV1,counter=1)=>{
    const client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:challenge.publicKey.challenge,origin,crossOrigin:false})),count=Buffer.alloc(4);count.writeUInt32BE(counter);
    const auth=Buffer.concat([sha('modeldb-a.example.test'),Buffer.from([0x05]),count]);
    return {...a.binding,challengeId:challenge.challengeId,credential:{id:rawId,rawId,type:'public-key' as const,clientExtensionResults:{},response:{clientDataJSON:client.toString('base64url'),authenticatorData:auth.toString('base64url'),signature:sign('sha256',Buffer.concat([auth,sha(client)]),pair.privateKey).toString('base64url'),userHandle:b.publicKey.user.id as string|null}}};
  };
  return {applicationId:b.registrationId,rawId,assertion,
    async login(counter=1){const challenge=await a.service.begin(a.binding,a.context);return a.service.complete(assertion(challenge.response,counter),challenge.ceremonySecret,a.context);}
  };
}
