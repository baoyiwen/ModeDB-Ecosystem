/** Bind retained D24 checks to current development sources and immutable D23 history. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,readdirSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {parseHostingIntegrationTap,nativeChecks,browserChecks} from '../../../../scripts/security-hosting-integration-check.mjs';
import {parseIdentityBrowserTap,identityBrowserChecks} from '../../../../scripts/security-designer-identity-check.mjs';
const base='docs/security-v1-deliveries/evidence/SEC-M7-D24/';
const read=p=>readFileSync(p),json=p=>JSON.parse(read(p)),save=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n');
const hash=b=>createHash('sha256').update(b).digest('hex'),descriptor=p=>({path:p,sha256:hash(read(p))});
const previousPath='docs/security-v1-deliveries/evidence/SEC-M7-D23/acceptance.json',previous=json(previousPath);
const integration=json(base+'integration-check.json'),identity=json(base+'identity-integration-check.json');assert.equal(integration.ok,true);assert.equal(identity.ok,true);
const native=parseHostingIntegrationTap(read(base+'native.original.txt').toString('utf8'),integration.exitCode),ui=parseIdentityBrowserTap(read(base+'identity-native.original.txt').toString('utf8'),identity.exitCode);
assert.deepEqual(native.unit,integration.unit);assert.deepEqual(native.native,integration.native);assert.deepEqual(native.browser,integration.browser);assert.deepEqual(ui.unit,identity.unit);assert.deepEqual(ui.browser,identity.browser);
const groups=[['hostingUnit','hosting',36],['identityUnit','identity',24],['authenticationUnit','authentication',55],['dynamicUnit','dynamic',42],['regressionUnit','regression',169],['maintenanceUnit','maintenance',33],['toolsUnit','tools',41],['launchCompatibilityUnit','launch-compat',19]];
const units={};for(const [key,name,count] of groups){
  const tap=read(base+name+'.original.txt').toString('utf8');assert.doesNotMatch(tap,/^not ok |^#.*(?:SKIP|TODO)\b/m);
  for(const [label,value] of [['tests',count],['pass',count],['fail',0],['cancelled',0],['skipped',0],['todo',0]]){const matches=[...tap.matchAll(new RegExp('^# '+label+' (\\d+)\\s*$','gm'))];assert.equal(matches.length,1);assert.equal(Number(matches[0][1]),value);}
  units[key]={pass:count,fail:0,skip:0,cancelled:0,todo:0};
}
assert.ok(json(base+'static-commands.json').every(c=>c.exitCode===0));
const types=json(base+'types.original.txt'),consumer=json(base+'consumer-native.original.txt'),documents=json(base+'documents.original.json.txt');
assert.equal(types.ok,true);assert.equal(types.checks.strictDesignerIdentityTypecheck,true);assert.equal(consumer.ok,true);assert.equal(consumer.checks.entireDesignerTypecheck,true);assert.equal(documents.ok,true);assert.equal(documents.completedRegistrationTasks,13);
const historicalEvidence=[...previous.historicalEvidence,...previous.verificationArtifacts,descriptor(previousPath)];
for(const file of historicalEvidence)assert.equal(hash(read(file.path)),file.sha256,'Historical bytes changed: '+file.path);
const verification={format:'modeldb.security-designer-identity-verification.v1',revision:'SEC-M7-D24',task:'DR-P3.2',date:'2026-10-27',timezone:'America/New_York',baseCommit:previous.baseCommit,node:process.version,browserNode:identity.node,platform:process.platform,
  tasks:{v1Milestones:'7/7',v1:'20/20',registration:'13/23',registrationP1:'6/6',registrationP2:'5/5',registrationP3:'2/6',registrationWorkPackages:'2/4'},...units,nativeUnit:native.unit,identityNativeUnit:ui.unit,totalTargetedPass:Object.values(units).reduce((n,u)=>n+u.pass,native.unit.pass+ui.unit.pass),
  checks:Object.fromEntries([...new Set([...nativeChecks,...browserChecks,...identityBrowserChecks,'strictHostingTypes','serverTypecheck','designerTypecheck','browserBoundary','scopedFormatting','scopedLint','staticSnapshot','managementLifetimes','materialGuard'])].map(k=>[k,true])),
  documentValidation:documents,historicalEvidenceVerified:historicalEvidence.length,
  scope:{temporarySyntheticOnly:true,liveMaterialRead:false,productionMigrationPerformed:false,physicalAuthenticatorTested:false,performanceTested:false,fullReleaseInstallTested:false,physicalDiskFullTested:false,tlsHostedBrowserTested:true,remoteTlsHostedBrowserTested:false,lanTested:false,uiChanged:true,newRegistrationUiImplemented:true,defaultOsBrowserAutomationTested:false,fullBusinessSaveTested:false},
};assert.equal(verification.totalTargetedPass,422);save(base+'verification.json',verification);
const sourcePaths=[...new Set([...previous.files.map(f=>f.path),
  'packages/sdk/src/browser-registration.ts','apps/model-designer/src/components/BrowserIdentityPanel.tsx','apps/model-designer/src/config/browser-identity-state.ts',
  'scripts/security-designer-identity-check.mjs','test/unit/security-designer-identity.test.ts','test/unit/security-designer-identity-report.test.mjs','test/integration/security-designer-identity-browser.test.ts',
])].sort();
const files=sourcePaths.map(p=>({...descriptor(p),sha256Lf:hash(read(p).toString('utf8').replace(/\r\n/g,'\n'))}));
const verificationArtifacts=[];function walk(dir){for(const name of readdirSync(dir).sort()){const p=join(dir,name).replace(/\\/g,'/'),s=lstatSync(p);assert.equal(s.isSymbolicLink(),false);if(s.isDirectory())walk(p);else if(p!==base+'acceptance.json')verificationArtifacts.push(descriptor(p));}}walk(base);
save(base+'acceptance.json',{format:'modeldb.security-release-recheck.v1',revision:'SEC-M7-D24',task:'DR-P3.2',date:verification.date,baseCommit:previous.baseCommit,purpose:'Formal same-origin Designer registration and Passkey state UI; bounded JSON import, memory-only continuation, native DPAPI/Pipe and localized Chrome validation. No production migration or physical Hello acceptance.',verification:{status:'passed',report:base+'verification.json'},currentResults:{...Object.fromEntries(Object.entries(units).map(([key,u])=>[key+'Pass',u.pass])),nativePass:3,totalTargetedPass:422,skip:0,registration:'13/23',registrationP3:'2/6',registrationWorkPackages:'2/4'},files,historicalEvidence,verificationArtifacts});
console.log(JSON.stringify({ok:true,developmentFiles:files.length,historicalEvidence:historicalEvidence.length,verificationArtifacts:verificationArtifacts.length,totalTargetedPass:422}));
