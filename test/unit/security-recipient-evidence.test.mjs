import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { verifyRecipientEvidence } from '../../scripts/security-recipient-evidence.mjs';
import { recipientChecks } from '../../scripts/security-recipient-check.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
function fixture() {
  const base='docs/security-v1-deliveries/evidence/SEC-M7-D29/',files=new Map();
  const save=(name,value)=>files.set(base+name,JSON.stringify(value));
  const browser={format:'modeldb.recipient-browser.v1',ok:true,browser:'Chrome/156',screenshots:18,hardwareAuthenticatorTested:false,systemTrustInstalled:false,liveMaterialRead:false,checks:Object.fromEntries(recipientChecks.map(k=>[k,true]))};
  const unit={pass:20,fail:0,skip:0,cancelled:0,todo:0},nativeUnit={...unit,pass:1};
  const manifest={source:[{path:'packages/shared/src/recipient-keys.ts',sha256:'0'.repeat(64)}],artifacts:[{path:'assets/test.js',sha256:sha('synthetic')} ]};
  files.set(base+'native/build/assets/test.js','synthetic');save('native/candidate-manifest.json',manifest);
  const candidateSha256=sha(JSON.stringify(manifest));
  save('native/integration-check.json',{format:'modeldb.recipient-check.v1',task:'DR-P4.1',ok:true,candidateSha256,exitCode:0,unit:nativeUnit,browser,build:{configFile:false,envFile:false},scope:{temporarySyntheticOnly:true,liveMaterialRead:false,hardwareAuthenticatorTested:false,systemTrustInstalled:false}});
  files.set(base+'native/native.original.txt','# '+JSON.stringify(browser)+'\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n');
  files.set(base+'unit.original.txt','# tests 20\n# pass 20\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n');
  files.set(base+'receipt-tools.original.txt','# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n');
  for(const name of ['types.original.txt','consumer.original.txt'])save(name,{ok:true,checks:{synthetic:true}});
  save('static-commands.json',Array(3).fill({exitCode:0}));save('documents.json',{ok:true});save('visual-review.json',{reviewed:true});
  for(const scene of ['challenge','review','history'])for(const locale of ['zh','en','ja'])for(const width of [1280,390])files.set(`${base}native/screenshots/${scene}-${locale}-${width}.png`,'synthetic');
  const verification={format:'modeldb.recipient-verification.v1',task:'DR-P4.1',candidateSha256,tasks:{registration:'18/23',registrationP4:'1/6',registrationWorkPackages:'3/4'},unit,receiptUnit:{...unit,pass:1},nativePass:1,totalTargetedPass:22,checks:Object.fromEntries(['protocolAndRecovery','atomicProofAndHistory','strictTypes','browserBoundary','localizedUi','documents','materialGuard'].map(k=>[k,true])),scope:{liveMaterialRead:false,realTwoDeviceTested:false,packageDeliveryTested:false}};
  save('verification.json',verification);
  const receipt={task:'DR-P4.1',verification:{report:base+'verification.json'},files:manifest.source,verificationArtifacts:[...files.keys()].map(path=>({path}))};
  const run=()=>verifyRecipientEvidence({read:path=>{assert.ok(files.has(path));return Buffer.from(files.get(path));},receipt,base});
  return {base,files,save,receipt,verification,run};
}
test('recipient evidence binds the current source, build, native checks and raw test summaries',()=>{const x=fixture();assert.equal(x.run().task,'DR-P4.1');});
test('recipient evidence rejects missing mandatory artifacts and source bindings',()=>{
  for(const name of ['native/candidate-manifest.json','native/screenshots/history-ja-390.png','native/build/assets/test.js','receipt-tools.original.txt']){const x=fixture();x.receipt.verificationArtifacts=x.receipt.verificationArtifacts.filter(f=>f.path!==x.base+name);assert.throws(x.run);}
  const x=fixture();x.receipt.files=[];assert.throws(x.run);
});
test('recipient evidence rejects skipped, failed, changed or missing browser and unit results',()=>{
  for(const name of ['unit.original.txt','native/native.original.txt','receipt-tools.original.txt']){const x=fixture();x.files.set(x.base+name,x.files.get(x.base+name).replace('# skipped 0','# skipped 1'));assert.throws(x.run);}
  const x=fixture();x.files.set(x.base+'native/build/assets/test.js','changed');assert.throws(x.run);
});
test('recipient evidence does not upgrade scope, stage counts or incomplete checks',()=>{
  for(const update of [v=>{v.scope.realTwoDeviceTested=true;},v=>{v.checks.atomicProofAndHistory=false;},v=>{v.tasks.registration='23/23';},v=>{v.totalTargetedPass=999;}]){const x=fixture();update(x.verification);x.save('verification.json',x.verification);assert.throws(x.run);}
});
