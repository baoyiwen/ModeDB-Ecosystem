/** Rebuild this receipt from retained development evidence. Never opens runtime material. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { parseHostingIntegrationTap, nativeChecks, browserChecks } from '../../../../scripts/security-hosting-integration-check.mjs';
const base='docs/security-v1-deliveries/evidence/SEC-M7-D23/';
const read=p=>readFileSync(p),json=p=>JSON.parse(read(p)),save=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n');
const hash=b=>createHash('sha256').update(b).digest('hex');
const descriptor=p=>({path:p,sha256:hash(read(p))});
const previousPath='docs/security-v1-deliveries/evidence/SEC-M7-D22/acceptance.json',previous=json(previousPath);
const integration=json(base+'integration-check.json');assert.equal(integration.ok,true);
const native=parseHostingIntegrationTap(read(base+'native.original.txt').toString('utf8'),integration.exitCode);
assert.deepEqual(native.unit,integration.unit);assert.deepEqual(native.native,integration.native);assert.deepEqual(native.browser,integration.browser);
const groups=[['hostingUnit','hosting',36],['authenticationUnit','authentication',55],['dynamicUnit','dynamic',42],['regressionUnit','regression',169],['maintenanceUnit','maintenance',33],['toolsUnit','tools',39],['launchCompatibilityUnit','launch-compat',19]];
const units={};for(const [key,name,count] of groups){
  const tap=read(base+name+'.original.txt').toString('utf8');assert.doesNotMatch(tap,/^not ok |^#.*(?:SKIP|TODO)\b/m);
  for(const [label,value] of [['tests',count],['pass',count],['fail',0],['cancelled',0],['skipped',0],['todo',0]]){const m=[...tap.matchAll(new RegExp('^# '+label+' (\\d+)\\s*$','gm'))];assert.equal(m.length,1);assert.equal(Number(m[0][1]),value);}
  units[key]={pass:count,fail:0,skip:0,cancelled:0,todo:0};
}
assert.ok(json(base+'static-commands.json').every(c=>c.exitCode===0));
const types=json(base+'types.original.txt'),consumer=json(base+'consumer-native.original.txt'),documents=json(base+'documents.original.json.txt');
assert.equal(types.ok,true);assert.equal(types.checks.strictHostingTypecheck,true);assert.equal(consumer.ok,true);assert.equal(consumer.checks.entireDesignerTypecheck,true);assert.equal(documents.ok,true);
const historicalEvidence=[...previous.historicalEvidence,...previous.verificationArtifacts,descriptor(previousPath)];
for(const f of historicalEvidence){assert.equal(hash(read(f.path)),f.sha256,'Historical bytes changed: '+f.path);}
const verification={format:'modeldb.security-hosting-verification.v1',revision:'SEC-M7-D23',task:'DR-P3.1',date:'2026-10-27',timezone:'America/New_York',baseCommit:previous.baseCommit,node:process.version,browserNode:integration.node,platform:process.platform,
  tasks:{v1Milestones:'7/7',v1:'20/20',registration:'12/23',registrationP1:'6/6',registrationP2:'5/5',registrationP3:'1/6',registrationWorkPackages:'2/4'},...units,nativeUnit:native.unit,totalTargetedPass:Object.values(units).reduce((n,u)=>n+u.pass,native.unit.pass),
  checks:Object.fromEntries([...nativeChecks,...browserChecks,'strictHostingTypes','serverTypecheck','designerTypecheck','browserBoundary','scopedFormatting','scopedLint','staticSnapshot','managementLifetimes','materialGuard'].map(k=>[k,true])),documentValidation:documents,historicalEvidenceVerified:historicalEvidence.length,
  scope:{temporarySyntheticOnly:true,liveMaterialRead:false,productionMigrationPerformed:false,physicalAuthenticatorTested:false,performanceTested:false,fullReleaseInstallTested:false,physicalDiskFullTested:false,remoteTlsHostedBrowserTested:false,lanTested:false,uiChanged:true,newRegistrationUiImplemented:false,defaultOsBrowserAutomationTested:false},
};
assert.equal(verification.totalTargetedPass,395);save(base+'verification.json',verification);
const sourcePaths=[...new Set([...previous.files.map(f=>f.path),
  'packages/server/src/security/browser-hosting.ts','packages/server/src/security/management-listener.ts','packages/server/src/server-access-info.ts',
  'scripts/security-hosting-integration-check.mjs','scripts/security-hosting-build.mjs','scripts/security-registration-consumer-check.mjs',
  'test/fixtures/security-hosting.ts','test/unit/security-hosting.test.ts','test/unit/security-hosting-report.test.mjs','test/integration/security-hosting-browser.test.ts',
  'docs/security-v1/examples/hosted-designer.loopback.json','docs/security-v1/device-registration-deployment-contract.md',
])].sort();
const files=sourcePaths.map(p=>({...descriptor(p),sha256Lf:hash(read(p).toString('utf8').replace(/\r\n/g,'\n'))}));
const verificationArtifacts=[];
const walk=(dir)=>{for(const name of readdirSync(dir).sort()){const p=join(dir,name).replace(/\\/g,'/'),s=lstatSync(p);assert.equal(s.isSymbolicLink(),false);if(s.isDirectory())walk(p);else if(p!==base+'acceptance.json')verificationArtifacts.push(descriptor(p));}};
walk(base);
save(base+'acceptance.json',{format:'modeldb.security-release-recheck.v1',revision:'SEC-M7-D23',task:'DR-P3.1',date:verification.date,baseCommit:previous.baseCommit,purpose:'Explicit same-origin Designer and separate OS-authenticated loopback management; native lifecycle and localized Chrome validation. No production migration or new registration UI.',verification:{status:'passed',report:base+'verification.json'},currentResults:{...Object.fromEntries(Object.entries(units).map(([k,u])=>[k+'Pass',u.pass])),nativePass:2,totalTargetedPass:395,skip:0,registration:'12/23',registrationP3:'1/6',registrationWorkPackages:'2/4'},files,historicalEvidence,verificationArtifacts});
console.log(JSON.stringify({ok:true,developmentFiles:files.length,historicalEvidence:historicalEvidence.length,verificationArtifacts:verificationArtifacts.length,totalTargetedPass:395}));
