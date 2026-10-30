/** Bind current D25 development sources and checks; never rewrite historical evidence. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,readdirSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseHostingIntegrationTap,nativeChecks,browserChecks} from '../../../../scripts/security-hosting-integration-check.mjs';
import {parseIdentityBrowserTap,identityBrowserChecks} from '../../../../scripts/security-designer-identity-check.mjs';
import {parseIdentityAdminTap,identityAdminChecks} from '../../../../scripts/security-identity-admin-check.mjs';
const base='docs/security-v1-deliveries/evidence/SEC-M7-D25/';
const read=p=>readFileSync(p),json=p=>JSON.parse(read(p)),save=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n');
const hash=b=>createHash('sha256').update(b).digest('hex'),descriptor=p=>({path:p,sha256:hash(read(p))});
const previousPath='docs/security-v1-deliveries/evidence/SEC-M7-D24/acceptance.json',previous=json(previousPath);
const hosting=json(base+'integration-check.json'),identity=json(base+'identity-integration-check.json'),admin=json(base+'admin-integration-check.json');
for(const report of [hosting,identity,admin])assert.equal(report.ok,true);
const native=parseHostingIntegrationTap(read(base+'native.original.txt').toString('utf8'),hosting.exitCode);
const ui=parseIdentityBrowserTap(read(base+'identity-native.original.txt').toString('utf8'),identity.exitCode);
const management=parseIdentityAdminTap(read(base+'admin-native.original.txt').toString('utf8'),admin.exitCode);
assert.deepEqual(native.unit,hosting.unit);assert.deepEqual(native.native,hosting.native);assert.deepEqual(native.browser,hosting.browser);
assert.deepEqual(ui.unit,identity.unit);assert.deepEqual(ui.browser,identity.browser);assert.deepEqual(management.unit,admin.unit);assert.deepEqual(management.browser,admin.browser);
const groups=[['hostingUnit','hosting',36],['identityUnit','identity',24],['identityAdminUnit','identity-admin',14],['authenticationUnit','authentication',55],['dynamicUnit','dynamic',42],['regressionUnit','regression',169],['maintenanceUnit','maintenance',33],['toolsUnit','tools',43],['launchCompatibilityUnit','launch-compat',19]];
const units={};for(const [key,name,count] of groups){
  const tap=read(base+name+'.original.txt').toString('utf8');assert.doesNotMatch(tap,/^not ok |^#.*(?:SKIP|TODO)\b/m);
  for(const [label,value] of [['tests',count],['pass',count],['fail',0],['cancelled',0],['skipped',0],['todo',0]]){const matches=[...tap.matchAll(new RegExp('^# '+label+' (\\d+)\\s*$','gm'))];assert.equal(matches.length,1);assert.equal(Number(matches[0][1]),value);}
  units[key]={pass:count,fail:0,skip:0,cancelled:0,todo:0};
}
assert.ok(json(base+'static-commands.json').every(c=>c.exitCode===0));
const types=json(base+'types.original.txt'),consumer=json(base+'consumer-native.original.txt');
assert.equal(types.ok,true);assert.equal(types.checks.strictIdentityAdminTypecheck,true);assert.equal(consumer.ok,true);assert.equal(consumer.checks.entireDesignerTypecheck,true);
const historicalEvidence=[...previous.historicalEvidence,...previous.verificationArtifacts,descriptor(previousPath)];
assert.equal(historicalEvidence.length,448);
for(const file of historicalEvidence)assert.equal(hash(read(file.path)),file.sha256,'Historical bytes changed: '+file.path);
// Create explicitly pending local documents solely to resolve the final report's circular links.
// No passed receipt exists until all checks, including the actual link scan, succeed below.
for(const name of ['verification.json','acceptance.json'])if(!existsSync(base+name))save(base+name,{status:'pending-document-validation'});
const documentation=spawnSync(process.execPath,[base+'document-check.mjs'],{encoding:'utf8',windowsHide:true});
assert.equal(documentation.status,0,documentation.stdout+documentation.stderr);
const documents=json(base+'documents.original.json.txt');assert.equal(documents.ok,true);assert.equal(documents.completedRegistrationTasks,14);
const verification={format:'modeldb.security-identity-admin-verification.v1',revision:'SEC-M7-D25',task:'DR-P3.3',date:'2026-10-27',timezone:'America/New_York',baseCommit:previous.baseCommit,node:process.version,browserNode:admin.node,platform:process.platform,
  tasks:{v1Milestones:'7/7',v1:'20/20',registration:'14/23',registrationP1:'6/6',registrationP2:'5/5',registrationP3:'3/6',registrationWorkPackages:'2/4'},...units,nativeUnit:native.unit,identityNativeUnit:ui.unit,identityAdminNativeUnit:management.unit,
  totalTargetedPass:Object.values(units).reduce((n,u)=>n+u.pass,native.unit.pass+ui.unit.pass+management.unit.pass),
  checks:Object.fromEntries([...new Set([...nativeChecks,...browserChecks,...identityBrowserChecks,...identityAdminChecks,'strictHostingTypes','serverTypecheck','designerTypecheck','browserBoundary','scopedFormatting','scopedLint','staticSnapshot','managementLifetimes','materialGuard'])].map(k=>[k,true])),
  documentValidation:documents,historicalEvidenceVerified:historicalEvidence.length,
  scope:{temporarySyntheticOnly:true,liveMaterialRead:false,productionMigrationPerformed:false,physicalAuthenticatorTested:false,performanceTested:false,fullReleaseInstallTested:false,physicalDiskFullTested:false,tlsHostedBrowserTested:true,remoteTlsHostedBrowserTested:false,lanTested:false,uiChanged:true,newRegistrationUiImplemented:true,identityMaintenanceUiImplemented:true,defaultOsBrowserAutomationTested:false,fullBusinessSaveTested:false},
};assert.equal(verification.totalTargetedPass,439);save(base+'verification.json',verification);
const sourcePaths=[...new Set([...previous.files.map(f=>f.path),
  'packages/shared/src/registered-identity-admin.ts','packages/sdk/src/security-center.ts','apps/model-designer/src/components/RegisteredIdentityPanel.tsx',
  'scripts/security-identity-admin-check.mjs','scripts/security-registration-consumer-check.mjs',
  'test/unit/security-identity-admin.test.ts','test/unit/security-identity-admin-report.test.mjs','test/integration/security-identity-admin-browser.test.ts',
])].sort();
const files=sourcePaths.map(p=>({...descriptor(p),sha256Lf:hash(read(p).toString('utf8').replace(/\r\n/g,'\n'))}));
const verificationArtifacts=[];function walk(dir){for(const name of readdirSync(dir).sort()){const p=join(dir,name).replace(/\\/g,'/'),s=lstatSync(p);assert.equal(s.isSymbolicLink(),false);if(s.isDirectory())walk(p);else if(p!==base+'acceptance.json')verificationArtifacts.push(descriptor(p));}}walk(base);
save(base+'acceptance.json',{format:'modeldb.security-release-recheck.v1',revision:'SEC-M7-D25',task:'DR-P3.3',date:verification.date,baseCommit:previous.baseCommit,purpose:'Dedicated loopback OS-paired approval and registered identity maintenance UI, exact grants, CAS confirmation, conflict recovery, sessions and localized native browser evidence. No production migration or physical Hello acceptance.',verification:{status:'passed',report:base+'verification.json'},currentResults:{...Object.fromEntries(Object.entries(units).map(([key,u])=>[key+'Pass',u.pass])),nativePass:4,totalTargetedPass:439,skip:0,registration:'14/23',registrationP3:'3/6',registrationWorkPackages:'2/4'},files,historicalEvidence,verificationArtifacts});
console.log(JSON.stringify({ok:true,developmentFiles:files.length,historicalEvidence:historicalEvidence.length,verificationArtifacts:verificationArtifacts.length,totalTargetedPass:439}));
