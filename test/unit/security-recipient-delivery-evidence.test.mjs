import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { verifyRecipientDeliveryEvidence } from '../../scripts/security-recipient-delivery-evidence.mjs';
import { deliveryChecks } from '../../scripts/security-recipient-delivery-check.mjs';
function fixture() {
  const base='docs/security-v1-deliveries/evidence/SEC-M7-D30/', files=new Map();
  const save=(name,value)=>files.set(base+name,JSON.stringify(value));
  const unit={pass:15,fail:0,skip:0,cancelled:0,todo:0};
  const tap=count=>`# tests ${count}\n# pass ${count}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
  const native={format:'modeldb.recipient-delivery-native.v1',ok:true,formats:['modeldb.backup.v2','modeldb.asset.v1','modeldb.asset.v2'],...Object.fromEntries(deliveryChecks.map(k=>[k,true])),realTwoDeviceTested:false,liveMaterialRead:false};
  const manifest={source:[{path:'packages/server/src/security/recipient-delivery.ts',sha256:'0'.repeat(64)}]};
  save('native/source-manifest.json',manifest);
  const candidateSha256=createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  save('native/integration-check.json',{format:'modeldb.recipient-delivery-check.v1',task:'DR-P4.2',ok:true,platform:'win32',timedOut:false,exitCode:0,candidateSha256,unit:{...unit,pass:1},native,scope:{temporarySyntheticOnly:true,liveMaterialRead:false,realTwoDeviceTested:false,frontendChanged:false,packageFormatsChanged:false}});
  files.set(base+'native/native.original.txt','# '+JSON.stringify(native)+'\n'+tap(1));
  files.set(base+'unit.original.txt',tap(15));files.set(base+'receipt-tools.original.txt',tap(4));
  for(const name of ['unit.command.json','receipt-tools.command.json'])save(name,{exitCode:0,timedOut:false});
  for(const name of ['types.original.txt','consumer.original.txt'])save(name,{ok:true,checks:{synthetic:true}});
  save('static-commands.json',Array(4).fill({exitCode:0,log:'static.original.txt'}));files.set(base+'static.original.txt','synthetic');
  save('documents.json',{ok:true});
  const verification={format:'modeldb.recipient-delivery-verification.v1',task:'DR-P4.2',candidateSha256,tasks:{registration:'19/23',registrationP4:'2/6',registrationWorkPackages:'3/4'},unit,receiptUnit:{...unit,pass:4},nativePass:1,totalTargetedPass:20,checks:Object.fromEntries(['exactRecipientAndCas','atomicSealingAudit','existingFormatsAndRecovery','strictTypes','browserBoundary','documents','materialGuard'].map(k=>[k,true])),scope:{temporarySyntheticOnly:true,packageDeliveryTested:true,liveMaterialRead:false,realTwoDeviceTested:false,frontendChanged:false,fullReleaseInstallTested:false,performanceTested:false,productionMigrationPerformed:false}};
  save('verification.json',verification);
  const receipt={task:'DR-P4.2',verification:{report:base+'verification.json'},files:manifest.source,verificationArtifacts:[...files.keys()].map(path=>({path}))};
  const run=()=>verifyRecipientDeliveryEvidence({read:path=>{assert.ok(files.has(path));return Buffer.from(files.get(path));},receipt,base});
  return {base,files,save,receipt,verification,run};
}
test('delivery evidence binds exact source, native raw result, summaries and scope',()=>{assert.equal(fixture().run().task,'DR-P4.2');});
test('delivery evidence refuses absent reports, static logs and source binding',()=>{
  for(const name of ['native/source-manifest.json','native/native.original.txt','unit.command.json','static.original.txt']){const x=fixture();x.receipt.verificationArtifacts=x.receipt.verificationArtifacts.filter(f=>f.path!==x.base+name);assert.throws(x.run);}
  const x=fixture();x.receipt.files=[];assert.throws(x.run);
});
test('delivery evidence rejects skipped results, nonzero process and candidate drift',()=>{
  for(const name of ['unit.original.txt','receipt-tools.original.txt','native/native.original.txt']){const x=fixture();x.files.set(x.base+name,x.files.get(x.base+name).replace('# skipped 0','# skipped 1'));assert.throws(x.run);}
  const x=fixture();x.save('unit.command.json',{exitCode:1,timedOut:false});assert.throws(x.run);
  const y=fixture();y.save('native/source-manifest.json',{source:[]});assert.throws(y.run);
});
test('delivery evidence rejects premature stage, install, performance and device claims',()=>{
  for(const update of [v=>{v.scope.realTwoDeviceTested=true;},v=>{v.scope.performanceTested=true;},v=>{v.scope.fullReleaseInstallTested=true;},v=>{v.tasks.registration='23/23';},v=>{v.totalTargetedPass=99;},v=>{v.checks.atomicSealingAudit=false;}]){const x=fixture();update(x.verification);x.save('verification.json',x.verification);assert.throws(x.run);}
});
