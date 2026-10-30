/** Pure boundary and temporary fresh-instance tests; no installed config or live material. */
import assert from 'node:assert/strict';
import {randomBytes,X509Certificate} from 'node:crypto';
import {existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {test} from 'node:test';
import {deploymentHash,previewDeployment} from '../../packages/server/src/security/deployment-wizard.js';
import {DeploymentWizard,initializeDeployment,finalizeDeployment,BOOTSTRAP_CONFIG,DEPLOYED_CONFIG,deploymentPath} from '../../packages/server/src/security/deployment-files.js';
import {SecurityRegistry} from '../../packages/server/src/security/security-registry.js';
import {syntheticProtector,SID} from '../fixtures/security-registration-integration.js';
import {SecurityError} from '../../packages/server/src/security/security-errors.js';
import {runDeploymentCli} from '../../packages/server/src/cli-security-deployment.js';
import {dispatchSecurityControl} from '../../packages/server/src/security/security-control.js';
import {SecurityNetworkPolicy} from '../../packages/server/src/security/network-policy.js';
import {SecurityProtection} from '../../packages/server/src/security/security-protection.js';
import {hostingFixture} from '../fixtures/security-hosting.js';
import type {DeploymentDraft} from '@mode-db/shared';

const certFile=resolve('test/fixtures/security-registration-tls/modeldb-a.crt'),keyFile=resolve('test/fixtures/security-registration-tls/modeldb-a.key');
const pem=readFileSync(certFile,'utf8'),cert=new X509Certificate(pem),pin=deploymentHash(cert.publicKey.export({type:'spki',format:'der'}));
const now=Date.UTC(2026,9,27),context={instanceId:'11111111-1111-4111-8111-111111111111',bootstrapSha256:'b'.repeat(64),designerDirectory:resolve('test-public-build')};
const lan=():DeploymentDraft=>({mode:'lan',port:9443,serverOrigin:'https://modeldb-a.example.test:9443',rpId:'modeldb-a.example.test',certificatePem:pem,certificateFile:certFile,privateKeyFile:keyFile,tlsMode:'owner-pinned',spkiSha256:pin,allowedSources:['192.0.2.0/24'],registrationEnabled:false,windowHours:24});
const plan=(draft:unknown=lan())=>({format:'modeldb.deployment-plan.v1',instanceId:context.instanceId,bootstrapSha256:context.bootstrapSha256,preparedAtUtc:new Date(now).toISOString(),draft});
const rejected=(work:()=>unknown,code?:string)=>assert.throws(work,e=>e instanceof SecurityError&&(!code||e.code===code));
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'ModeDB-Deployment-Test-')),target=join(root,'instance'),build=join(root,'public-build');mkdirSync(build);mkdirSync(join(build,'assets'));writeFileSync(join(build,'index.html'),'<html><head><script src="/assets/test.js"></script></head><body></body></html>');writeFileSync(join(build,'assets/test.js'),'export {};');
  const options={protector:syntheticProtector(randomBytes(32))};const initialized=initializeDeployment(target,build,9443,options);
  const open=()=>SecurityRegistry.open(join(target,'security'),options);
  return {root,target,build,options,initialized,open,preview(draft:DeploymentDraft={mode:'local',port:9443}){const r=open();try{return new DeploymentWizard(r,join(target,BOOTSTRAP_CONFIG)).preview(draft);}finally{r.close();}}};
}
test('local plan has loopback, no registration/authentication/TLS and no inherited fields',()=>{
  const p=previewDeployment(plan({mode:'local',port:9443}),context,now);assert.equal(p.config.host,'127.0.0.1');assert.equal(p.descriptor,undefined);assert.equal(p.config.security.registration,undefined);assert.equal(p.config.security.authentication,undefined);assert.equal(p.trustVerified,false);assert.equal(p.keyMatchVerified,false);assert.equal(p.dnsVerified,false);
  for(const extra of [{registrationEnabled:true},{certificatePem:pem},{workspace:'other'},{host:'0.0.0.0'},{token:'synthetic'}])rejected(()=>previewDeployment(plan({mode:'local',port:9443,...extra}),context,now));
});
test('LAN preview binds exact instance, DNS/RP/port, TLS pin, narrow sources and finite disabled window',()=>{
  const p=previewDeployment(plan(),context,now);assert.equal(p.config.host,'0.0.0.0');assert.equal(p.descriptor!.registrationMode,'disabled');assert.equal(p.descriptor!.instanceId,context.instanceId);assert.equal(p.certificate!.spkiSha256,pin);assert.deepEqual(p.config.security.network.management.allow!.map(r=>r.source),['127.0.0.0/8','::1/128']);assert.equal(p.digest,deploymentHash(JSON.stringify(p.plan)));assert.doesNotMatch(JSON.stringify(p.config),/BEGIN CERTIFICATE|PRIVATE KEY/);
  assert.equal(previewDeployment(plan({...lan(),registrationEnabled:true}),context,now).descriptor!.registrationMode,'enabled');
});
test('malformed/expired/future dates, wrong instance/bootstrap, extra plan fields fail closed',()=>{
  for(const extra of [{preparedAtUtc:'garbage'},{preparedAtUtc:'2026-10-26T00:00:00.000Z'},{preparedAtUtc:new Date(now+1).toISOString()},{instanceId:context.instanceId+'\n'},{bootstrapSha256:'c'.repeat(64)},{config:{host:'0.0.0.0'}}])rejected(()=>previewDeployment({...plan(),...extra},context,now));
});
test('HTTP, IP, localhost, RP suffix, paths, credentials, noncanonical DNS and port mismatch are rejected',()=>{
  for(const extra of [{serverOrigin:'http://modeldb-a.example.test:9443'},{serverOrigin:'https://127.0.0.1:9443',rpId:'127.0.0.1'},{rpId:'localhost'},{rpId:'example.test'},{serverOrigin:'https://modeldb-a.example.test:9443/path'},{serverOrigin:'https://user@modeldb-a.example.test:9443'},{rpId:'ModelDB-a.example.test'},{port:443},{rpId:'modeldb-a.example.test\n'}])rejected(()=>previewDeployment(plan({...lan(),...extra}),context,now));
});
test('private key contents, multiple certificates, wrong SAN/pin and certificate expiry are rejected',()=>{
  for(const extra of [{certificatePem:pem+pem},{certificatePem:readFileSync(keyFile,'utf8')},{spkiSha256:'0'.repeat(64)},{serverOrigin:'https://wrong.example.test:9443',rpId:'wrong.example.test'},{tlsMode:'public-ca',spkiSha256:pin}])rejected(()=>previewDeployment(plan({...lan(),...extra}),context,now));
  const at=Date.parse(cert.validTo)-1000;rejected(()=>previewDeployment({...plan(),preparedAtUtc:new Date(at).toISOString()},context,at));
});
test('CIDR defaults reject /0, duplicates, malformed, too many and all unknown authority fields',()=>{
  for(const allowedSources of [[],['0.0.0.0/0'],['::/0'],['192.0.2.1'],['192.0.2.0/024'],['192.0.2.0/24','192.0.2.0/24'],Array.from({length:33},(_,i)=>`192.0.2.${i}/32`)])rejected(()=>previewDeployment(plan({...lan(),allowedSources}),context,now));
  for(const extra of [{sid:SID},{grants:[]},{trustedProxies:['127.0.0.1']},{registrationEnabled:'true'},{windowHours:169},{windowHours:0}])rejected(()=>previewDeployment(plan({...lan(),...extra}),context,now));
});
test('certificate/key paths are explicit strings and preview never opens them',()=>{
  const nonexistent=join(tmpdir(),'nonexistent-'+Date.now());assert.ok(previewDeployment(plan({...lan(),certificateFile:nonexistent+'.crt',privateKeyFile:nonexistent+'.key'}),context,now));
  for(const value of ['relative.crt','C:\\a\\..\\b.crt','\\\\server\\share\\x','C:\\secret.key:stream','C:\\a\\*.crt'])rejected(()=>previewDeployment(plan({...lan(),certificateFile:value}),context,now));
  rejected(()=>previewDeployment(plan({...lan(),privateKeyFile:certFile}),context,now));
});
test('initialization is exclusive and does not replace existing files, directories or builds',()=>{
  const x=fixture(),before=readFileSync(x.initialized.configFile);rejected(()=>initializeDeployment(x.target,x.build,9443,x.options));assert.deepEqual(readFileSync(x.initialized.configFile),before);
  const existing=join(x.root,'empty');mkdirSync(existing);rejected(()=>initializeDeployment(existing,x.build,9443,x.options));assert.equal(existsSync(join(existing,BOOTSTRAP_CONFIG)),false);
});
test('freshness permits local management only and forbids application tokens or registration migration',()=>{
  const x=fixture(),r=x.open();try{
    const wizard=new DeploymentWizard(r,x.initialized.configFile);assert.equal(wizard.status().eligible,true);
    r.withLocalActor(SID,()=>r.createLocalBrowserPairing('http://127.0.0.1:12345',[],true,60));assert.equal(wizard.status().eligible,true);
    const p=r.createPrincipal('Synthetic app','application');r.createCredential(p.id,'Synthetic token',[]);assert.equal(wizard.status().eligible,false);rejected(()=>wizard.preview({mode:'local',port:9443}));
  }finally{r.close();}
});
test('tampered bootstrap, output/claim existence and existing deployments cannot use the wizard',()=>{
  for(const variant of ['config','claim','output']){const x=fixture();if(variant==='config')writeFileSync(x.initialized.configFile,'{}');else writeFileSync(join(x.target,variant==='claim'?'.modeldb-deployment-commit.json':DEPLOYED_CONFIG),'{}');const r=x.open();try{assert.equal(new DeploymentWizard(r,x.initialized.configFile).status().eligible,false);}finally{r.close();}}
});
test('bootstrap binds the build path; altered marker cannot substitute another public bundle',()=>{
  const x=fixture(),path=join(x.target,'.modeldb-deployment.json'),marker=JSON.parse(readFileSync(path,'utf8'));marker.designerDirectory=join(x.root,'substituted-build');writeFileSync(path,JSON.stringify(marker));const r=x.open();try{assert.equal(new DeploymentWizard(r,x.initialized.configFile).status().eligible,false);}finally{r.close();}
});
test('finalize rejects replaced certificate data before claiming the commit',()=>{
  const x=fixture(),certificateFile=join(x.root,'certificate.crt');writeFileSync(certificateFile,pem);const p=x.preview({...lan(),certificateFile}),file=join(x.root,'plan.json');writeFileSync(file,JSON.stringify(p.plan));
  // A valid but different public certificate is generated by changing only its DER signature.
  const changed=Buffer.from(cert.raw);changed[changed.length-1]^=1;writeFileSync(certificateFile,'-----BEGIN CERTIFICATE-----\n'+changed.toString('base64').match(/.{1,64}/g)!.join('\n')+'\n-----END CERTIFICATE-----\n');
  rejected(()=>finalizeDeployment(x.target,file,p.digest,x.options),'SECURITY_POLICY_CONFLICT');assert.equal(existsSync(join(x.target,'.modeldb-deployment-commit.json')),false);
});
test('offline finalize keeps the identity, applies persistent policy, writes once and leaves bootstrap intact',()=>{
  const x=fixture(),before=readFileSync(x.initialized.configFile),p=x.preview(lan()),file=join(x.root,'plan.json');writeFileSync(file,JSON.stringify(p.plan));
  const held=x.open();try{rejected(()=>finalizeDeployment(x.target,file,p.digest,x.options),'SECURITY_INSTANCE_BUSY');}finally{held.close();}
  const result=finalizeDeployment(x.target,file,p.digest,x.options);assert.equal(result.instanceId,x.initialized.instanceId);assert.deepEqual(readFileSync(x.initialized.configFile),before);assert.equal(JSON.parse(readFileSync(result.configFile,'utf8')).security.registration.descriptor.registrationMode,'disabled');
  const r=x.open();try{assert.equal(r.status().instanceId,x.initialized.instanceId);assert.ok(r.protectionState()!.config.data.allow!.some(s=>s.source==='192.0.2.0/24'));assert.equal(r.protectionState()!.pending,undefined);assert.equal(new DeploymentWizard(r,x.initialized.configFile).status().eligible,false);}finally{r.close();}
  rejected(()=>finalizeDeployment(x.target,file,p.digest,x.options),'SECURITY_OUTCOME_UNCONFIRMED');
});
test('digest and certificate mismatch prevent a commit; linked or hard-linked inputs are rejected',()=>{
  const x=fixture(),p=x.preview(),file=join(x.root,'plan.json');writeFileSync(file,JSON.stringify(p.plan));rejected(()=>finalizeDeployment(x.target,file,'0'.repeat(64),x.options),'SECURITY_POLICY_CONFLICT');assert.equal(existsSync(join(x.target,DEPLOYED_CONFIG)),false);
  const hard=join(x.root,'hard.json');linkSync(file,hard);rejected(()=>finalizeDeployment(x.target,hard,p.digest,x.options));
  const link=join(x.root,'linked');symlinkSync(x.target,link,'junction');rejected(()=>deploymentPath(join(link,BOOTSTRAP_CONFIG)));
});
test('audit-capacity failure withholds preview without changing bootstrap or writing a plan',()=>{
  const x=fixture(),r=x.open();try{(r as unknown as {auditLimit:number}).auditLimit=r.auditEvents().length;rejected(()=>new DeploymentWizard(r,x.initialized.configFile).preview({mode:'local',port:9443}),'SECURITY_AUDIT_CAPACITY');assert.equal(existsSync(join(x.target,DEPLOYED_CONFIG)),false);}finally{r.close();}
});
test('partial commit preserves claim and denies automatic retries while bootstrap stays loopback',()=>{
  const x=fixture(),p=x.preview(),file=join(x.root,'plan.json');writeFileSync(file,JSON.stringify(p.plan));
  const r=x.open(),network=new SecurityNetworkPolicy({}, {host:'127.0.0.1',port:9443,directory:x.target}),protection=new SecurityProtection(r,network);protection.close();r.close();
  let commits=0;const options={...x.options,onCommitPoint:()=>{if(++commits===1)throw Error('synthetic commit failure');}};
  rejected(()=>finalizeDeployment(x.target,file,p.digest,options),'SECURITY_OUTCOME_UNCONFIRMED');assert.equal(existsSync(join(x.target,'.modeldb-deployment-commit.json')),true);assert.equal(JSON.parse(readFileSync(x.initialized.configFile,'utf8')).host,'127.0.0.1');rejected(()=>finalizeDeployment(x.target,file,p.digest,x.options),'SECURITY_OUTCOME_UNCONFIRMED');
});
test('CLI rejects missing consent, unknown/duplicate flags and config discovery before touching files',()=>{
  for(const args of [['deployment-init'],['deployment-init','--config','modeldb.config.json','--yes'],['deployment-finalize','--yes'],['deployment-init','--yes','--yes'],['deployment-init','--target','a','--target','b','--yes']])rejected(()=>runDeploymentCli(args));
  rejected(()=>dispatchSecurityControl({protection:{} as never},{action:'deployment.preview',draft:{mode:'local',port:9443}}),'SECURITY_FORBIDDEN');
});
test('public data and legacy management boundaries reject deployment commands, including forged actor',async()=>{
  const x=await hostingFixture();try{
    for(const url of [x.origin+'/api/v1/security/admin/control']){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'deployment.status',sid:SID})});assert.equal(r.status,404);}
    const r=await fetch(x.managementOrigin+'/api/v1/security/admin/control',{method:'POST',headers:{'content-type':'application/json',origin:x.managementOrigin},body:JSON.stringify({action:'deployment.status'})});assert.equal(r.status,401);
  }finally{await x.close();}
});
