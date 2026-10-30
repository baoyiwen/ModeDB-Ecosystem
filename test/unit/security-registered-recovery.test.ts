/** DR-P4.4: recovery of data must never roll back registered identity revocation. */
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AtlasSingleVault, readAtlasVaultKeyReference } from '@mode-db/core';
import type { RecipientChallenge, RecipientKeyPage } from '@mode-db/shared';
import { authenticationFixture } from '../fixtures/security-authentication.js';
import { syntheticProtector, SID } from '../fixtures/security-registration-integration.js';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';
import { AuthenticationService } from '../../packages/server/src/security/authentication-service.js';
import { LocalVaultKeyProvider } from '../../packages/server/src/security/local-vault-key-provider.js';
import { answerRecipientChallenge } from '../../packages/server/src/security/recipient-keys.js';
import { dispatchLocalSecurity } from '../../packages/server/src/security/local-management-channel.js';
import { createRecoveryPackageFile, restoreRecoveryPackageFile } from '../../packages/server/src/security/recovery-material.js';
import { createDatabaseBackup, restoreDatabaseBackup } from '../../packages/server/src/backup-manager.js';

async function setup() {
  const a = await authenticationFixture(), {f}=a, protector=syntheticProtector(f.key);
  const b=await a.begin(), login=await a.service.complete(a.assertion(b.response),b.ceremonySecret,a.context);
  const credential=f.registry.readRegistrationStorage().credentials[0]!;
  const recipient=(action:string,extra:Record<string,unknown>={})=>f.local({action:'registration.recipient.'+action,instanceId:f.instanceId,...(action==='list'?{}:{revision:f.registry.status().revision,confirm:true}),...extra});
  recipient('initialize');
  const pair=generateKeyPairSync('rsa',{modulusLength:3072});
  const challenge=(recipient('begin',{userId:credential.userId,publicKey:pair.publicKey.export({type:'spki',format:'pem'}).toString()}) as {challenge:RecipientChallenge}).challenge;
  recipient('complete',{response:answerRecipientChallenge(challenge,pair.privateKey,f.now)});
  const provider=new LocalVaultKeyProvider(f.dir,protector),material=provider.resolveKey('synthetic_business');
  const directory=join(f.root,'synthetic_business');mkdirSync(directory);
  const path=join(directory,'atlas.mld'),vault=new AtlasSingleVault(),canary='synthetic-private-row-'+randomBytes(24).toString('hex');
  vault.set('m:Item',canary);vault.saveSync(path,material);material.key.fill(0);
  const disable=()=>f.local({action:'registration.user.disable',instanceId:f.instanceId,id:credential.userId,revision:f.registry.status().revision,confirm:true});
  return {a,f,protector,credential,login,recipient,provider,path,canary,disable};
}
test('portable recovery from an active V5 source restores data with no registered identities, sessions or recipients',async()=>{
  const x=await setup(),{a,f}=x;
  let target:SecurityRegistry|undefined,authentication:AuthenticationService|undefined;
  try {
    const external=join(f.root,'external');mkdirSync(external);
    const archive=join(external,'synthetic.mdrecovery'),phrase='synthetic-phrase-'+randomBytes(24).toString('hex');
    createRecoveryPackageFile(x.provider,archive,phrase,f.dir,f.registry);
    x.disable();assert.throws(()=>f.registry.verifySession(x.login.session));
    const targetHome=join(f.root,'recovery');mkdirSync(targetHome);
    const targetDir=join(targetHome,'security');restoreRecoveryPackageFile(archive,phrase,targetDir,x.protector);
    copyFileSync(x.path,join(targetHome,'atlas.mld'));
    const provider=new LocalVaultKeyProvider(targetDir,x.protector),material=provider.resolveKey('synthetic_business',readAtlasVaultKeyReference(x.path)!);
    const vault=new AtlasSingleVault();assert.equal(vault.loadSync(join(targetHome,'atlas.mld'),material),true);material.key.fill(0);assert.equal(vault.get('m:Item'),x.canary);
    target=SecurityRegistry.open(targetDir,{protector:x.protector,now:()=>f.now});
    assert.equal(target.status().instanceId,f.instanceId);assert.equal(target.status().credentials,0);assert.equal(target.status().sessions,0);
    assert.throws(()=>target!.verifySession(x.login.session));
    target.migrateAuthenticationStorage(target.status().revision);
    assert.deepEqual(target.readRegistrationStorage().users,[]);assert.deepEqual(target.readRegistrationStorage().credentials,[]);
    target.withLocalActor(SID,()=>dispatchLocalSecurity(target!,{action:'registration.recipient.initialize',instanceId:f.instanceId,revision:target!.status().revision,confirm:true}));
    const keys=target.withLocalActor(SID,()=>dispatchLocalSecurity(target!,{action:'registration.recipient.list',instanceId:f.instanceId})) as RecipientKeyPage;assert.equal(keys.total,0);
    authentication=new AuthenticationService(target,{enabled:true},f.descriptor,()=>f.now);
    const fresh=await authentication.begin(a.binding,a.context);
    await assert.rejects(()=>authentication!.complete(a.assertion(fresh.response,2),fresh.ceremonySecret,a.context),{code:'SECURITY_AUTHENTICATION_PROOF_INVALID'});
    const publicEvidence=JSON.stringify({audit:target.auditEvents(),status:target.status()});
    for(const secret of [x.canary,phrase,x.login.session,x.credential.rawId,x.credential.publicKeyCose])assert.equal(publicEvidence.includes(secret),false,'Recovered public evidence excludes generated material');
    assert.equal(readFileSync(archive).includes(Buffer.from(x.canary)),false);assert.equal(readFileSync(archive).includes(Buffer.from(phrase)),false);
    await a.reopen();assert.throws(()=>f.registry.verifySession(x.login.session));
  } finally {authentication?.close();target?.close();a.service.close();await a.close();}
});
test('ordinary data backup made before V5 user stop cannot restore access or replace recipient history',async()=>{
  const x=await setup(),{a,f}=x;
  try {
    const before=(x.recipient('list') as RecipientKeyPage).keys;
    const backup=createDatabaseBackup(f.root,'synthetic_business','manual',undefined,x.provider);
    x.disable();const ledger=readFileSync(join(f.dir,'registry.mds'));
    restoreDatabaseBackup(f.root,'synthetic_business',backup.fileName,x.provider);
    assert.deepEqual(readFileSync(join(f.dir,'registry.mds')),ledger);
    await a.reopen();assert.throws(()=>f.registry.verifySession(x.login.session));
    assert.equal(f.registry.readRegistrationStorage().users[0]!.enabled,false);
    assert.deepEqual((x.recipient('list') as RecipientKeyPage).keys,before);
    const next=await a.begin();await assert.rejects(()=>a.service.complete(a.assertion(next.response,2),next.ceremonySecret,a.context),{code:'SECURITY_AUTHENTICATION_PROOF_INVALID'});
    const material=x.provider.resolveKey('synthetic_business',readAtlasVaultKeyReference(x.path)!);const vault=new AtlasSingleVault();assert.equal(vault.loadSync(x.path,material),true);material.key.fill(0);assert.equal(vault.get('m:Item'),x.canary);
  } finally {a.service.close();await a.close();}
});
