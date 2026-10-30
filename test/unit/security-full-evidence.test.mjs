import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fullFixture } from '../fixtures/security-full-report.mjs';
import { verifyFullEvidence } from '../../scripts/security-full-evidence.mjs';
import { sha256 } from '../../scripts/security-install-contract.mjs';
function fixture() {
 const base='docs/security-v1-deliveries/evidence/SEC-M7-D32/', files=new Map();
 const save=(name,value)=>files.set(base+name,JSON.stringify(value));
 const full=fullFixture(), source={path:'scripts/security-full-check.mjs',sha256:'b'.repeat(64)};
 const sourceManifest={format:'modeldb.full-source.v1',sources:[source]};
 save('native/source-manifest.json',sourceManifest);
 full.sourceSha256=sha256(files.get(base+'native/source-manifest.json'));
 full.resilience={format:'modeldb.authentication-resilience-matrix.v1',ok:true,hardExitCases:30,signedRaceCases:10,auditFaultCases:4,liveMaterialRead:false,hardwareAuthenticatorTested:false,checks:Object.fromEntries(['hardProcessExits','atomicSessionAudit','unknownOutcomeInspectable','noRevivalAfterRestart','disableEnableProofBarrier','latestReduction','maintenanceCas','legacyApiPairingManagement','noSecretsInLogs'].map(k=>[k,true]))};
 full.scannedFiles=10;
 const tap=n=>'# tests '+n+'\n# pass '+n+'\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
 files.set(base+'regression/unit.original.txt',tap(2)+'# '+JSON.stringify(full.resilience)+'\n');
 for(const r of full.regression.results.slice(1))files.set(base+'regression/'+r.name+'.original.txt','synthetic engine checks passed\n');
 const app={path:'model-designer/index.html',sha256:sha256('<main>synthetic</main>')};
 files.set(base+'browser/builds/'+app.path,'<main>synthetic</main>');
 const browserManifest={sources:[source],applications:[app]};
 save('browser/candidate-manifest.json',browserManifest);
 full.browser.candidateSha256=sha256(JSON.stringify(browserManifest));
 for(const g of full.browser.groups){g.candidateSha256=full.browser.candidateSha256;files.set(base+'browser/'+g.log,tap(g.unit.pass));}
 for(const g of full.native)files.set(base+'native/'+g.name+'.original.txt',tap(g.unit.pass));
 full.commands=[...full.native.map(g=>g.name),'security-registration-storage-check','security-registration-consumer-check'].map(name=>({name,exitCode:0,timedOut:false}));
 for(const c of full.commands)save('native/command-'+c.name+'.json',c);
 for(const n of ['security-registration-storage-check','security-registration-consumer-check'])save('native/'+n+'.original.txt',{ok:true,checks:{synthetic:true}});
 save('native/full-check.json',full);
 save('static-commands.json',Array(4).fill({exitCode:0,log:'static.original.txt'})); files.set(base+'static.original.txt','synthetic');
 save('documents.json',{ok:true});
 const verification={format:'modeldb.full-verification.v1',task:'DR-P4.4',sourceSha256:full.sourceSha256,tasks:{registration:'21/23',registrationP4:'4/6',registrationWorkPackages:'3/4'},totalPass:24,unitPass:2,nativePass:22,scope:{...full.scope}};
 save('verification.json',verification);
 const receipt={task:'DR-P4.4',verification:{report:base+'verification.json'},files:[source],verificationArtifacts:[...files.keys()].map(path=>({path}))};
 const run=()=>verifyFullEvidence({base,receipt,read:path=>{assert.ok(files.has(path),'Synthetic artifact missing');return Buffer.from(files.get(path));}});
 return {base,files,save,full,receipt,verification,run};
}
test('full evidence binds frozen source, actual TAP, new browser bytes and recovery matrix',()=>{assert.equal(fixture().run().task,'DR-P4.4');});
test('full evidence rejects missing required artifacts, failed command metadata and source drift',()=>{
 for(const name of ['native/source-manifest.json','regression/unit.original.txt','browser/hosting.tap','native/delivery.original.txt','documents.json']){const x=fixture();x.receipt.verificationArtifacts=x.receipt.verificationArtifacts.filter(f=>f.path!==x.base+name);assert.throws(x.run);}
 const x=fixture();x.save('native/command-delivery.json',{name:'delivery',exitCode:1,timedOut:false});assert.throws(x.run);
 const y=fixture();y.receipt.files=[];assert.throws(y.run);
});
test('full evidence rejects skipped or ambiguous TAP, altered page bytes and a missing fault matrix',()=>{
 for(const name of ['regression/unit.original.txt','browser/public.tap','native/registration.original.txt']){const x=fixture();x.files.set(x.base+name,x.files.get(x.base+name).replace('# skipped 0','# skipped 1'));assert.throws(x.run);}
 const x=fixture();x.files.set(x.base+'regression/unit.original.txt',x.files.get(x.base+'regression/unit.original.txt')+'# pass 2\n');assert.throws(x.run);
 const y=fixture();y.files.set(y.base+'browser/builds/model-designer/index.html','modified');assert.throws(y.run);
 const z=fixture();z.files.set(z.base+'regression/unit.original.txt',z.files.get(z.base+'regression/unit.original.txt').split('\n').filter(l=>!l.includes('resilience-matrix')).join('\n'));assert.throws(z.run);
});
test('full evidence rejects inflated completion, performance, hardware and secret-output claims',()=>{
 for(const mutate of [v=>v.tasks.registration='23/23',v=>v.scope.performanceTested=true,v=>v.scope.hardwareAuthenticatorTested=true,v=>v.totalPass++]){const x=fixture();mutate(x.verification);x.save('verification.json',x.verification);assert.throws(x.run);}
 const x=fixture();x.files.set(x.base+'native/delivery.original.txt',x.files.get(x.base+'native/delivery.original.txt')+'Bearer '+'a'.repeat(48));assert.throws(x.run);
});
