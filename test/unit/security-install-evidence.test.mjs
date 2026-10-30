import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256, installedUpgradeChecks } from '../../scripts/security-install-contract.mjs';
import { verifyInstallEvidence } from '../../scripts/security-install-evidence.mjs';
function fixture(){
  const base='docs/security-v1-deliveries/evidence/SEC-M7-D31/',files=new Map();
  const save=(name,value)=>files.set(base+name,JSON.stringify(value));
  const source={path:'scripts/security-install-check.mjs',sha256:'a'.repeat(64)};
  const checks=['freshOutput','minifiedProductionPackages','exactArchiveManifest','offlineTarballInstall','cliHelp','binShim','consumerTypes','installedBrowserTypesWithoutNode','unchangedSource','cleanFrontends','documentedCliAndSecurityI18n'];
  const manifest={format:'modeldb.security-release-candidate.v1',packages:['common','core','data-kit','data-ui','sdk','server','shared'].map(n=>({name:'@mode-db/'+n})),apps:['data-studio','model-designer','web'].map(name=>({name})),checks:{...Object.fromEntries(checks.map(k=>[k,true])),frontendBuild:{configFile:false,envFile:false}},offlineDependencies:[{}],documentation:Array(9).fill(source),i18n:Array(3).fill({keys:['synthetic']}),sourceFiles:[source]};
  save('native/release-candidate.json',manifest);const hash=sha256(files.get(base+'native/release-candidate.json'));
  const scope={temporarySyntheticOnly:true,liveMaterialRead:false,realTwoDeviceTested:false,hardwareAuthenticatorTested:false,performanceTested:false,fullHistoricalPackageDowngradeTested:false,productionMigrationPerformed:false,frontendChanged:false};
  const upgrade={format:'modeldb.installed-upgrade.v1',ok:true,task:'DR-P4.3',platform:'win32',releaseManifestSha256:hash,checks:Object.fromEntries(installedUpgradeChecks.map(k=>[k,true])),scope,legacy:{sourceSha256:'ca5c64f8b3c5559cefffc0e11dfa2aa3240f96775b90f4f2a4e6f532fb3bdf0c',compiledSha256:'c'.repeat(64),rejectedVersions:[2,3,4,5]}};
  const report={format:'modeldb.security-install-check.v1',task:'DR-P4.3',ok:true,platform:'win32',releaseManifestSha256:hash,packages:7,frontends:3,sourceFiles:1,releaseRoot:'synthetic',commands:['candidate','upgrade'].map(name=>({name,exitCode:0,timedOut:false})),upgrade,checks:Object.fromEntries(Array.from({length:7},(_,i)=>['check'+i,true])),scope};
  save('native/install-check.json',report);save('native/upgrade.original.txt',upgrade);files.set(base+'native/candidate.original.txt','SUCCESS: synthetic/release-candidate.json');
  const unit={pass:4,fail:0,skip:0,cancelled:0,todo:0};
  for(const name of ['unit','receipt-tools']){files.set(base+name+'.original.txt','# tests 4\n# pass 4\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n');save(name+'.command.json',{exitCode:0,timedOut:false});}
  save('static-commands.json',Array(4).fill({exitCode:0,log:'static.original.txt'}));files.set(base+'static.original.txt','synthetic');save('documents.json',{ok:true});
  const verification={format:'modeldb.install-verification.v1',task:'DR-P4.3',tasks:{registration:'20/23',registrationP4:'3/6',registrationWorkPackages:'3/4'},candidateSha256:hash,unit,receiptUnit:unit,nativePass:1,totalTargetedPass:9,scope:{...scope,installedCandidateTested:true}};save('verification.json',verification);
  const receipt={task:'DR-P4.3',verification:{report:base+'verification.json'},files:[source],verificationArtifacts:[...files.keys()].map(path=>({path}))};
  const run=()=>verifyInstallEvidence({base,receipt,read:path=>{assert.ok(files.has(path));return Buffer.from(files.get(path));}});
  return {files,save,base,receipt,report,verification,manifest,run};
}
test('installation evidence binds exact archive manifest, raw upgrade and frozen source',()=>{assert.equal(fixture().run().task,'DR-P4.3');});
test('installation evidence rejects missing logs, failed commands and source drift',()=>{
  for(const name of ['native/upgrade.original.txt','native/candidate.original.txt','unit.original.txt','documents.json']){const x=fixture();x.receipt.verificationArtifacts=x.receipt.verificationArtifacts.filter(f=>f.path!==x.base+name);assert.throws(x.run);}
  const x=fixture();x.report.commands[1].exitCode=1;x.save('native/install-check.json',x.report);assert.throws(x.run);
  const y=fixture();y.receipt.files=[];assert.throws(y.run);
});
test('installation evidence rejects skipped, ambiguous TAP and modified candidate',()=>{
  for(const name of ['unit','receipt-tools']){const x=fixture();x.files.set(x.base+name+'.original.txt',x.files.get(x.base+name+'.original.txt').replace('# skipped 0','# skipped 1'));assert.throws(x.run);}
  const x=fixture();x.files.set(x.base+'unit.original.txt',x.files.get(x.base+'unit.original.txt')+'# pass 4\n');assert.throws(x.run);
  const y=fixture();y.manifest.checks.offlineTarballInstall=false;y.save('native/release-candidate.json',y.manifest);assert.throws(y.run);
});
test('installation evidence rejects premature completion, hardware, performance and historical downgrade claims',()=>{
  for(const mutate of [v=>v.tasks.registration='23/23',v=>v.scope.performanceTested=true,v=>v.scope.realTwoDeviceTested=true,v=>v.scope.fullHistoricalPackageDowngradeTested=true,v=>v.totalTargetedPass=99]){const x=fixture();mutate(x.verification);x.save('verification.json',x.verification);assert.throws(x.run);}
});
