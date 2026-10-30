/** Bind current D27 development sources and checks; never rewrite historical evidence. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,readdirSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseHostingIntegrationTap,nativeChecks,browserChecks} from '../../../../scripts/security-hosting-integration-check.mjs';
import {parseIdentityBrowserTap,identityBrowserChecks} from '../../../../scripts/security-designer-identity-check.mjs';
import {parseDeploymentTap,deploymentChecks} from '../../../../scripts/security-deployment-wizard-check.mjs';
import {parseIdentityAdminTap,identityAdminChecks} from '../../../../scripts/security-identity-admin-check.mjs';
import {parsePublicClientsTap,publicClientChecks} from '../../../../scripts/security-public-clients-check.mjs';
const base='docs/security-v1-deliveries/evidence/SEC-M7-D27/';
const read=p=>readFileSync(p),json=p=>JSON.parse(read(p)),save=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n');
const hash=b=>createHash('sha256').update(b).digest('hex'),descriptor=p=>({path:p,sha256:hash(read(p))});
const previousPath='docs/security-v1-deliveries/evidence/SEC-M7-D26/acceptance.json',previous=json(previousPath);
const hosting=json(base+'integration-check.json'),identity=json(base+'identity-integration-check.json'),admin=json(base+'admin-integration-check.json');
for(const report of [hosting,identity,admin])assert.equal(report.ok,true);
const native=parseHostingIntegrationTap(read(base+'native.original.txt').toString('utf8'),hosting.exitCode);
const ui=parseIdentityBrowserTap(read(base+'identity-native.original.txt').toString('utf8'),identity.exitCode);
const management=parseIdentityAdminTap(read(base+'admin-native.original.txt').toString('utf8'),admin.exitCode);
assert.deepEqual(native.unit,hosting.unit);assert.deepEqual(native.native,hosting.native);assert.deepEqual(native.browser,hosting.browser);
assert.deepEqual(ui.unit,identity.unit);assert.deepEqual(ui.browser,identity.browser);assert.deepEqual(management.unit,admin.unit);assert.deepEqual(management.browser,admin.browser);
const deployment=json(base+'deployment-integration-check.json');assert.equal(deployment.ok,true);
const wizard=parseDeploymentTap(read(base+'deployment-native.original.txt').toString('utf8'),deployment.exitCode);assert.deepEqual(wizard.unit,deployment.unit);assert.deepEqual(wizard.browser,deployment.browser);
const publicReport=json(base+'public-integration-check.json');assert.equal(publicReport.ok,true);const publicResult=parsePublicClientsTap(read(base+'public-native.original.txt').toString('utf8'),publicReport.exitCode);assert.deepEqual(publicResult.unit,publicReport.unit);assert.deepEqual(publicResult.browsers,publicReport.browsers);
const groups=[['hostingUnit','hosting',36],['identityUnit','identity',31],['identityAdminUnit','identity-admin',14],['authenticationUnit','authentication',55],['dynamicUnit','dynamic',42],['regressionUnit','regression',169],['maintenanceUnit','maintenance',33],['toolsUnit','tools',47],['deploymentUnit','deployment',22],['launchCompatibilityUnit','launch-compat',19],['publicReportUnit','public-report',4]];
const units={};for(const [key,name,count] of groups){
  const tap=read(base+name+'.original.txt').toString('utf8');assert.doesNotMatch(tap,/^not ok |^#.*(?:SKIP|TODO)\b/m);
  for(const [label,value] of [['tests',count],['pass',count],['fail',0],['cancelled',0],['skipped',0],['todo',0]]){const matches=[...tap.matchAll(new RegExp('^# '+label+' (\\d+)\\s*$','gm'))];assert.equal(matches.length,1);assert.equal(Number(matches[0][1]),value);}
  units[key]={pass:count,fail:0,skip:0,cancelled:0,todo:0};
}
assert.ok(json(base+'static-commands.json').every(c=>c.exitCode===0));
const types=json(base+'types.original.txt'),consumer=json(base+'consumer-native.original.txt');
assert.equal(types.ok,true);assert.equal(types.checks.strictIdentityAdminTypecheck,true);assert.equal(types.checks.strictDeploymentWizardTypecheck,true);assert.equal(consumer.ok,true);assert.equal(consumer.checks.entireDesignerTypecheck,true);
const historicalEvidence=[...previous.historicalEvidence,...previous.verificationArtifacts,descriptor(previousPath)];
assert.equal(historicalEvidence.length,684);
for(const file of historicalEvidence)assert.equal(hash(read(file.path)),file.sha256,'Historical bytes changed: '+file.path);
// Create explicitly pending local documents solely to resolve the final report's circular links.
// No passed receipt exists until all checks, including the actual link scan, succeed below.
for(const name of ['verification.json','acceptance.json'])if(!existsSync(base+name))save(base+name,{status:'pending-document-validation'});
const documentation=spawnSync(process.execPath,[base+'document-check.mjs'],{encoding:'utf8',windowsHide:true});
assert.equal(documentation.status,0,documentation.stdout+documentation.stderr);
const documents=json(base+'documents.original.json.txt');assert.equal(documents.ok,true);assert.equal(documents.completedRegistrationTasks,16);
const verification={format:'modeldb.security-public-clients-verification.v1',revision:'SEC-M7-D27',task:'DR-P3.5',date:'2026-10-28',timezone:'America/New_York',baseCommit:previous.baseCommit,node:process.version,browserNode:admin.node,platform:process.platform,
  tasks:{v1Milestones:'7/7',v1:'20/20',registration:'16/23',registrationP1:'6/6',registrationP2:'5/5',registrationP3:'5/6',registrationWorkPackages:'2/4'},...units,nativeUnit:native.unit,identityNativeUnit:ui.unit,identityAdminNativeUnit:management.unit,deploymentNativeUnit:wizard.unit,publicNativeUnit:publicResult.unit,
  totalTargetedPass:Object.values(units).reduce((n,u)=>n+u.pass,native.unit.pass+ui.unit.pass+management.unit.pass+wizard.unit.pass+publicResult.unit.pass),
  checks:Object.fromEntries([...new Set([...nativeChecks,...browserChecks,...identityBrowserChecks,...identityAdminChecks,...deploymentChecks,...publicClientChecks,'strictHostingTypes','serverTypecheck','designerTypecheck','browserBoundary','scopedFormatting','scopedLint','staticSnapshot','managementLifetimes','materialGuard'])].map(k=>[k,true])),
  documentValidation:documents,historicalEvidenceVerified:historicalEvidence.length,
  scope:{temporarySyntheticOnly:true,liveMaterialRead:false,productionMigrationPerformed:false,physicalAuthenticatorTested:false,performanceTested:false,fullReleaseInstallTested:false,physicalDiskFullTested:false,tlsHostedBrowserTested:true,remoteTlsHostedBrowserTested:false,lanTested:false,uiChanged:true,deploymentWizardUiImplemented:true,offlineCrossFileAtomicityClaimed:false,newRegistrationUiImplemented:true,identityMaintenanceUiImplemented:true,defaultOsBrowserAutomationTested:false,fullBusinessSaveTested:false},
};assert.equal(verification.totalTargetedPass,480);save(base+'verification.json',verification);
const sourcePaths=[...new Set([...previous.files.map(f=>f.path),
  'packages/shared/src/deployment-wizard.ts','packages/server/src/security/deployment-wizard.ts','packages/server/src/security/deployment-files.ts','packages/server/src/cli-security-deployment.ts','packages/server/src/security/security-control.ts','packages/server/src/cli-security.ts','packages/server/src/dual-track-app.ts','apps/model-designer/src/components/DeploymentWizardPanel.tsx','apps/model-designer/src/styles/deployment-wizard.css','scripts/security-deployment-wizard-check.mjs','test/unit/security-deployment-wizard.test.ts','test/unit/security-deployment-wizard-report.test.mjs','test/integration/security-deployment-wizard-browser.test.ts','docs/security-v1/device-registration-deployment-contract.md','packages/shared/src/registered-identity-admin.ts','packages/sdk/src/security-center.ts','apps/model-designer/src/components/RegisteredIdentityPanel.tsx',
  'test/integration/security-browser-apps.test.ts','packages/sdk/src/browser-identity-client.ts','packages/data-ui/src/index.ts','packages/data-ui/src/components/browser-identity-panel.tsx','packages/data-ui/src/components/browser-identity-panel.css','packages/data-ui/scripts/copy-css.mjs','apps/data-studio/src/components/ConnectionPanel.tsx','apps/data-studio/src/styles/studio-shell.css','apps/web/src/App.tsx','apps/web/src/index.css','apps/web/src/i18n/messages.ts',...['zh','en','ja'].map(l=>'apps/data-studio/src/i18n/locales/'+l+'/ui.json'),'scripts/security-public-clients-check.mjs','test/unit/security-public-clients-report.test.mjs','test/integration/security-public-clients-browser.test.ts',
  'scripts/security-identity-admin-check.mjs','scripts/security-registration-consumer-check.mjs',
  'test/unit/security-identity-admin.test.ts','test/unit/security-identity-admin-report.test.mjs','test/integration/security-identity-admin-browser.test.ts',
])].sort();
const files=sourcePaths.map(p=>({...descriptor(p),sha256Lf:hash(read(p).toString('utf8').replace(/\r\n/g,'\n'))}));
const verificationArtifacts=[];function walk(dir){for(const name of readdirSync(dir).sort()){const p=join(dir,name).replace(/\\/g,'/'),s=lstatSync(p);assert.equal(s.isSymbolicLink(),false);if(s.isDirectory())walk(p);else if(p!==base+'acceptance.json')verificationArtifacts.push(descriptor(p));}}walk(base);
save(base+'acceptance.json',{format:'modeldb.security-release-recheck.v1',revision:'SEC-M7-D27',task:'DR-P3.5',date:verification.date,baseCommit:previous.baseCommit,purpose:'Shared browser identity client and lifecycle, SDK/browser dependency boundaries, reusable localized identity panel, Studio/Web Passkey registration/login and actual library connection, three-application pairing/application credential regression. Synthetic loopback only; no production migration, installed trust or hardware claim.',verification:{status:'passed',report:base+'verification.json'},currentResults:{...Object.fromEntries(Object.entries(units).map(([key,u])=>[key+'Pass',u.pass])),nativePass:8,totalTargetedPass:480,skip:0,registration:'16/23',registrationP3:'5/6',registrationWorkPackages:'2/4'},files,historicalEvidence,verificationArtifacts});
console.log(JSON.stringify({ok:true,developmentFiles:files.length,historicalEvidence:historicalEvidence.length,verificationArtifacts:verificationArtifacts.length,totalTargetedPass:480}));
