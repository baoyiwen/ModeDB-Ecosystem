/** Two generated instances under one Windows account. Not physical-device or Hello evidence. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileDigest } from '@mode-db/common';
import { AuthoringEngine, designerAssetRows, readAtlasVaultKeyReference } from '@mode-db/core';
import { deliveryFixture } from '../fixtures/security-recipient-delivery.js';
import { designerFixture } from '../fixtures/security-designer-asset.js';
import { WindowsSecretProtector } from '../../packages/server/src/security/windows-secret-protector.js';
import { createAssetSigningKey, createMigrationKey, openMigrationKey } from '../../packages/server/src/security/migration-key.js';
import { ensureModelDbLayoutAtRoot } from '../../packages/server/src/modeldb-default-home.js';
import { LocalVaultKeyProvider } from '../../packages/server/src/security/local-vault-key-provider.js';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';

test('native offline approved-recipient backup and both asset formats reject wrong targets and restore with independent keys', { timeout: 540000 }, async () => {
  assert.equal(process.platform, 'win32', 'NATIVE_WINDOWS_REQUIRED');
  const protector = new WindowsSecretProtector(), x = await deliveryFixture(protector);
  const target = mkdtempSync(join(tmpdir(), 'ModeDB-Delivery-Target-'));
  const delivery = mkdtempSync(join(tmpdir(), 'ModeDB-Delivery-Files-'));
  // mkdtemp's directory is public; put sensitive inputs and packages in a new protected child.
  const external = join(delivery, 'protected'); protector.ensureDirectory(external);
  let sourceStopped = false;
  try {
    const sourceConfig = ensureModelDbLayoutAtRoot(x.f.root), targetConfig = ensureModelDbLayoutAtRoot(target);
    let registry = SecurityRegistry.open(join(target, 'security')); const targetId = registry.status().instanceId; registry.close();
    const phrase = 'synthetic independent recipient phrase', receiver = createMigrationKey(phrase), wrong = createMigrationKey(phrase), signer = createAssetSigningKey(phrase);
    const privateKey = openMigrationKey(receiver.privateKey, phrase);
    const recipient = x.associate({ privateKey, publicKey: createPublicKey(privateKey) });
    const provider = new LocalVaultKeyProvider(x.f.dir), fixture = designerFixture(false);
    for (const [database, vault] of [['source', fixture.business], ['model_designer_workspace', fixture.workspace]] as const) {
      mkdirSync(join(x.f.root, 'vault', database), { recursive: true });
      const material = provider.resolveKey(database);
      try { vault.saveSync(join(x.f.root, 'vault', database, 'atlas.mld'), material); } finally { material.key.fill(0); }
    }
    const phraseFile = join(external, 'phrase.txt'), receiverFile = join(external, 'receiver.private.json'), publisherFile = join(external, 'publisher.public.pem'), signerFile = join(external, 'signer.private.json'), wrongFile = join(external, 'wrong.private.json');
    writeFileSync(phraseFile, phrase);writeFileSync(receiverFile,receiver.privateKey);writeFileSync(wrongFile,wrong.privateKey);writeFileSync(publisherFile,signer.publicKey);writeFileSync(signerFile,signer.privateKey);
    const basicSelection=join(external,'basic.json'),designerSelection=join(external,'designer.json');
    writeFileSync(basicSelection,JSON.stringify({models:['Item'],includeData:true}));
    writeFileSync(designerSelection,JSON.stringify({models:[],includeData:true,designer:{queries:[fixture.query.id],operations:[],bindings:[]}}));
    const tsx=fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs',import.meta.url)),cliPath=fileURLToPath(new URL('../../packages/server/src/cli.ts',import.meta.url));
    const cli=(...args:string[])=>spawnSync(process.execPath,[tsx,cliPath,...args],{encoding:'utf8',windowsHide:true,timeout:90000});
    const security=(...args:string[])=>cli('security',...args);
    const sourceArgs=['-c',sourceConfig,'--instance',x.f.instanceId];
    const list=()=>{const result=security('recipient-list',...sourceArgs);assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout) as {revision:number;keys:{id:string;state:string}[]};};
    const flags=(revision:number)=>['--recipient-id',recipient.id,'--recipient-user',recipient.userId,'--recipient-version',String(recipient.keyVersion),'--recipient-fingerprint',recipient.fingerprint,'--revision',String(revision)];
    const backup=join(external,'migration.package'),asset1=join(external,'asset-v1.package'),asset2=join(external,'asset-v2.package');
    const busy=security('backup-export',...sourceArgs,'--database','source',...flags(x.f.registry.status().revision),'--output',backup,'--yes');assert.equal(busy.status,1);assert.match(busy.stderr,/SECURITY_INSTANCE_BUSY/);assert.equal(existsSync(backup),false);
    await x.f.stop();sourceStopped=true;
    let page=list();assert.equal(page.keys.length,2);assert.equal(page.keys[0].state,'retired');
    const bad=flags(page.revision);bad[bad.indexOf('--recipient-fingerprint')+1]='0'.repeat(64);
    const rejected=security('backup-export',...sourceArgs,'--database','source',...bad,'--output',backup,'--yes');assert.equal(rejected.status,1);assert.equal(existsSync(backup),false);
    const raw=join(external,'raw.pem');writeFileSync(raw,receiver.publicKey);
    assert.equal(security('backup-export',...sourceArgs,'--database','source','--public-key',raw,'--output',backup,'--yes').status,1);assert.equal(existsSync(backup),false);
    page=list();const stale=page.revision;list();assert.equal(security('backup-export',...sourceArgs,'--database','source',...flags(stale),'--output',backup,'--yes').status,1);assert.equal(existsSync(backup),false);
    page=list();const exported=security('backup-export',...sourceArgs,'--database','source',...flags(page.revision),'--output',backup,'--yes');assert.equal(exported.status,0,exported.stderr);
    assert.equal(JSON.parse(exported.stdout).recipient.id,recipient.id);assert.equal(JSON.parse(exported.stdout).packageSha256,fileDigest(readFileSync(backup)));assert.equal(JSON.parse(readFileSync(backup,'utf8')).format,'modeldb.backup.v2');
    for(const [selection,output,format] of [[basicSelection,asset1,'modeldb.asset.v1'],[designerSelection,asset2,'modeldb.asset.v2']] as const){
      page=list();const result=security('asset-export',...sourceArgs,'--database','source','--selection',selection,'--asset-id','approved-synthetic','--asset-version','1.0.0',...flags(page.revision),'--signing-key',signerFile,'--passphrase-file',phraseFile,'--output',output,'--yes');assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).recipient.fingerprint,recipient.fingerprint);assert.equal(JSON.parse(result.stdout).packageSha256,fileDigest(readFileSync(output)));assert.equal(JSON.parse(readFileSync(output,'utf8')).format,format);
    }
    const before=fileDigest(readFileSync(backup));page=list();assert.equal(security('backup-export',...sourceArgs,'--database','source',...flags(page.revision),'--output',backup,'--yes').status,1);assert.equal(fileDigest(readFileSync(backup)),before);
    registry=SecurityRegistry.open(x.f.dir);const events=registry.auditEvents().filter(e=>e.action==='recipient.delivery.sealed');assert.equal(events.length,3);for(const path of [backup,asset1,asset2])assert.ok(events.some(e=>e.delivery?.packageSha256===fileDigest(readFileSync(path))&&e.delivery.recipientKeyId===recipient.id));registry.close();
    // Prove imports do not consult the source registry, source keys, or an online identity.
    rmSync(x.f.root,{recursive:true,force:true});
    const importArgs=['-c',targetConfig,'--instance',targetId,'--database','received-backup','--package',backup,'--private-key',receiverFile,'--passphrase-file',phraseFile,'--yes'];
    const wrongArgs=[...importArgs];wrongArgs[wrongArgs.indexOf('--private-key')+1]=wrongFile;assert.equal(security('backup-import',...wrongArgs).status,1);assert.equal(existsSync(join(target,'vault','received-backup')),false);
    const damaged=join(external,'tampered.package'),object=JSON.parse(readFileSync(backup,'utf8'));object.ciphertext=(object.ciphertext[0]==='A'?'B':'A')+object.ciphertext.slice(1);writeFileSync(damaged,JSON.stringify(object));const damagedArgs=[...importArgs];damagedArgs[damagedArgs.indexOf('--package')+1]=damaged;assert.equal(security('backup-import',...damagedArgs).status,1);
    const imported=security('backup-import',...importArgs);assert.equal(imported.status,0,imported.stderr);const receipt=JSON.parse(imported.stdout);assert.equal(receipt.restored,false);
    const restored=cli('restore','received-backup',receipt.imported.fileName,'-c',targetConfig,'--yes');assert.equal(restored.status,0,restored.stderr);assert.equal(security('backup-import',...importArgs).status,1);
    for(const [pkg,database]of [[asset1,'received-asset'],[asset2,'received-designer']]as const){
      const args=['-c',targetConfig,'--instance',targetId,'--database',database,'--package',pkg,'--private-key',receiverFile,'--passphrase-file',phraseFile,'--publisher-key',publisherFile,'--publisher-fingerprint',signer.recipientId];
      const wrongArgs=[...args];wrongArgs[wrongArgs.indexOf('--private-key')+1]=wrongFile;assert.equal(security('asset-preview',...wrongArgs).status,1);assert.equal(existsSync(join(target,'vault',database)),false);
      const preview=security('asset-preview',...args);assert.equal(preview.status,0,preview.stderr);const digest=JSON.parse(preview.stdout).confirmationDigest;
      const bad=[...args];bad[bad.indexOf('--database')+1]=database+'-wrong';assert.equal(security('asset-import',...bad,'--preview-digest',digest,'--yes').status,1);assert.equal(existsSync(join(target,'vault',database+'-wrong')),false);
      const result=security('asset-import',...args,'--preview-digest',digest,'--yes');assert.equal(result.status,0,result.stderr);
      const snapshot=fileDigest(readFileSync(join(target,'vault',database,'atlas.mld')));assert.equal(security('asset-import',...args,'--preview-digest',digest,'--yes').status,1);assert.equal(fileDigest(readFileSync(join(target,'vault',database,'atlas.mld'))),snapshot);
    }
    for(const database of ['received-backup','received-asset','received-designer']){
      const engine=new AuthoringEngine({atlas:database,storageRoot:join(target,'vault'),keyProvider:new LocalVaultKeyProvider(join(target,'security')),engineLogger:false});try{const rows=await engine.persistence.getMergedReader().getAll('Item');assert.equal(rows.length,1);assert.equal(rows[0].label,fixture.graph.models[0].rows[0].label);}finally{await engine.close();}
      assert.notEqual(readAtlasVaultKeyReference(join(target,'vault',database,'atlas.mld'))!.instanceId,x.f.instanceId);
    }
    const workspace=new AuthoringEngine({atlas:'model_designer_workspace',storageRoot:join(target,'vault'),keyProvider:new LocalVaultKeyProvider(join(target,'security')),engineLogger:false});try{assert.equal(designerAssetRows(workspace.atlasVault!,'sys_query_interface').length,1);}finally{await workspace.close();}
    registry=SecurityRegistry.open(join(target,'security'));try{assert.equal(registry.status().credentials,0);assert.equal(registry.registrationStorageStatus().users,0);}finally{registry.close();}
    console.log(JSON.stringify({format:'modeldb.recipient-delivery-native.v1',ok:true,formats:['modeldb.backup.v2','modeldb.asset.v1','modeldb.asset.v2'],nativeDpapi:true,sourceRemoved:true,wrongRecipientRejected:true,staleRevisionRejected:true,wrongPrivateKeyRejected:true,tamperRejected:true,wrongTargetRejected:true,repeatPublicationRejected:true,freshDestinationKeys:true,emptyAccessLedger:true,realTwoDeviceTested:false,liveMaterialRead:false}));
  }finally{if(!sourceStopped)await x.f.stop();for(const path of [x.f.root,target,delivery])rmSync(path,{recursive:true,force:true});}
});
