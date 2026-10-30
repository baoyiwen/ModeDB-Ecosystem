import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { it } from 'node:test';
import { verifyReleaseEvidence } from '../../scripts/security-release-evidence.mjs';
import { nativeChecks, browserChecks } from '../../scripts/security-hosting-integration-check.mjs';
import { identityBrowserChecks } from '../../scripts/security-designer-identity-check.mjs';
import {deploymentChecks} from '../../scripts/security-deployment-wizard-check.mjs';

const historical = 'docs/security-v1-deliveries/evidence/SEC-M7-D02/';
const current = 'docs/security-v1-deliveries/evidence/SEC-M7-D11/';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ModeDB-Evidence-Test-'));
  const write = (path, bytes) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); };
  const save = (path, value) => write(path, JSON.stringify(value));
  const descriptor = path => ({ path, sha256: sha(readFileSync(join(root, path))) });
  // Historical reports are public development evidence; never copy instance state.
  const historicalEvidence = readdirSync(resolve(historical)).map(name => {
    write(historical + name, readFileSync(resolve(historical, name)));
    return descriptor(historical + name);
  });
  const screenshot = 'docs/security-v1-deliveries/evidence/SEC-M7-D10/screenshots/synthetic.png';
  write(screenshot, Buffer.from([137, 80, 78, 71]));
  historicalEvidence.push(descriptor(screenshot));
  const source = 'apps/example/src/index.ts';
  write(source, 'export const synthetic = true;\n');
  write('apps/example/index.html', '<main>synthetic</main>');
  write('apps/example/public/favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const candidate = { packages: Array(7).fill({}), apps: Array(3).fill({}), checks: { frontendBuild: { configFile: false, envFile: false } } };
  save(current + 'release-candidate.json', candidate);
  save(current + 'release-candidate.original.json.txt', candidate);
  const candidateSha256 = descriptor(current + 'release-candidate.json').sha256;
  save(current + 'regression.json', { unit: { pass: 1, fail: 0, skip: 0, cancelled: 0, todo: 0 }, results: Array(7).fill({ exitCode: 0 }) });
  save(current + 'browser.json', { pass: 2, fail: 0, skip: 0 });
  save(current + 'performance.json', { releaseManifestSha256: candidateSha256, checks: { installedPackageHashes: true, frontendAndDocumentHashes: true, performanceWithinBaseline: true } });
  write(current + 'performance.original.json.txt', readFileSync(join(root, current + 'performance.json')));
  save(current + 'verification.json', {
    format: 'modeldb.security-s72-revalidation.v1', candidateSha256,
    checks: Object.fromEntries(['unitRegression','engineIntegrations','browserAcceptance','typechecks','isolatedCandidate','installedLifecycle','performanceWithinBaseline','documentsAndI18n'].map(key => [key, true])),
  });
  const receipt = {
    format: 'modeldb.security-release-recheck.v1', revision: 'SEC-M7-D11',
    verification: { status: 'passed', report: current + 'verification.json' },
    files: [{ ...descriptor(source), sha256Lf: descriptor(source).sha256 }, descriptor('apps/example/index.html'), descriptor('apps/example/public/favicon.svg')],
    historicalEvidence,
    verificationArtifacts: [...['release-candidate','regression','browser','performance','verification'].map(name => descriptor(current + name + '.json')), ...['release-candidate','performance'].map(name => descriptor(current + name + '.original.json.txt'))],
  };
  const update = () => save(current + 'acceptance.json', receipt);
  update();
  return { root, write, save, descriptor, source, screenshot, receipt, update };
}

it('selects the current receipt and allows only development CRLF/LF differences', () => {
  const item = fixture();
  item.write('tsconfig.json', '{"compilerOptions":{"strict":true}}');
  item.receipt.files.push(item.descriptor('tsconfig.json'));
  const fullTap = 'docs/security-v1-deliveries/evidence/SEC-M7-D32/browser/hosting.tap';
  item.write(fullTap, 'TAP version 13\n');
  item.receipt.files.push(item.descriptor(fullTap));
  for (const extension of ['crt', 'key']) {
    const publicFixture = 'test/fixtures/security-tls/localhost.' + extension;
    item.write(publicFixture, 'public synthetic fixture');
    item.receipt.files.push(item.descriptor(publicFixture));
  }
  item.update();
  item.write(item.source, 'export const synthetic = true;\r\n');
  const result = verifyReleaseEvidence(item.root);
  assert.equal(result.revision, 'SEC-M7-D11');
  assert.equal(result.normalizedFiles, 1);
  assert.equal(result.currentRevalidation, 'passed');
  assert.equal(result.runtimeMaterialRead, false);
});

it('rejects changed source text', () => {
  const item = fixture();
  item.write(item.source, 'export const synthetic = false;\n');
  assert.throws(() => verifyReleaseEvidence(item.root), /EVIDENCE_SOURCE_CHANGED/);
});

it('rejects changed historical screenshot bytes', () => {
  const item = fixture();
  item.write(item.screenshot, 'changed synthetic screenshot');
  assert.throws(() => verifyReleaseEvidence(item.root), /EVIDENCE_REPORT_CHANGED/);
});

it('rejects modified verification artifacts', () => {
  const item = fixture();
  item.save(current + 'browser.json', { pass: 2, fail: 1, skip: 0 });
  assert.throws(() => verifyReleaseEvidence(item.root), /EVIDENCE_REPORT_CHANGED/);
});

it('does not accept skipped tests even with matching artifact hashes', () => {
  const item = fixture();
  item.save(current + 'regression.json', { unit: { pass: 1, fail: 0, skip: 1, cancelled: 0, todo: 0 }, results: Array(7).fill({ exitCode: 0 }) });
  item.receipt.verificationArtifacts = item.receipt.verificationArtifacts.map(file => item.descriptor(file.path));
  item.update();
  assert.throws(() => verifyReleaseEvidence(item.root), /EVIDENCE_CURRENT_UNIT_INCOMPLETE/);
});

it('rejects runtime and traversal paths before opening them', () => {
  for (const path of ['security/instance.key', 'docs/../../security/registry.mds', 'modeldb.config.registry.local.json', 'certs/localhost.key', 'test/fixtures/security-tls/other.key']) {
    const item = fixture();
    item.receipt.files[0].path = path;
    item.update();
    assert.throws(() => verifyReleaseEvidence(item.root), /EVIDENCE_DEVELOPMENT_PATH_REQUIRED/);
  }
});

it('rejects linked source ancestors', () => {
  const item = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'ModeDB-Evidence-Link-'));
  writeFileSync(join(outside, 'index.ts'), 'synthetic linked file');
  symlinkSync(outside, join(item.root, 'apps/example/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  item.receipt.files[0].path = 'apps/example/linked/index.ts';
  item.update();
  assert.throws(() => verifyReleaseEvidence(item.root), /EVIDENCE_LINK_REJECTED/);
});

it('fails closed for incomplete newest evidence and duplicate source paths', () => {
  const item = fixture();
  item.receipt.verification.status = 'pending';
  item.update();
  assert.throws(() => verifyReleaseEvidence(item.root), /EVIDENCE_VERIFICATION_INCOMPLETE/);
  item.receipt.verification.status = 'passed';
  item.receipt.files.push(item.receipt.files[0]);
  item.update();
  assert.throws(() => verifyReleaseEvidence(item.root), /EVIDENCE_DUPLICATE_PATH/);
});

function registrationFixture() {
  const item = fixture();
  const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D12/';
  const verification = {
    format: 'modeldb.security-registration-contract-verification.v1',
    task: 'DR-P1.1', tasks: { registration: '1/23' }, runtimeRegistrationImplemented: false,
    unit: { pass: 18, fail: 0, skip: 0, cancelled: 0, todo: 0 },
    checks: { isolatedDnsTls: true, scopedFormatting: true, scopedLint: true },
    documentValidation: { ok: true },
  };
  item.write('test/fixtures/security-registration-tls/modeldb-a.crt', 'public synthetic fixture');
  const receipt = {
    ...item.receipt, revision: 'SEC-M7-D12',
    verification: { status: 'passed', report: base + 'verification.json' },
    files: [...item.receipt.files, {
      ...item.descriptor('test/fixtures/security-registration-tls/modeldb-a.crt'),
      sha256Lf: item.descriptor('test/fixtures/security-registration-tls/modeldb-a.crt').sha256,
    }],
    historicalEvidence: [...item.receipt.historicalEvidence, item.descriptor(current + 'acceptance.json')],
  };
  const update = () => {
    item.save(base + 'verification.json', verification);
    receipt.verificationArtifacts = [item.descriptor(base + 'verification.json')];
    item.save(base + 'acceptance.json', receipt);
  };
  update();
  return { ...item, verification, receipt, update };
}

it('verifies a registration-contract receipt separately from historical runtime acceptance', () => {
  const item = registrationFixture();
  const result = verifyReleaseEvidence(item.root);
  assert.equal(result.revision, 'SEC-M7-D12');
  assert.equal(result.currentRevalidation, 'passed');
  item.write('test/fixtures/security-registration-tls/modeldb-a.crt', 'tampered fixture');
  assert.throws(() => verifyReleaseEvidence(item.root), /EVIDENCE_SOURCE_CHANGED/);
});

it('rejects incomplete registration evidence without falling back to a passed D11 receipt', () => {
  for (const mutate of [
    (v) => { v.unit.skip = 1; },
    (v) => { v.checks.isolatedDnsTls = false; },
    (v) => { v.runtimeRegistrationImplemented = true; },
    (v) => { v.documentValidation.ok = false; },
  ]) {
    const item = registrationFixture();
    mutate(item.verification);
    item.update();
    assert.throws(() => verifyReleaseEvidence(item.root));
  }
});

function protocolFixture() {
  const item = registrationFixture();
  const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D13/';
  const lock = 'scripts/security-registration-dependencies/pnpm-lock.yaml';
  item.write(lock, 'synthetic locked graph\n');
  const verification = {
    format: 'modeldb.security-registration-protocol-verification.v1', task: 'DR-P1.2',
    tasks: { registration: '2/23' }, runtimeRegistrationImplemented: false,
    unit: { pass: 29, fail: 0, skip: 0, cancelled: 0, todo: 0 },
    checks: Object.fromEntries(['scopedFormatting', 'scopedLint', 'sharedTypecheck', 'sdkTypecheck', 'browserBoundary', 'offlineDependencyInstall'].map(key => [key, true])),
    documentValidation: { ok: true },
  };
  const dependency = { ok: true, library: { version: '14.0.3' }, packages: Array(25).fill({}),
    lockSha256Lf: item.descriptor(lock).sha256, offlineInstall: { exitCode: 0, downloaded: 0 },
    checks: { malformedProofRejected: true } };
  const receipt = { ...item.receipt, revision: 'SEC-M7-D13',
    files: [...item.receipt.files, { ...item.descriptor(lock), sha256Lf: item.descriptor(lock).sha256 }],
    historicalEvidence: [...item.receipt.historicalEvidence, item.descriptor('docs/security-v1-deliveries/evidence/SEC-M7-D12/acceptance.json')],
    verification: { status: 'passed', report: base + 'verification.json' },
  };
  const update = () => {
    item.save(base + 'verification.json', verification);
    item.save(base + 'dependency-check.json', dependency);
    receipt.verificationArtifacts = ['verification.json', 'dependency-check.json'].map(name => item.descriptor(base + name));
    item.save(base + 'acceptance.json', receipt);
  };
  update();
  return { ...item, verification, dependency, receipt, update, lock };
}

it('validates protocol evidence and the separately locked offline dependency graph', () => {
  const item = protocolFixture();
  assert.equal(verifyReleaseEvidence(item.root).revision, 'SEC-M7-D13');
  item.write(item.lock, 'changed graph\n');
  assert.throws(() => verifyReleaseEvidence(item.root), /EVIDENCE_SOURCE_CHANGED/);
});

it('fails closed for protocol skips, unavailable offline install and unverified browser boundary', () => {
  for (const mutate of [
    item => { item.verification.unit.skip = 1; },
    item => { item.verification.checks.browserBoundary = false; },
    item => { item.dependency.offlineInstall.exitCode = 1; },
    item => { item.dependency.offlineInstall.downloaded = 1; },
    item => { item.dependency.lockSha256Lf = '0'.repeat(64); },
  ]) {
    const item = protocolFixture();
    mutate(item);
    item.update();
    assert.throws(() => verifyReleaseEvidence(item.root));
  }
});

function storageFixture() {
  const item = protocolFixture();
  const base = 'docs/security-v1-deliveries/evidence/SEC-M7-D14/';
  const unit = { pass: 23, fail: 0, skip: 0, cancelled: 0, todo: 0 };
  const verification = {
    format: 'modeldb.security-registration-storage-verification.v1', task: 'DR-P1.3',
    tasks: { registration: '3/23' }, runtimeRegistrationImplemented: false, registrationStorageImplemented: true,
    unit: { ...unit }, storageUnit: { ...unit }, legacyRegistryUnit: { ...unit }, evidenceToolUnit: { ...unit },
    checks: Object.fromEntries(['defaultDisabled', 'atomicMigration', 'oldReaderRefusesV2', 'isolatedDpapi', 'hardExitRecovery',
      'serverTypecheck', 'strictStorageTypes', 'browserBoundary', 'scopedFormatting', 'scopedLint'].map(key => [key, true])),
    documentValidation: { ok: true },
  };
  const receipt = { ...item.receipt, revision: 'SEC-M7-D14',
    verification: { status: 'passed', report: base + 'verification.json' },
    historicalEvidence: [...item.receipt.historicalEvidence, item.descriptor('docs/security-v1-deliveries/evidence/SEC-M7-D13/acceptance.json')],
  };
  const update = () => {
    item.save(base + 'verification.json', verification);
    receipt.verificationArtifacts = [item.descriptor(base + 'verification.json')];
    item.save(base + 'acceptance.json', receipt);
  };
  update(); return { ...item, verification, receipt, update };
}

it('verifies storage acceptance without turning it into runtime registration acceptance', () => {
  const item = storageFixture();
  assert.equal(verifyReleaseEvidence(item.root).revision, 'SEC-M7-D14');
  item.verification.runtimeRegistrationImplemented = true; item.update();
  assert.throws(() => verifyReleaseEvidence(item.root));
});

it('does not fall back to D13 for skipped storage, failed legacy compatibility or missing DPAPI/hard-exit evidence', () => {
  for (const mutate of [
    v => { v.storageUnit.skip = 1; }, v => { v.legacyRegistryUnit.fail = 1; },
    v => { v.checks.oldReaderRefusesV2 = false; }, v => { v.checks.isolatedDpapi = false; },
    v => { v.checks.hardExitRecovery = false; }, v => { v.registrationStorageImplemented = false; },
  ]) {
    const item = storageFixture(); mutate(item.verification); item.update();
    assert.throws(() => verifyReleaseEvidence(item.root));
  }
});

function apiFixture() {
  const item = storageFixture(), base = 'docs/security-v1-deliveries/evidence/SEC-M7-D15/';
  const unit = { pass: 20, fail: 0, skip: 0, cancelled: 0, todo: 0 };
  const verification = { format: 'modeldb.security-registration-api-verification.v1', task: 'DR-P1.4',
    tasks: { registration: '4/23' }, runtimeRegistrationImplemented: true, approvalImplemented: false, publicKeyLoginImplemented: false,
    unit: {...unit}, runtimeUnit: {...unit}, legacyRegistryUnit: {...unit}, networkUnit: {...unit}, evidenceToolUnit: {...unit},
    checks: Object.fromEntries(['defaultDisabled', 'sameOriginBeforeParsing', 'singleUseClaims', 'noSessionsOrGrants', 'privateStatus',
      'expiryReclamation', 'boundedBudgetsAndQueue', 'nativeDpapiHttps', 'serverTypecheck', 'strictRuntimeTypes',
      'browserBoundary', 'scopedFormatting', 'scopedLint'].map(k=>[k,true])), documentValidation: {ok:true} };
  const dependency = {ok:true, library:{version:'14.0.3'}, packages:Array(25).fill({}),rootImporterExact:true,
    graphMatchesSelection:true,offlineInstall:{exitCode:0,downloaded:0}};
  item.write('pnpm-lock.yaml','synthetic root graph\n');
  dependency.rootLockSha256=item.descriptor('pnpm-lock.yaml').sha256;
  dependency.rootLockSha256Lf=dependency.rootLockSha256;
  const receipt={...item.receipt,revision:'SEC-M7-D15',verification:{status:'passed',report:base+'verification.json'},
    files:[...item.receipt.files,{...item.descriptor('pnpm-lock.yaml'),sha256Lf:dependency.rootLockSha256}],
    historicalEvidence:[...item.receipt.historicalEvidence,item.descriptor('docs/security-v1-deliveries/evidence/SEC-M7-D14/acceptance.json')]};
  const update=()=>{item.save(base+'verification.json',verification);item.save(base+'dependency-check.json',dependency);
    receipt.verificationArtifacts=['verification.json','dependency-check.json'].map(name=>item.descriptor(base+name));item.save(base+'acceptance.json',receipt);};
  update();return {...item,verification,dependency,receipt,update};
}
it('accepts registration API evidence without claiming approval or public-key login',()=>{
  const item=apiFixture();assert.equal(verifyReleaseEvidence(item.root).revision,'SEC-M7-D15');
  item.write('pnpm-lock.yaml','synthetic root graph\r\n');
  assert.equal(verifyReleaseEvidence(item.root).revision,'SEC-M7-D15');
  item.verification.approvalImplemented=true;item.update();assert.throws(()=>verifyReleaseEvidence(item.root));
});
it('refuses skipped runtime, missing native HTTPS or dependency drift without falling back to storage evidence',()=>{
  for(const mutate of [item=>{item.verification.runtimeUnit.skip=1;},item=>{item.verification.checks.nativeDpapiHttps=false;},
    item=>{item.dependency.graphMatchesSelection=false;},item=>{item.dependency.offlineInstall.downloaded=1;},
    item=>{item.dependency.rootLockSha256='0'.repeat(64);},
    item=>{item.dependency.rootLockSha256Lf='0'.repeat(64);},
    item=>{item.verification.publicKeyLoginImplemented=true;}]){
    const item=apiFixture();mutate(item);item.update();assert.throws(()=>verifyReleaseEvidence(item.root));
  }
});

function approvalFixture() {
  const item=apiFixture(),base='docs/security-v1-deliveries/evidence/SEC-M7-D16/';
  const unit={pass:21,fail:0,skip:0,cancelled:0,todo:0};
  const verification={format:'modeldb.security-registration-approval-verification.v1',task:'DR-P1.5',
    tasks:{registration:'5/23'},runtimeRegistrationImplemented:true,approvalImplemented:true,publicKeyLoginImplemented:false,
    unit:{...unit},approvalUnit:{...unit},legacyRegistryUnit:{...unit},networkUnit:{...unit},evidenceToolUnit:{...unit},
    checks:Object.fromEntries(['verifiedOsLocalOnly','exactScopes','atomicIdentityAndAudit','revisionConflicts',
      'terminalRejection','noPollingSession','approvalWriteFaults','legacyMissingGrantsDeny','nativeDpapiCli',
      'serverTypecheck','strictApprovalTypes','browserBoundary','scopedFormatting','scopedLint'].map(k=>[k,true])),documentValidation:{ok:true}};
  const receipt={...item.receipt,revision:'SEC-M7-D16',verification:{status:'passed',report:base+'verification.json'},
    historicalEvidence:[...item.receipt.historicalEvidence,item.descriptor('docs/security-v1-deliveries/evidence/SEC-M7-D15/acceptance.json')]};
  const update=()=>{item.save(base+'verification.json',verification);receipt.verificationArtifacts=[item.descriptor(base+'verification.json')];item.save(base+'acceptance.json',receipt);};
  update();return {...item,verification,receipt,update};
}
it('accepts OS-local approval evidence without claiming public-key login or full registration integration',()=>{
  const item=approvalFixture();assert.equal(verifyReleaseEvidence(item.root).currentTask,'DR-P1.5');
  item.verification.publicKeyLoginImplemented=true;item.update();assert.throws(()=>verifyReleaseEvidence(item.root));
});
it('refuses approval skips, failed OS identity, scopes, atomic audit or native CLI without falling back to D15',()=>{
  for(const mutate of [v=>{v.approvalUnit.skip=1;},v=>{v.approvalUnit.pass=20;},v=>{v.checks.verifiedOsLocalOnly=false;},
    v=>{v.checks.exactScopes=false;},v=>{v.checks.atomicIdentityAndAudit=false;},v=>{v.checks.nativeDpapiCli=false;},
    v=>{v.checks.noPollingSession=false;},v=>{v.approvalImplemented=false;}]){
    const item=approvalFixture();mutate(item.verification);item.update();assert.throws(()=>verifyReleaseEvidence(item.root));
  }
});

function integrationFixture(){
  const item=approvalFixture(),base='docs/security-v1-deliveries/evidence/SEC-M7-D17/';
  const unit={pass:9,fail:0,skip:0,cancelled:0,todo:0};
  const verification={format:'modeldb.security-registration-integration-verification.v1',task:'DR-P1.6',
    tasks:{registration:'6/23',registrationP1:'6/6',registrationWorkPackages:'1/4'},runtimeRegistrationImplemented:true,approvalImplemented:true,publicKeyLoginImplemented:false,
    unit:{...unit},integrationUnit:{...unit},legacyRegistryUnit:{...unit},networkUnit:{...unit},evidenceToolUnit:{...unit},reportToolUnit:{...unit},
    checks:Object.fromEntries(['fullRegistrationApproval','actualVirtualAuthenticator','nativeHttpsDpapiCli','pendingAndChallengeCapacity','localRepairAtCapacity','hardExitRecovery','atomicIdentityAndAudit','noBusinessSession','stableFailureReport','serverTypecheck','strictIntegrationTypes','browserBoundary','scopedFormatting','scopedLint'].map(k=>[k,true])),documentValidation:{ok:true}};
  const integration={ok:true,task:'DR-P1.6',exitCode:0,unit:{...unit},browser:{ok:true,browser:'Chrome/140.0',hardwareAuthenticatorTested:false,checks:Object.fromEntries(['actualBrowserWebAuthn','nativeHttpsDpapiCli','approval','proofRejected','singleUseCompetition','revisionConflict','outstandingChallengeCapacity1000','localRepairAtCapacity','restartWithRegistrationDisabled','noBusinessSession','instanceKeyUnchanged'].map(k=>[k,true]))},scope:{publicKeyLoginImplemented:false,liveMaterialRead:false,systemTrustInstalled:false}};
  const receipt={...item.receipt,revision:'SEC-M7-D17',verification:{status:'passed',report:base+'verification.json'},historicalEvidence:[...item.receipt.historicalEvidence,item.descriptor('docs/security-v1-deliveries/evidence/SEC-M7-D16/acceptance.json')]};
  const update=()=>{item.save(base+'verification.json',verification);item.save(base+'integration-check.json',integration);item.write(base+'integration.original.txt','Synthetic test evidence only\n');receipt.verificationArtifacts=['verification.json','integration-check.json','integration.original.txt'].map(n=>item.descriptor(base+n));item.save(base+'acceptance.json',receipt);};
  update();return {...item,verification,integration,receipt,update};
}
it('accepts full registration integration evidence separately from hardware and public-key login acceptance',()=>{
  const item=integrationFixture();assert.equal(verifyReleaseEvidence(item.root).currentTask,'DR-P1.6');
  item.verification.publicKeyLoginImplemented=true;item.update();assert.throws(()=>verifyReleaseEvidence(item.root));
});
it('rejects missing virtual/native, skipped flow, hard-exit, capacity or session evidence without falling back to D16',()=>{
  for(const mutate of [i=>{i.verification.integrationUnit.skip=1;},i=>{i.verification.integrationUnit.pass=8;},i=>{i.verification.checks.hardExitRecovery=false;},i=>{i.integration.browser.checks.actualBrowserWebAuthn=false;},i=>{i.integration.browser.checks.nativeHttpsDpapiCli=false;},i=>{i.integration.browser.checks.outstandingChallengeCapacity1000=false;},i=>{i.integration.browser.checks.noBusinessSession=false;},i=>{i.integration.browser.hardwareAuthenticatorTested=true;},i=>{i.integration.scope.liveMaterialRead=true;}]){
    const item=integrationFixture();mutate(item);item.update();assert.throws(()=>verifyReleaseEvidence(item.root));
  }
});

function sessionParentFixture(){
  const item=integrationFixture(),base='docs/security-v1-deliveries/evidence/SEC-M7-D18/';
  const unit={pass:35,fail:0,skip:0,cancelled:0,todo:0};
  const verification={format:'modeldb.security-session-parent-verification.v1',task:'DR-P2.1',
    tasks:{registration:'7/23',registrationP2:'1/5',registrationWorkPackages:'1/4'},publicKeyLoginImplemented:false,
    sessionParentUnit:{...unit},registrationUnit:{...unit,pass:95},registryUnit:{...unit,pass:13},compatibilityUnit:{...unit},toolsUnit:{...unit},
    checks:Object.fromEntries(['explicitMigration','namespaceSeparation','nativeWindowsMigration','legacyReaderRefusal','atomicMigrationRecovery','noPublicKeyIssuance','managementEmptyScope','offlineExpiryRecovery','serverTypecheck','strictSessionParentTypes','browserBoundary','scopedFormatting','scopedLint'].map(k=>[k,true])),documentValidation:{ok:true},scope:{liveMaterialRead:false,productionMigrationPerformed:false}};
  const receipt={...item.receipt,revision:'SEC-M7-D18',verification:{status:'passed',report:base+'verification.json'},historicalEvidence:[...item.receipt.historicalEvidence,item.descriptor('docs/security-v1-deliveries/evidence/SEC-M7-D17/acceptance.json')]};
  const update=()=>{
    item.save(base+'verification.json',verification);
    for(const [group,name] of [['sessionParentUnit','session-parent'],['registrationUnit','registration'],['registryUnit','registry'],['compatibilityUnit','compatibility'],['toolsUnit','tools']]){
      item.write(base+name+'.original.txt',`Synthetic test evidence only\n# tests ${verification[group].pass}\n# pass ${verification[group].pass}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`);
    }
    receipt.verificationArtifacts=['verification.json','session-parent.original.txt','registration.original.txt','registry.original.txt','compatibility.original.txt','tools.original.txt'].map(n=>item.descriptor(base+n));item.save(base+'acceptance.json',receipt);
  };
  update();return {...item,verification,receipt,update};
}
it('accepts explicit session-parent migration evidence without claiming a public-key login',()=>{
  const item=sessionParentFixture();assert.equal(verifyReleaseEvidence(item.root).currentTask,'DR-P2.1');
});
it('rejects incomplete or misbound session-parent evidence without falling back to D17',()=>{
  for(const mutate of [i=>{i.verification.sessionParentUnit.skip=1;},i=>{i.verification.sessionParentUnit.pass=34;},i=>{i.verification.checks.namespaceSeparation=false;},i=>{i.verification.checks.nativeWindowsMigration=false;},i=>{i.verification.checks.atomicMigrationRecovery=false;},i=>{i.verification.checks.managementEmptyScope=false;},i=>{i.verification.publicKeyLoginImplemented=true;},i=>{i.verification.scope.productionMigrationPerformed=true;}]){
    const item=sessionParentFixture();mutate(item);item.update();assert.throws(()=>verifyReleaseEvidence(item.root));
  }
  const item=sessionParentFixture();item.write('docs/security-v1-deliveries/evidence/SEC-M7-D18/session-parent.original.txt','# pass 34\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n');
  item.receipt.verificationArtifacts=item.receipt.verificationArtifacts.map(f=>item.descriptor(f.path));item.save('docs/security-v1-deliveries/evidence/SEC-M7-D18/acceptance.json',item.receipt);
  assert.throws(()=>verifyReleaseEvidence(item.root));
});

function authenticationEvidenceFixture(){
  const item=sessionParentFixture(),base='docs/security-v1-deliveries/evidence/SEC-M7-D19/';
  const unit=pass=>({pass,fail:0,skip:0,cancelled:0,todo:0});
  const verification={format:'modeldb.security-authentication-verification.v1',task:'DR-P2.2',tasks:{registration:'8/23',registrationP2:'2/5',registrationWorkPackages:'1/4'},publicKeyLoginImplemented:true,authenticationUnit:unit(54),regressionUnit:unit(169),toolsUnit:unit(28),checks:Object.fromEntries(['explicitV4Migration','realSignatures','singleUse','counterCompetition','proofQueueBounded','atomicLoginRecovery','httpCookieCsrf','registrationWindowIndependent','dataLifecycleManagementBoundary','serverTypecheck','strictAuthenticationTypes','browserBoundary','scopedFormatting','scopedLint'].map(k=>[k,true])),documentValidation:{ok:true},scope:{liveMaterialRead:false,productionMigrationPerformed:false}};
  const browser={format:'modeldb.authentication-browser.v1',ok:true,browser:'Chrome/156.0',checks:Object.fromEntries(['actualBrowserWebAuthnGet','freshSdkBundle','nativeTlsDpapiApproval','pendingDenied','httpOnlySecureStrict','dataScope','adminDenied','reloadRecovery','csrfRotation','logout','restartRecovery','disabledNewLogin','expiredRegistrationIndependent','noApiCredential','instanceKeyUnchanged'].map(k=>[k,true])),hardwareAuthenticatorTested:false,systemTrustInstalled:false};
  const report={ok:true,task:'DR-P2.2',exitCode:0,unit:unit(1),browser,scope:{liveMaterialRead:false,systemTrustInstalled:false}};
  const receipt={...item.receipt,revision:'SEC-M7-D19',verification:{status:'passed',report:base+'verification.json'},historicalEvidence:[...item.receipt.historicalEvidence,item.descriptor('docs/security-v1-deliveries/evidence/SEC-M7-D18/acceptance.json')]};
  const tap=pass=>`# tests ${pass}\n# pass ${pass}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
  const update=()=>{
    item.save(base+'verification.json',verification);item.save(base+'integration-check.json',report);
    item.write(base+'browser.original.txt',`# ${JSON.stringify(browser)}\n`+tap(1));
    for(const [group,name] of [['authenticationUnit','authentication'],['regressionUnit','regression'],['toolsUnit','tools']]){item.write(base+name+'.original.txt',tap(verification[group].pass));}
    receipt.verificationArtifacts=['verification.json','integration-check.json','browser.original.txt','authentication.original.txt','regression.original.txt','tools.original.txt'].map(n=>item.descriptor(base+n));item.save(base+'acceptance.json',receipt);
  };update();return {...item,verification,browser,report,receipt,update};
}
it('accepts native public-key login evidence with separate UI, hardware and production boundaries',()=>{
  assert.equal(verifyReleaseEvidence(authenticationEvidenceFixture().root).currentTask,'DR-P2.2');
});
it('rejects incomplete authentication evidence without falling back to D18',()=>{
  for(const mutate of [i=>{i.verification.authenticationUnit.skip=1;},i=>{i.verification.authenticationUnit.pass=53;},i=>{i.verification.checks.atomicLoginRecovery=false;},i=>{i.verification.checks.counterCompetition=false;},i=>{i.verification.checks.proofQueueBounded=false;},i=>{i.verification.checks.dataLifecycleManagementBoundary=false;},i=>{i.browser.checks.httpOnlySecureStrict=false;},i=>{i.browser.checks.csrfRotation=false;},i=>{i.report.exitCode=1;},i=>{i.verification.scope.productionMigrationPerformed=true;}]){
    const item=authenticationEvidenceFixture();mutate(item);item.update();assert.throws(()=>verifyReleaseEvidence(item.root));
  }
});

function dynamicEvidenceFixture(){
  const item=authenticationEvidenceFixture(),base='docs/security-v1-deliveries/evidence/SEC-M7-D20/';
  const unit=pass=>({pass,fail:0,skip:0,cancelled:0,todo:0});
  const verification={format:'modeldb.security-dynamic-authorization-verification.v1',task:'DR-P2.3',tasks:{registration:'9/23',registrationP2:'3/5',registrationWorkPackages:'1/4'},dynamicUnit:unit(42),authenticationUnit:unit(55),regressionUnit:unit(169),toolsUnit:unit(30),totalTargetedPass:297,checks:Object.fromEntries(['ownLiveGrants','credentialSubscriptions','userFanout','durableSessionRevocation','idleWsDeadline','queuedBeforeEngine','asyncFinalGuard','publicationScopeSet','compositeDelegation','partialCommitHonest','atomicRestrictionRecovery','auditFailureClosed','serverTypecheck','strictDynamicTypes','browserBoundary','scopedFormatting','scopedLint'].map(k=>[k,true])),documentValidation:{ok:true,completedRegistrationTasks:9},scope:{liveMaterialRead:false,productionMigrationPerformed:false,managementMaintenanceImplemented:false}};
  const receipt={...item.receipt,revision:'SEC-M7-D20',verification:{status:'passed',report:base+'verification.json'},historicalEvidence:[...item.receipt.historicalEvidence,item.descriptor('docs/security-v1-deliveries/evidence/SEC-M7-D19/acceptance.json')]};
  const tap=pass=>`# tests ${pass}\n# pass ${pass}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
  const update=()=>{
    item.save(base+'verification.json',verification);item.save(base+'integration-check.json',item.report);item.write(base+'browser.original.txt',`# ${JSON.stringify(item.browser)}\n`+tap(1));
    for(const [group,name] of [['dynamicUnit','dynamic'],['authenticationUnit','authentication'],['regressionUnit','regression'],['toolsUnit','tools']])item.write(base+name+'.original.txt',tap(verification[group].pass));
    receipt.verificationArtifacts=['verification.json','integration-check.json','browser.original.txt','dynamic.original.txt','authentication.original.txt','regression.original.txt','tools.original.txt'].map(n=>item.descriptor(base+n));item.save(base+'acceptance.json',receipt);
  };update();return {...item,verification,receipt,update};
}
it('accepts dynamic authorization evidence with live boundaries and preserves D19 as history',()=>{
  assert.equal(verifyReleaseEvidence(dynamicEvidenceFixture().root).currentTask,'DR-P2.3');
});
it('refuses incomplete dynamic authorization evidence without falling back to D19',()=>{
  for(const mutate of [i=>{i.verification.dynamicUnit.skip=1;},i=>{i.verification.dynamicUnit.pass=41;},i=>{i.verification.checks.userFanout=false;},i=>{i.verification.checks.queuedBeforeEngine=false;},i=>{i.verification.checks.compositeDelegation=false;},i=>{i.verification.checks.durableSessionRevocation=false;},i=>{i.verification.checks.partialCommitHonest=false;},i=>{i.verification.scope.managementMaintenanceImplemented=true;},i=>{i.verification.documentValidation.completedRegistrationTasks=8;},i=>{i.report.exitCode=1;},i=>{i.verification.totalTargetedPass++;}]) {
    const item=dynamicEvidenceFixture();mutate(item);item.update();assert.throws(()=>verifyReleaseEvidence(item.root));
  }
});

function maintenanceEvidenceFixture(){
  const item=dynamicEvidenceFixture(),base='docs/security-v1-deliveries/evidence/SEC-M7-D21/';
  const unit=pass=>({pass,fail:0,skip:0,cancelled:0,todo:0});
  const verification={...item.verification,format:'modeldb.security-registration-maintenance-verification.v1',task:'DR-P2.4',tasks:{registration:'10/23',registrationP2:'4/5',registrationWorkPackages:'1/4'},maintenanceUnit:unit(33),toolsUnit:unit(32),totalTargetedPass:332,checks:{...item.verification.checks,...Object.fromEntries(['verifiedOsLocalOnly','credentialUserSeparation','boundedMetadata','atomicReplacement','lostCredentialReapproval','newSignatureLogin','terminalRevocation','nativeDpapiCliMaintenance','maintenanceFaultRecovery','strictMaintenanceTypes'].map(k=>[k,true]))},documentValidation:{ok:true,completedRegistrationTasks:10},scope:{...item.verification.scope,managementMaintenanceImplemented:true}};
  const receipt={...item.receipt,revision:'SEC-M7-D21',verification:{status:'passed',report:base+'verification.json'},historicalEvidence:[...item.receipt.historicalEvidence,item.descriptor('docs/security-v1-deliveries/evidence/SEC-M7-D20/acceptance.json')]};
  const tap=pass=>`# tests ${pass}\n# pass ${pass}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
  const update=()=>{
    item.save(base+'verification.json',verification);item.save(base+'integration-check.json',item.report);item.write(base+'browser.original.txt',`# ${JSON.stringify(item.browser)}\n`+tap(1));
    for(const [group,name] of [['maintenanceUnit','maintenance'],['dynamicUnit','dynamic'],['authenticationUnit','authentication'],['regressionUnit','regression'],['toolsUnit','tools']])item.write(base+name+'.original.txt',tap(verification[group].pass));
    receipt.verificationArtifacts=['verification.json','integration-check.json','browser.original.txt','maintenance.original.txt','dynamic.original.txt','authentication.original.txt','regression.original.txt','tools.original.txt'].map(n=>item.descriptor(base+n));item.save(base+'acceptance.json',receipt);
  };update();return {...item,verification,receipt,update};
}
it('accepts local identity maintenance evidence and retains D20 without implying a management UI',()=>{
  assert.equal(verifyReleaseEvidence(maintenanceEvidenceFixture().root).currentTask,'DR-P2.4');
});
it('refuses incomplete maintenance, native CLI, replacement, metadata and fault evidence without falling back to D20',()=>{
  for(const mutate of [i=>{i.verification.maintenanceUnit.skip=1;},i=>{i.verification.maintenanceUnit.pass=32;},i=>{i.verification.checks.verifiedOsLocalOnly=false;},i=>{i.verification.checks.atomicReplacement=false;},i=>{i.verification.checks.nativeDpapiCliMaintenance=false;},i=>{i.verification.checks.maintenanceFaultRecovery=false;},i=>{i.verification.checks.boundedMetadata=false;},i=>{i.verification.scope.managementMaintenanceImplemented=false;},i=>{i.verification.documentValidation.completedRegistrationTasks=9;},i=>{i.verification.totalTargetedPass++;}]){
    const item=maintenanceEvidenceFixture();mutate(item);item.update();assert.throws(()=>verifyReleaseEvidence(item.root));
  }
  const item=maintenanceEvidenceFixture();item.write('docs/security-v1-deliveries/evidence/SEC-M7-D21/maintenance.original.txt','# pass 31\n# tests 31\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n');item.receipt.verificationArtifacts=item.receipt.verificationArtifacts.map(f=>item.descriptor(f.path));item.save('docs/security-v1-deliveries/evidence/SEC-M7-D21/acceptance.json',item.receipt);assert.throws(()=>verifyReleaseEvidence(item.root));
});

function resilienceEvidenceFixture(){
  const item=maintenanceEvidenceFixture(),base='docs/security-v1-deliveries/evidence/SEC-M7-D22/';
  const unit=pass=>({pass,fail:0,skip:0,cancelled:0,todo:0});
  const matrix={format:'modeldb.authentication-resilience-matrix.v1',ok:true,hardExitCases:30,signedRaceCases:10,auditFaultCases:4,checks:Object.fromEntries(['hardProcessExits','atomicSessionAudit','unknownOutcomeInspectable','noRevivalAfterRestart','disableEnableProofBarrier','latestReduction','maintenanceCas','legacyApiPairingManagement','noSecretsInLogs'].map(k=>[k,true])),liveMaterialRead:false,hardwareAuthenticatorTested:false};
  const resilienceReport={format:'modeldb.authentication-resilience-check.v1',task:'DR-P2.5',ok:true,exitCode:0,unit:unit(55),matrix,scope:{temporarySyntheticOnly:true,hardProcessExitTested:true,liveMaterialRead:false,nativeDpapiTested:false,hardwareAuthenticatorTested:false,physicalDiskFullTested:false,productionRegistrationUiTested:false}};
  const verification={...item.verification,format:'modeldb.security-authentication-resilience-verification.v1',task:'DR-P2.5',tasks:{registration:'11/23',registrationP2:'5/5',registrationWorkPackages:'2/4'},resilienceUnit:unit(55),toolsUnit:unit(37),totalTargetedPass:392,checks:{...item.verification.checks,...matrix.checks},documentValidation:{ok:true,completedRegistrationTasks:11},scope:{...item.verification.scope,hardProcessExitTested:true,physicalAuthenticatorTested:false,physicalDiskFullTested:false}};
  const receipt={...item.receipt,revision:'SEC-M7-D22',verification:{status:'passed',report:base+'verification.json'},historicalEvidence:[...item.receipt.historicalEvidence,item.descriptor('docs/security-v1-deliveries/evidence/SEC-M7-D21/acceptance.json')]};
  const tap=pass=>`# tests ${pass}\n# pass ${pass}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
  const update=()=>{
    item.save(base+'verification.json',verification);item.save(base+'integration-check.json',item.report);item.save(base+'resilience-check.json',resilienceReport);
    item.write(base+'browser.original.txt',`# ${JSON.stringify(item.browser)}\n`+tap(1));
    for(const [group,name] of [['maintenanceUnit','maintenance'],['dynamicUnit','dynamic'],['authenticationUnit','authentication'],['regressionUnit','regression'],['toolsUnit','tools'],['resilienceUnit','resilience']])item.write(base+name+'.original.txt',(name==='resilience'?`# ${JSON.stringify(matrix)}\n`:'')+tap(verification[group].pass));
    receipt.verificationArtifacts=['verification.json','integration-check.json','resilience-check.json','resilience.original.txt','browser.original.txt','maintenance.original.txt','dynamic.original.txt','authentication.original.txt','regression.original.txt','tools.original.txt'].map(n=>item.descriptor(base+n));item.save(base+'acceptance.json',receipt);
  };update();return {...item,verification,resilienceReport,matrix,receipt,update};
}
it('accepts DR-P2 completion only with separate process-exit, native browser and maintenance evidence',()=>{
  assert.equal(verifyReleaseEvidence(resilienceEvidenceFixture().root).currentTask,'DR-P2.5');
});
it('rejects incomplete or inflated resilience evidence without falling back to D21',()=>{
  for(const mutate of [i=>i.verification.resilienceUnit.skip=1,i=>i.verification.resilienceUnit.pass--,i=>i.matrix.hardExitCases--,i=>i.matrix.signedRaceCases--,i=>i.matrix.checks.disableEnableProofBarrier=false,i=>i.verification.checks.noRevivalAfterRestart=false,i=>i.resilienceReport.scope.nativeDpapiTested=true,i=>i.resilienceReport.scope.liveMaterialRead=true,i=>i.verification.scope.physicalAuthenticatorTested=true,i=>i.resilienceReport.exitCode=1,i=>i.verification.tasks.registrationWorkPackages='1/4',i=>i.verification.totalTargetedPass++]){
    const item=resilienceEvidenceFixture();mutate(item);item.update();assert.throws(()=>verifyReleaseEvidence(item.root));
  }
  const item=resilienceEvidenceFixture();item.receipt.verificationArtifacts=item.receipt.verificationArtifacts.filter(f=>!f.path.endsWith('resilience-check.json'));item.save('docs/security-v1-deliveries/evidence/SEC-M7-D22/acceptance.json',item.receipt);assert.throws(()=>verifyReleaseEvidence(item.root));
});

function hostingEvidenceFixture(){
  const item=resilienceEvidenceFixture(),base='docs/security-v1-deliveries/evidence/SEC-M7-D23/';
  const unit=pass=>({pass,fail:0,skip:0,cancelled:0,todo:0}),tap=pass=>`# tests ${pass}\n# pass ${pass}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
  const native={format:'modeldb.hosting-native.v1',ok:true,checks:Object.fromEntries(nativeChecks.map(k=>[k,true])),liveMaterialRead:false};
  const browser={format:'modeldb.hosting-browser.v1',ok:true,browser:'Chrome/156.0.0.0',checks:Object.fromEntries(browserChecks.map(k=>[k,true])),screenshots:12,hardwareAuthenticatorTested:false,systemTrustInstalled:false,liveMaterialRead:false};
  const report={format:'modeldb.hosting-integration-check.v1',task:'DR-P3.1',ok:true,platform:'win32',exitCode:0,unit:unit(2),native,browser,build:{configFile:false,envFile:false,existingDistUnchanged:true},scope:{temporarySyntheticOnly:true,liveMaterialRead:false,hardwareAuthenticatorTested:false,systemTrustInstalled:false,productionRegistrationUiTested:false}};
  const verification={format:'modeldb.security-hosting-verification.v1',task:'DR-P3.1',tasks:{registration:'12/23',registrationP3:'1/6',registrationWorkPackages:'2/4'},hostingUnit:unit(36),authenticationUnit:unit(55),dynamicUnit:unit(42),regressionUnit:unit(169),maintenanceUnit:unit(33),toolsUnit:unit(39),launchCompatibilityUnit:unit(19),nativeUnit:unit(2),totalTargetedPass:395,checks:Object.fromEntries([...nativeChecks,...browserChecks,'strictHostingTypes','serverTypecheck','designerTypecheck','browserBoundary','scopedFormatting','scopedLint','staticSnapshot','managementLifetimes','materialGuard'].map(k=>[k,true])),scope:{liveMaterialRead:false,productionMigrationPerformed:false,physicalAuthenticatorTested:false,performanceTested:false,fullReleaseInstallTested:false},documentValidation:{ok:true,completedRegistrationTasks:12}};
  const receipt={...item.receipt,revision:'SEC-M7-D23',verification:{status:'passed',report:base+'verification.json'},historicalEvidence:[...item.receipt.historicalEvidence,item.descriptor('docs/security-v1-deliveries/evidence/SEC-M7-D22/acceptance.json')]};
  const update=()=>{
    item.save(base+'verification.json',verification);item.save(base+'integration-check.json',report);item.write(base+'native.original.txt',`# ${JSON.stringify(native)}\n# ${JSON.stringify(browser)}\n`+tap(2));
    item.save(base+'types.original.txt',{ok:true,checks:{entireServerTypecheck:true,strictHostingTypecheck:true,existingDistUnchanged:true}});
    item.save(base+'consumer-native.original.txt',{ok:true,checks:{entireDesignerTypecheck:true,strictSdkConsumer:true,domTypesWithoutNode:true,serverLibraryExcluded:true}});
    item.save(base+'static-commands.json',Array(4).fill({exitCode:0}));item.save(base+'documents.original.json.txt',verification.documentValidation);
    const paths=['verification.json','integration-check.json','native.original.txt','types.original.txt','consumer-native.original.txt','static-commands.json','documents.original.json.txt'];
    for(const [key,name] of [['hostingUnit','hosting'],['authenticationUnit','authentication'],['dynamicUnit','dynamic'],['regressionUnit','regression'],['maintenanceUnit','maintenance'],['toolsUnit','tools'],['launchCompatibilityUnit','launch-compat']]){item.write(base+name+'.original.txt',tap(verification[key].pass));paths.push(name+'.original.txt');}
    for(const e of ['connection','security'])for(const l of ['zh','en','ja'])for(const w of [1280,390]){const p=`screenshots/${e}-${l}-${w}.png`;item.write(base+p,Buffer.from([137,80,78,71]));paths.push(p);}
    receipt.verificationArtifacts=paths.map(p=>item.descriptor(base+p));item.save(base+'acceptance.json',receipt);
  };update();return {...item,report,native,browser,verification,receipt,update};
}
it('accepts hosted listeners only with native lifecycle, exact origin and localized browser evidence',()=>{assert.equal(verifyReleaseEvidence(hostingEvidenceFixture().root).currentTask,'DR-P3.1');});
it('rejects missing, skipped, stale, inflated or incomplete hosting evidence without fallback to D22',()=>{
  for(const edit of [i=>i.native.checks.bindFailuresReleaseRegistryAndPipe=false,i=>i.browser.checks.httpOnlyStrict=false,i=>i.browser.hardwareAuthenticatorTested=true,i=>i.verification.checks.managementLifetimes=false,i=>i.verification.hostingUnit.pass--,i=>i.verification.toolsUnit.skip=1,i=>i.verification.totalTargetedPass++,i=>i.verification.documentValidation.completedRegistrationTasks=11,i=>i.report.build.configFile=true,i=>i.report.scope.liveMaterialRead=true,i=>i.report.exitCode=1,i=>i.verification.tasks.registrationP3='6/6']){const i=hostingEvidenceFixture();edit(i);i.update();assert.throws(()=>verifyReleaseEvidence(i.root));}
  for(const name of ['native.original.txt','integration-check.json','screenshots/security-ja-390.png']){const i=hostingEvidenceFixture();i.receipt.verificationArtifacts=i.receipt.verificationArtifacts.filter(f=>!f.path.endsWith(name));i.save('docs/security-v1-deliveries/evidence/SEC-M7-D23/acceptance.json',i.receipt);assert.throws(()=>verifyReleaseEvidence(i.root));}
});

function identityEvidenceFixture(){
  const item=hostingEvidenceFixture(),old='docs/security-v1-deliveries/evidence/SEC-M7-D23/',base='docs/security-v1-deliveries/evidence/SEC-M7-D24/';
  const unit=pass=>({pass,fail:0,skip:0,cancelled:0,todo:0}),tap=pass=>`# tests ${pass}\n# pass ${pass}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
  const verification=structuredClone(item.verification);Object.assign(verification,{format:'modeldb.security-designer-identity-verification.v1',task:'DR-P3.2',tasks:{registration:'13/23',registrationP3:'2/6',registrationWorkPackages:'2/4'},toolsUnit:unit(41),identityUnit:unit(24),identityNativeUnit:unit(1),totalTargetedPass:422});
  verification.documentValidation.completedRegistrationTasks=13;Object.assign(verification.checks,Object.fromEntries(identityBrowserChecks.map(k=>[k,true])));
  const browser={format:'modeldb.designer-identity-browser.v1',ok:true,browser:'Chrome/156.0.0.0',screenshots:24,hardwareAuthenticatorTested:false,systemTrustInstalled:false,liveMaterialRead:false,checks:Object.fromEntries(identityBrowserChecks.map(k=>[k,true]))};
  const report={format:'modeldb.designer-identity-check.v1',task:'DR-P3.2',ok:true,platform:'win32',exitCode:0,unit:unit(1),browser,build:{configFile:false,envFile:false,existingDistUnchanged:true},scope:{temporarySyntheticOnly:true,formalRegistrationUiTested:true,liveMaterialRead:false,hardwareAuthenticatorTested:false,systemTrustInstalled:false}};
  const paths=item.receipt.verificationArtifacts.map(f=>f.path.slice(old.length));for(const path of paths)item.write(base+path,readFileSync(join(item.root,old+path)));
  const receipt={...item.receipt,revision:'SEC-M7-D24',verification:{status:'passed',report:base+'verification.json'},historicalEvidence:[...item.receipt.historicalEvidence,item.descriptor(old+'acceptance.json')]};
  paths.push('identity.original.txt','identity-integration-check.json','identity-native.original.txt');
  for(const scene of ['login','pending','approved','rejected'])for(const locale of ['zh','en','ja'])for(const width of [1280,390]){const p=`screenshots/identity/${scene}-${locale}-${width}.png`;paths.push(p);item.write(base+p,Buffer.from([137,80,78,71]));}
  const update=()=>{
    item.save(base+'verification.json',verification);item.save(base+'documents.original.json.txt',verification.documentValidation);
    item.save(base+'types.original.txt',{ok:true,checks:{entireServerTypecheck:true,strictHostingTypecheck:true,strictDesignerIdentityTypecheck:true,existingDistUnchanged:true}});
    item.write(base+'tools.original.txt',tap(verification.toolsUnit.pass));item.write(base+'identity.original.txt',tap(verification.identityUnit.pass));
    item.save(base+'identity-integration-check.json',report);item.write(base+'identity-native.original.txt',`# ${JSON.stringify(browser)}\n`+tap(1));
    receipt.verificationArtifacts=paths.map(p=>item.descriptor(base+p));item.save(base+'acceptance.json',receipt);
  };update();return {...item,base,verification,browser,report,receipt,update};
}
it('requires the newest formal identity UI receipt while preserving D23 history',()=>assert.equal(verifyReleaseEvidence(identityEvidenceFixture().root).currentTask,'DR-P3.2'));
it('rejects incomplete identity UI evidence, hardware claims, count drift and missing screenshots without fallback',()=>{
  for(const edit of [i=>i.browser.checks.formalRegistration=false,i=>i.browser.hardwareAuthenticatorTested=true,i=>i.report.build.configFile=true,i=>i.verification.identityUnit.pass--,i=>i.verification.tasks.registration='12/23',i=>i.verification.totalTargetedPass++,i=>i.verification.documentValidation.completedRegistrationTasks=12]){const i=identityEvidenceFixture();edit(i);i.update();assert.throws(()=>verifyReleaseEvidence(i.root));}
  for(const name of ['identity-integration-check.json','identity-native.original.txt','screenshots/identity/pending-ja-390.png']){const i=identityEvidenceFixture();i.receipt.verificationArtifacts=i.receipt.verificationArtifacts.filter(f=>f.path!==i.base+name);i.save(i.base+'acceptance.json',i.receipt);assert.throws(()=>verifyReleaseEvidence(i.root));}
});
import {identityAdminChecks} from '../../scripts/security-identity-admin-check.mjs';

function identityAdminEvidenceFixture(){
  const item=identityEvidenceFixture(),old=item.base,base='docs/security-v1-deliveries/evidence/SEC-M7-D25/';
  const unit=pass=>({pass,fail:0,skip:0,cancelled:0,todo:0}),tap=pass=>'# tests '+pass+'\n# pass '+pass+'\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  const verification=structuredClone(item.verification);
  Object.assign(verification,{format:'modeldb.security-identity-admin-verification.v1',task:'DR-P3.3',tasks:{registration:'14/23',registrationP3:'3/6',registrationWorkPackages:'2/4'},toolsUnit:unit(43),identityAdminUnit:unit(14),identityAdminNativeUnit:unit(1),totalTargetedPass:439});
  verification.documentValidation.completedRegistrationTasks=14;Object.assign(verification.checks,Object.fromEntries(identityAdminChecks.map(k=>[k,true])));
  const browser={format:'modeldb.identity-admin-browser.v1',ok:true,browser:'Chrome/156.0.0.0',screenshots:24,hardwareAuthenticatorTested:false,systemTrustInstalled:false,liveMaterialRead:false,checks:Object.fromEntries(identityAdminChecks.map(k=>[k,true]))};
  const report={format:'modeldb.identity-admin-check.v1',task:'DR-P3.3',ok:true,platform:'win32',exitCode:0,unit:unit(1),browser,build:{configFile:false,envFile:false,existingDistUnchanged:true},scope:{temporarySyntheticOnly:true,identityMaintenanceUiTested:true,liveMaterialRead:false,hardwareAuthenticatorTested:false,systemTrustInstalled:false}};
  const paths=item.receipt.verificationArtifacts.map(f=>f.path.slice(old.length));for(const path of paths)item.write(base+path,readFileSync(join(item.root,old+path)));
  const receipt={...item.receipt,revision:'SEC-M7-D25',verification:{status:'passed',report:base+'verification.json'},historicalEvidence:[...item.receipt.historicalEvidence,item.descriptor(old+'acceptance.json')]};
  paths.push('identity-admin.original.txt','admin-integration-check.json','admin-native.original.txt');
  for(const scene of ['applications','approval-review','conflict','credentials'])for(const locale of ['zh','en','ja'])for(const width of [1280,390]){const p='screenshots/admin/'+scene+'-'+locale+'-'+width+'.png';paths.push(p);item.write(base+p,Buffer.from([137,80,78,71]));}
  const update=()=>{
    item.save(base+'verification.json',verification);item.save(base+'documents.original.json.txt',verification.documentValidation);
    item.save(base+'types.original.txt',{ok:true,checks:{entireServerTypecheck:true,strictHostingTypecheck:true,strictDesignerIdentityTypecheck:true,strictIdentityAdminTypecheck:true,existingDistUnchanged:true}});
    item.write(base+'tools.original.txt',tap(verification.toolsUnit.pass));item.write(base+'identity-admin.original.txt',tap(verification.identityAdminUnit.pass));
    item.save(base+'admin-integration-check.json',report);item.write(base+'admin-native.original.txt','# '+JSON.stringify(browser)+'\n'+tap(1));
    receipt.verificationArtifacts=paths.map(p=>item.descriptor(base+p));item.save(base+'acceptance.json',receipt);
  };update();return {...item,base,verification,adminBrowser:browser,adminReport:report,receipt,update};
}
it('requires D25 local approval and maintenance UI evidence while preserving D24',()=>assert.equal(verifyReleaseEvidence(identityAdminEvidenceFixture().root).currentTask,'DR-P3.3'));
it('rejects missing admin UI, conflict, paging, confirmation, native scope or count evidence without fallback',()=>{
  for(const edit of [i=>i.adminBrowser.checks.uiApproval=false,i=>i.adminBrowser.checks.conflictRequiresReload=false,i=>i.adminBrowser.checks.pagination=false,i=>i.adminBrowser.checks.explicitConfirmation=false,i=>i.adminBrowser.hardwareAuthenticatorTested=true,i=>i.adminReport.build.configFile=true,i=>i.verification.identityAdminUnit.pass--,i=>i.verification.tasks.registration='13/23',i=>i.verification.totalTargetedPass++,i=>i.verification.documentValidation.completedRegistrationTasks=13]){const i=identityAdminEvidenceFixture();edit(i);i.update();assert.throws(()=>verifyReleaseEvidence(i.root));}
  for(const name of ['admin-integration-check.json','admin-native.original.txt','screenshots/admin/approval-review-ja-390.png']){const i=identityAdminEvidenceFixture();i.receipt.verificationArtifacts=i.receipt.verificationArtifacts.filter(f=>f.path!==i.base+name);i.save(i.base+'acceptance.json',i.receipt);assert.throws(()=>verifyReleaseEvidence(i.root));}
});

function deploymentEvidenceFixture(){
  const item=identityAdminEvidenceFixture(),old=item.base,base='docs/security-v1-deliveries/evidence/SEC-M7-D26/';
  const unit=pass=>({pass,fail:0,skip:0,cancelled:0,todo:0}),tap=pass=>'# tests '+pass+'\n# pass '+pass+'\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  const verification=structuredClone(item.verification);
  Object.assign(verification,{format:'modeldb.security-deployment-wizard-verification.v1',task:'DR-P3.4',tasks:{registration:'15/23',registrationP3:'4/6',registrationWorkPackages:'2/4'},toolsUnit:unit(45),deploymentUnit:unit(22),deploymentNativeUnit:unit(1),totalTargetedPass:464});
  verification.documentValidation.completedRegistrationTasks=15;Object.assign(verification.checks,Object.fromEntries(deploymentChecks.map(k=>[k,true])));
  const browser={format:'modeldb.deployment-wizard-browser.v1',ok:true,browser:'Chrome/156.0.0.0',screenshots:24,hardwareAuthenticatorTested:false,systemTrustInstalled:false,liveMaterialRead:false,checks:Object.fromEntries(deploymentChecks.map(k=>[k,true]))};
  const report={format:'modeldb.deployment-wizard-check.v1',task:'DR-P3.4',ok:true,platform:'win32',exitCode:0,unit:unit(1),browser,build:{configFile:false,envFile:false,existingDistUnchanged:true},scope:{temporarySyntheticOnly:true,deploymentWizardTested:true,liveMaterialRead:false,hardwareAuthenticatorTested:false,systemTrustInstalled:false}};
  const paths=item.receipt.verificationArtifacts.map(f=>f.path.slice(old.length));for(const path of paths)item.write(base+path,readFileSync(join(item.root,old+path)));
  const receipt={...item.receipt,revision:'SEC-M7-D26',verification:{status:'passed',report:base+'verification.json'},historicalEvidence:[...item.receipt.historicalEvidence,item.descriptor(old+'acceptance.json')]};
  paths.push('deployment.original.txt','deployment-integration-check.json','deployment-native.original.txt');
  for(const scene of ['local','lan','review','existing'])for(const locale of ['zh','en','ja'])for(const width of [1280,390]){const p='screenshots/deployment/'+scene+'-'+locale+'-'+width+'.png';paths.push(p);item.write(base+p,Buffer.from([137,80,78,71]));}
  const update=()=>{
    item.save(base+'verification.json',verification);item.save(base+'documents.original.json.txt',verification.documentValidation);
    item.save(base+'types.original.txt',{ok:true,checks:{entireServerTypecheck:true,strictHostingTypecheck:true,strictDesignerIdentityTypecheck:true,strictIdentityAdminTypecheck:true,strictDeploymentWizardTypecheck:true,existingDistUnchanged:true}});
    item.write(base+'tools.original.txt',tap(verification.toolsUnit.pass));item.write(base+'deployment.original.txt',tap(verification.deploymentUnit.pass));
    item.save(base+'deployment-integration-check.json',report);item.write(base+'deployment-native.original.txt','# '+JSON.stringify(browser)+'\n'+tap(1));
    receipt.verificationArtifacts=paths.map(p=>item.descriptor(base+p));item.save(base+'acceptance.json',receipt);
  };update();return {...item,base,verification,deploymentBrowser:browser,deploymentReport:report,receipt,update};
}
it('requires D26 first-deployment evidence while preserving D25 history',()=>assert.equal(verifyReleaseEvidence(deploymentEvidenceFixture().root).currentTask,'DR-P3.4'));
it('rejects missing preview, offline, policy, localization or scope checks without falling back',()=>{
  for(const edit of [i=>i.deploymentBrowser.checks.previewDoesNotWrite=false,i=>i.deploymentBrowser.checks.offlineLeaseRequired=false,i=>i.deploymentBrowser.checks.persistentPolicyApplied=false,i=>i.deploymentBrowser.checks.localizedZhEnJa=false,i=>i.deploymentReport.scope.liveMaterialRead=true,i=>i.deploymentReport.build.configFile=true,i=>i.verification.deploymentUnit.pass--,i=>i.verification.tasks.registration='14/23',i=>i.verification.totalTargetedPass++,i=>i.verification.documentValidation.completedRegistrationTasks=14]){const i=deploymentEvidenceFixture();edit(i);i.update();assert.throws(()=>verifyReleaseEvidence(i.root));}
  for(const name of ['deployment-integration-check.json','deployment-native.original.txt','screenshots/deployment/review-ja-390.png']){const i=deploymentEvidenceFixture();i.receipt.verificationArtifacts=i.receipt.verificationArtifacts.filter(f=>f.path!==i.base+name);i.save(i.base+'acceptance.json',i.receipt);assert.throws(()=>verifyReleaseEvidence(i.root));}
});

import {publicClientChecks} from '../../scripts/security-public-clients-check.mjs';
import {candidateGroups,hostileBrowserChecks} from '../../scripts/security-browser-candidate-check.mjs';
import {candidateUnitGroups} from '../../scripts/security-browser-candidate-evidence.mjs';
function publicClientsEvidenceFixture(){
  const item=deploymentEvidenceFixture(),old=item.base,base='docs/security-v1-deliveries/evidence/SEC-M7-D27/';
  const unit=pass=>({pass,fail:0,skip:0,cancelled:0,todo:0}),tap=pass=>'# tests '+pass+'\n# pass '+pass+'\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  const verification=structuredClone(item.verification);Object.assign(verification,{format:'modeldb.security-public-clients-verification.v1',task:'DR-P3.5',tasks:{registration:'16/23',registrationP3:'5/6',registrationWorkPackages:'2/4'},toolsUnit:unit(47),identityUnit:unit(31),publicReportUnit:unit(4),publicNativeUnit:unit(3),totalTargetedPass:480});
  verification.documentValidation.completedRegistrationTasks=16;Object.assign(verification.checks,Object.fromEntries(publicClientChecks.map(k=>[k,true])));
  const browsers=['data-studio','web'].map(app=>({format:'modeldb.public-identity-browser.v1',app,ok:true,browser:'Chrome/156.0.0.0',screenshots:app==='web'?16:24,hardwareAuthenticatorTested:false,systemTrustInstalled:false,liveMaterialRead:false,checks:Object.fromEntries(publicClientChecks.map(k=>[k,true]))}));
  const report={format:'modeldb.public-clients-check.v1',task:'DR-P3.5',ok:true,platform:'win32',exitCode:0,unit:unit(3),browsers,legacyThreeApplications:true,applicationCredentialMode:true,build:{configFile:false,envFile:false,existingDistUnchanged:true,applications:['model-designer','data-studio','web']},scope:{temporarySyntheticOnly:true,liveMaterialRead:false,hardwareAuthenticatorTested:false,systemTrustInstalled:false}};
  const paths=item.receipt.verificationArtifacts.map(f=>f.path.slice(old.length));for(const path of paths)item.write(base+path,readFileSync(join(item.root,old+path)));
  const receipt={...item.receipt,revision:'SEC-M7-D27',verification:{status:'passed',report:base+'verification.json'},historicalEvidence:[...item.receipt.historicalEvidence,item.descriptor(old+'acceptance.json')]};
  paths.push('public-report.original.txt','public-integration-check.json','public-native.original.txt');
  for(const app of ['data-studio','web'])for(const scene of ['login','pending','approved','rejected'])for(const locale of app==='web'?['zh-CN','en']:['zh','en','ja'])for(const width of [1280,390]){const p='screenshots/public/'+app+'/'+scene+'-'+locale+'-'+width+'.png';paths.push(p);item.write(base+p,Buffer.from([137,80,78,71]));}
  const update=()=>{
    item.save(base+'verification.json',verification);item.save(base+'documents.original.json.txt',verification.documentValidation);
    item.save(base+'types.original.txt',{ok:true,checks:{entireServerTypecheck:true,strictHostingTypecheck:true,strictDesignerIdentityTypecheck:true,strictIdentityAdminTypecheck:true,strictDeploymentWizardTypecheck:true,strictPublicClientsTypecheck:true,existingDistUnchanged:true}});
    item.save(base+'consumer-native.original.txt',{ok:true,checks:{entireDesignerTypecheck:true,entireDataStudioTypecheck:true,entireWebTypecheck:true,publicIdentityClientConsumer:true,strictSdkConsumer:true,domTypesWithoutNode:true,serverLibraryExcluded:true}});
    item.write(base+'tools.original.txt',tap(47));item.write(base+'identity.original.txt',tap(31));item.write(base+'public-report.original.txt',tap(4));
    item.save(base+'public-integration-check.json',report);item.write(base+'public-native.original.txt',browsers.map(b=>'# '+JSON.stringify(b)+'\n').join('')+['model-designer','data-studio','web'].map(app=>'# [security-browser] '+app+': pairing, workspace, reload, HttpOnly and logout passed\n# [security-browser] '+app+': application credential controls, scoped listing and memory-only reload passed\n').join('')+tap(3));
    receipt.verificationArtifacts=paths.map(p=>item.descriptor(base+p));item.save(base+'acceptance.json',receipt);
  };update();return {...item,base,verification,publicReport:report,receipt,update};
}
it('requires D27 public client and three-application compatibility evidence while preserving D26',()=>assert.equal(verifyReleaseEvidence(publicClientsEvidenceFixture().root).currentTask,'DR-P3.5'));
it('rejects missing consumer, locale, application mode, lifecycle or accurate counts without fallback',()=>{
  for(const edit of [i=>i.publicReport.browsers[0].checks.publicClient=false,i=>i.publicReport.browsers[1].checks.libraryConnection=false,i=>i.publicReport.applicationCredentialMode=false,i=>i.publicReport.build.configFile=true,i=>i.verification.identityUnit.pass--,i=>i.verification.totalTargetedPass++,i=>i.verification.documentValidation.completedRegistrationTasks=15]){const i=publicClientsEvidenceFixture();edit(i);i.update();assert.throws(()=>verifyReleaseEvidence(i.root));}
  for(const name of ['public-integration-check.json','public-native.original.txt','screenshots/public/data-studio/pending-ja-390.png']){const i=publicClientsEvidenceFixture();i.receipt.verificationArtifacts=i.receipt.verificationArtifacts.filter(f=>f.path!==i.base+name);i.save(i.base+'acceptance.json',i.receipt);assert.throws(()=>verifyReleaseEvidence(i.root));}
});

function browserCandidateEvidenceFixture(){
  const item=publicClientsEvidenceFixture(),old=item.base,base='docs/security-v1-deliveries/evidence/SEC-M7-D28/',directory=base+'run-1/';
  const unit=pass=>({pass,fail:0,skip:0,cancelled:0,todo:0}),tap=pass=>'# tests '+pass+'\n# pass '+pass+'\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  const paths=[];
  const write=(path,bytes)=>{item.write(path,bytes);if(!paths.includes(path))paths.push(path);};
  const save=(path,value)=>write(path,JSON.stringify(value));
  const hostile={format:'modeldb.hostile-browser.v1',ok:true,browser:'Chrome/156.0.0.0',hardwareAuthenticatorTested:false,systemTrustInstalled:false,liveMaterialRead:false,checks:Object.fromEntries(hostileBrowserChecks.map(k=>[k,true]))};
  for(const [name,file] of [['hosting','native.original.txt'],['identity','identity-native.original.txt'],['admin','admin-native.original.txt'],['deployment','deployment-native.original.txt'],['public','public-native.original.txt']]){
    let source=readFileSync(join(item.root,old+file),'utf8');
    source=source.replaceAll('"checks":{','"checks":{"syntheticSaveReadback":true,');write(directory+name+'.tap',source);
  }
  write(directory+'hostile.tap','# '+JSON.stringify(hostile)+'\n'+tap(1));
  const manifest={format:'modeldb.browser-candidate-manifest.v1',sources:item.receipt.files.map(f=>({path:f.path,sha256:f.sha256})),applications:['model-designer','data-studio','web'].flatMap(name=>['index.html','favicon.svg'].map(file=>({path:name+'/'+file,sha256:'a'.repeat(64)})))};
  const report={format:'modeldb.browser-candidate-check.v1',task:'DR-P3.6',platform:'win32',ok:true,totalNativePass:9,build:{applications:['model-designer','data-studio','web'],configFile:false,envFile:false,existingDistUnchanged:true,sourceUnchanged:true,buildUnchanged:true,singleCandidate:true},scope:{temporarySyntheticOnly:true,liveMaterialRead:false,hardwareAuthenticatorTested:false,systemTrustInstalled:false,lanTested:false,fullReleaseInstallTested:false}};
  const verification={format:'modeldb.security-browser-candidate-verification.v1',task:'DR-P3.6',tasks:{registration:'17/23',registrationP3:'6/6',registrationWorkPackages:'3/4'},...Object.fromEntries(candidateUnitGroups.map(([key,,count])=>[key,unit(count)])),nativePass:9,totalTargetedPass:490,checks:Object.fromEntries(['singleCandidate','threeClientSaveReadback','hostileBrowser','strictTypes','browserBoundary','scopedStatic','materialGuard'].map(k=>[k,true])),documentValidation:{ok:true,registrationTaskRows:23,completedRegistrationTasks:17,failures:[]},scope:{temporarySyntheticOnly:true,liveMaterialRead:false,productionMigrationPerformed:false,physicalAuthenticatorTested:false,performanceTested:false,fullReleaseInstallTested:false,lanTested:false,fullBusinessSaveTested:false,uiChanged:false}};
  for(const file of item.receipt.verificationArtifacts){
    const name=file.path.slice(old.length);if(!name.startsWith('screenshots/'))continue;
    const p=name.replace(/^screenshots\/(connection-|security-)/,'screenshots/hosting/$1');write(directory+p,readFileSync(join(item.root,file.path)));
  }
  for(const [,name,count]of candidateUnitGroups)write(base+name+'.original.txt',tap(count));
  save(base+'types.original.txt',{ok:true,checks:{entireServerTypecheck:true,strictHostileBrowserTypecheck:true,existingDistUnchanged:true}});
  save(base+'consumer-native.original.txt',{ok:true,checks:{entireDesignerTypecheck:true,entireDataStudioTypecheck:true,entireWebTypecheck:true,publicIdentityClientConsumer:true,domTypesWithoutNode:true,serverLibraryExcluded:true}});
  save(base+'static-commands.json',Array(4).fill({exitCode:0}));
  const receipt={...item.receipt,revision:'SEC-M7-D28',task:'DR-P3.6',verification:{status:'passed',report:base+'verification.json'},historicalEvidence:[...item.receipt.historicalEvidence,...item.receipt.verificationArtifacts,item.descriptor(old+'acceptance.json')]};
  const update=()=>{
    const digest=sha(JSON.stringify(manifest));report.candidateSha256=digest;
    report.groups=candidateGroups.map(([name,,parse])=>({name,log:name+'.tap',exitCode:0,timedOut:false,ok:true,candidateSha256:digest,...parse(readFileSync(join(item.root,directory+name+'.tap'),'utf8'),0)}));
    save(directory+'candidate-manifest.json',manifest);save(directory+'candidate-check.json',report);save(base+'selected-candidate.json',{directory:directory.slice(0,-1),candidateSha256:digest});
    verification.candidateSha256=digest;save(base+'verification.json',verification);save(base+'documents.original.json.txt',verification.documentValidation);
    receipt.verificationArtifacts=paths.map(item.descriptor);item.save(base+'acceptance.json',receipt);
  };update();return {...item,base,directory,manifest,report,verification,receipt,update};
}
it('requires D28 one-candidate browser, hostile page and three-client save evidence while preserving D27',()=>assert.equal(verifyReleaseEvidence(browserCandidateEvidenceFixture().root).currentTask,'DR-P3.6'));
it('rejects missing candidate evidence, changed source binding, skipped checks and false production claims without fallback',()=>{
  for(const edit of [i=>i.manifest.sources[0].sha256='e'.repeat(64),i=>i.manifest.applications[0].path='model-designer/server.key',i=>i.report.build.singleCandidate=false,i=>i.report.scope.lanTested=true,i=>i.verification.totalTargetedPass++,i=>i.verification.tasks.registrationP3='5/6',i=>i.verification.documentValidation.completedRegistrationTasks=16,i=>i.verification.scope.physicalAuthenticatorTested=true]){const i=browserCandidateEvidenceFixture();edit(i);i.update();assert.throws(()=>verifyReleaseEvidence(i.root));}
  for(const name of ['candidate-manifest.json','hostile.tap','screenshots/public/web/pending-en-390.png']){const i=browserCandidateEvidenceFixture();i.receipt.verificationArtifacts=i.receipt.verificationArtifacts.filter(f=>!f.path.endsWith(name));i.save(i.base+'acceptance.json',i.receipt);assert.throws(()=>verifyReleaseEvidence(i.root));}
});
