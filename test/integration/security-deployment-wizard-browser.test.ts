/** Native new-instance wizard, explicit CLI commit and synthetic TLS. Never bind LAN interfaces. */
import assert from 'node:assert/strict';
import {createHash,X509Certificate} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {test} from 'node:test';
import {buildDualTrackFastify} from '../../packages/server/src/dual-track-app.js';
import {loadModelDBServerConfig} from '../../packages/server/src/config-loader.js';
import {callLocalSecurity} from '../../packages/server/src/security/local-management-channel.js';
import {hostedSecurityLaunchUrl} from '../../packages/server/src/cli-security.js';
import {SecurityRegistry} from '../../packages/server/src/security/security-registry.js';
import {registrationBrowser,waitFor} from '../fixtures/security-registration-browser.js';
import {DEVICE_REGISTRATION_API_V1 as API} from '@mode-db/shared';

test('first deployment wizard: safe defaults, certificate/RP checks, descriptor import, offline CLI and localized layouts',{timeout:300000},async t=>{
  assert.equal(process.platform,'win32');
  const root=mkdtempSync(join(tmpdir(),'ModeDB-Deployment-Native-')),target=join(root,'instance'),downloads=join(root,'downloads');mkdirSync(downloads);
  const build=process.env.MODELDB_HOSTING_TEST_BUILD,screenshots=process.env.MODELDB_HOSTING_TEST_SCREENSHOTS;assert.ok(build);assert.ok(screenshots);mkdirSync(screenshots,{recursive:true});
  const certFile=resolve('test/fixtures/security-registration-tls/modeldb-a.crt'),keyFile=resolve('test/fixtures/security-registration-tls/modeldb-a.key');
  const cert=new X509Certificate(readFileSync(certFile)),spki=createHash('sha256').update(cert.publicKey.export({type:'spki',format:'der'})).digest();
  const reservation=createServer();await new Promise<void>((done,fail)=>{reservation.once('error',fail);reservation.listen(0,'127.0.0.1',done);});const address=reservation.address();assert.ok(address&&typeof address!=='string');const port=address.port;await new Promise<void>(done=>reservation.close(()=>done()));
  const origin='https://modeldb-a.example.test:'+port;
  const cli=(args:string[])=>spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs','packages/server/src/cli.ts','security',...args],{encoding:'utf8',windowsHide:true,timeout:60000});
  const initialized=cli(['deployment-init','--target',target,'--designer',build,'--port',String(port),'--yes']);assert.equal(initialized.status,0,initialized.stderr);const initial=JSON.parse(initialized.stdout) as {instanceId:string;configFile:string};
  const bootstrap=readFileSync(initial.configFile),cfg=await loadModelDBServerConfig(initial.configFile,{});assert.equal(cfg.host,'127.0.0.1');assert.equal(cfg.securityRegistration,undefined);
  let app:Awaited<ReturnType<typeof buildDualTrackFastify>>|undefined,page:Awaited<ReturnType<typeof registrationBrowser>>|undefined;
  const input=async(selector:string,value:string)=>{await page!.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);};
  const click=async(selector:string)=>{await waitFor(()=>page!.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`),Boolean,30000);await page!.evaluate(`document.querySelector(${JSON.stringify(selector)}).click();true`);};
  const upload=async(selector:string,file:string)=>{const doc=await page!.call<{root:{nodeId:number}}>('DOM.getDocument'),node=await page!.call<{nodeId:number}>('DOM.querySelector',{nodeId:doc.root.nodeId,selector});await page!.call('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[file]});await waitFor(()=>page!.evaluate<boolean>(`document.querySelector('.deployment-wizard').getAttribute('aria-busy')==='false'`),Boolean);};
  const open=async()=>{
    const launch=await callLocalSecurity(join(target,'security'),{action:'browser.hosted.security.launch'}) as {url:string;origin:string;code:string};
    await page!.call('Page.navigate',{url:hostedSecurityLaunchUrl(launch).href});await waitFor(()=>page!.evaluate<boolean>(`!!document.querySelector('.security-center-navigation-title')`),Boolean,30000);
    const label=JSON.parse(readFileSync('apps/model-designer/src/i18n/locales/zh/ui.json','utf8')).securityCenterTab_deployment;
    await input('.designer-language-selector select','zh');await waitFor(()=>page!.evaluate<boolean>(`[...document.querySelectorAll('.security-center-navigation nav button')].some(b=>b.textContent===${JSON.stringify(label)})`),Boolean);
    await page!.evaluate(`[...document.querySelectorAll('.security-center-navigation nav button')].find(b=>b.textContent===${JSON.stringify(label)}).click();true`);
    await waitFor(()=>page!.evaluate<boolean>(`!!document.querySelector('[data-deployment-mode]')||!!document.querySelector('[data-deployment-existing]')`),Boolean,30000);
  };
  const shot=async(scene:string)=>{
    for(const locale of ['zh','en','ja'])for(const width of [1280,390]){
      await page!.call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await input('.designer-language-selector select',locale);
      const messages=JSON.parse(readFileSync(`apps/model-designer/src/i18n/locales/${locale}/ui.json`,'utf8')) as Record<string,string>;
      await waitFor(()=>page!.evaluate<string>(`document.querySelector('.deployment-wizard h2')?.textContent`),v=>v===messages.deployment_title);
      assert.equal(await page!.evaluate<boolean>(`(()=>{const r=document.querySelector('.deployment-wizard');return document.documentElement.scrollWidth<=innerWidth&&r.scrollWidth<=r.clientWidth+1&&[...r.querySelectorAll('input,select,textarea')].every(e=>e.labels.length>0)&&!r.textContent.includes('deployment_');})()`),true,'layout '+scene+locale+width);
      assert.equal(await page!.evaluate<boolean>(`(()=>{const lum=c=>c.match(/[\\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;}).reduce((n,v,i)=>n+v*[0.2126,0.7152,0.0722][i],0);return [...document.querySelectorAll('.deployment-wizard input:not([type=checkbox]),.deployment-wizard select,.deployment-wizard textarea')].every(e=>{const s=getComputedStyle(e),a=lum(s.color),b=lum(s.backgroundColor);return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)>=4.5;});})()`),true,'form contrast');
      await page!.evaluate(`document.querySelector(${JSON.stringify(scene==='review'?'[data-deployment-review]':'.deployment-wizard')}).scrollIntoView({block:'start',behavior:'instant'});true`);
      const image=await page!.call<{data:string}>('Page.captureScreenshot',{format:'png'});writeFileSync(join(screenshots,`${scene}-${locale}-${width}.png`),Buffer.from(image.data,'base64'));
    }
    await page!.call('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
  };
  try{
    app=await buildDualTrackFastify(cfg);page=await registrationBrowser(root,spki.toString('base64'));await page.call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});await open();
    assert.equal(await page.evaluate<string>(`document.querySelector('[data-deployment-mode]').value`),'local');await shot('local');await input('[data-deployment-port]',String(port));await click('[data-deployment-preview]');
    await waitFor(()=>page!.evaluate<boolean>(`!!document.querySelector('[data-deployment-review]')`),Boolean);assert.equal(await page.evaluate<boolean>(`document.querySelector('[data-deployment-export]').disabled`),true);assert.equal(existsSync(join(target,'modeldb.deployment.json')),false);
    await click('[data-deployment-edit]');await input('[data-deployment-mode]','lan');assert.equal(await page.evaluate<boolean>(`document.querySelector('[data-deployment-enable]').checked`),false);await shot('lan');
    await input('[data-deployment-origin]',origin);await input('[data-deployment-rp]','wrong.example.test');await input('[data-deployment-cert]',certFile);await input('[data-deployment-key]',keyFile);await input('[data-deployment-sources]','192.0.2.0/24');
    // A private key is rejected by the browser before submission; only public PEM is uploaded.
    await upload('[data-deployment-pem]',keyFile);assert.equal(await page.evaluate<boolean>(`!!document.querySelector('[data-deployment-error]')`),true);await upload('[data-deployment-pem]',certFile);await click('[data-deployment-preview]');
    await waitFor(()=>page!.evaluate<boolean>(`!!document.querySelector('[data-deployment-error]')`),Boolean);assert.equal(existsSync(join(target,'modeldb.deployment.json')),false);
    await input('[data-deployment-rp]','modeldb-a.example.test');await input('[data-deployment-tls]','owner-pinned');await input('[data-deployment-pin]','0'.repeat(64));await click('[data-deployment-preview]');await waitFor(()=>page!.evaluate<boolean>(`!!document.querySelector('[data-deployment-error]')`),Boolean);
    await input('[data-deployment-pin]',spki.toString('hex'));await click('[data-deployment-preview]');await waitFor(()=>page!.evaluate<boolean>(`!!document.querySelector('[data-deployment-review]')`),Boolean);assert.equal(await page.evaluate<boolean>(`document.activeElement===document.querySelector('[data-deployment-review]')`),true);await shot('review');
    const digest=await page.evaluate<string>(`document.querySelector('[data-deployment-digest]').textContent`);
    await page.evaluate(`window.deploymentOriginalNow=Date.now;Date.now=()=>window.deploymentOriginalNow()+600001;true`);await waitFor(()=>page!.evaluate<boolean>(`!!document.querySelector('[data-deployment-expired]')&&document.querySelector('[data-deployment-export]').disabled`),Boolean);
    await page.evaluate(`Date.now=window.deploymentOriginalNow;delete window.deploymentOriginalNow;true`);await waitFor(()=>page!.evaluate<boolean>(`!document.querySelector('[data-deployment-expired]')`),Boolean);
    for(let i=0;i<3;i++)await click('[data-deployment-check="'+i+'"]');await click('[data-deployment-export]');await click('[data-deployment-download]');
    const planFile=join(downloads,'modeldb-deployment-plan.json'),descriptorFile=join(downloads,'modeldb-connection.json');await waitFor(async()=>existsSync(planFile)&&existsSync(descriptorFile),Boolean);
    const plan=JSON.parse(readFileSync(planFile,'utf8')),descriptor=JSON.parse(readFileSync(descriptorFile,'utf8'));assert.equal(plan.instanceId,initial.instanceId);assert.equal(plan.draft.registrationEnabled,false);assert.equal(descriptor.registrationMode,'disabled');assert.doesNotMatch(JSON.stringify(descriptor),/PRIVATE KEY|grants|certificateFile|privateKeyFile/);
    const wrong=join(root,'wrong-descriptor.json');writeFileSync(wrong,JSON.stringify({...descriptor,instanceId:'11111111-1111-4111-8111-111111111111'}));await upload('[data-deployment-import]',wrong);assert.equal(await page.evaluate<boolean>(`!!document.querySelector('[data-deployment-error]')`),true);await upload('[data-deployment-import]',descriptorFile);assert.equal(await page.evaluate<boolean>(`!!document.querySelector('[data-deployment-imported]')`),true);
    const busy=cli(['deployment-finalize','--target',target,'--plan',planFile,'--digest',digest,'--yes']);assert.equal(busy.status,1);assert.match(busy.stderr,/SECURITY_INSTANCE_BUSY/);
    await app.close();app=undefined;const committed=cli(['deployment-finalize','--target',target,'--plan',planFile,'--digest',digest,'--yes']);assert.equal(committed.status,0,committed.stderr);const result=JSON.parse(committed.stdout);assert.equal(result.instanceId,initial.instanceId);assert.deepEqual(readFileSync(initial.configFile),bootstrap);
    const registry=SecurityRegistry.open(join(target,'security'));try{assert.ok(registry.protectionState()!.config.data.allow!.some(r=>r.source==='192.0.2.0/24'));assert.equal(registry.protectionState()!.pending,undefined);assert.ok(registry.auditEvents().some(e=>e.action==='deployment.preview'&&e.source?.transport==='http'));assert.doesNotMatch(JSON.stringify(registry.auditEvents()),/BEGIN CERTIFICATE|PRIVATE KEY|certificateFile|privateKeyFile/);}finally{registry.close();}
    const deployed=await loadModelDBServerConfig(result.configFile,{});assert.equal(deployed.host,'0.0.0.0');
    // Keep the generated LAN candidate intact; integration listeners remain on random loopback only.
    app=await buildDualTrackFastify({...deployed,host:'127.0.0.1'});await open();await shot('existing');assert.equal(await page.evaluate<boolean>(`!!document.querySelector('[data-deployment-existing]')`),true);
    await page.call('Page.navigate',{url:origin+'/designer/'});await waitFor(()=>page!.evaluate<boolean>(`document.readyState==='complete'&&!!document.querySelector('.designer-identity')`),Boolean,30000);
    assert.equal(await page.evaluate<string>(`fetch(${JSON.stringify(API.descriptor)}).then(r=>r.json()).then(d=>d.registrationMode)`),'disabled','Public descriptor does not open registration');
    assert.equal(await page.evaluate<number>(`fetch(${JSON.stringify(API.begin)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({format:'modeldb.device-registration.v1',version:1,instanceId:${JSON.stringify(initial.instanceId)},deploymentDescriptorSha256:${JSON.stringify(descriptor.deploymentDescriptorSha256)},displayName:'Synthetic disabled application',userVerification:'required'})}).then(r=>r.status)`),403,'New applications stay disabled');
    assert.equal(await page.evaluate<number>(`fetch('/api/v1/security/admin/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'deployment.status'})}).then(r=>r.status)`),404);
    assert.equal(cli(['deployment-finalize','--target',target,'--plan',planFile,'--digest',digest,'--yes']).status,1);
    t.diagnostic(JSON.stringify({format:'modeldb.deployment-wizard-browser.v1',ok:true,browser:page.version,screenshots:24,hardwareAuthenticatorTested:false,systemTrustInstalled:false,liveMaterialRead:false,checks:{freshDesignerBuild:true,nativeDpapi:true,osPairedManagement:true,loopbackBootstrap:true,registrationDisabledByDefault:true,publicPemOnly:true,wrongRpRejected:true,wrongPinRejected:true,previewDoesNotWrite:true,explicitConfirmation:true,descriptorImportBinding:true,descriptorDownload:true,offlineLeaseRequired:true,cliFinalize:true,identityPreserved:true,persistentPolicyApplied:true,oneShotCommit:true,existingInstanceGuide:true,auditMetadataOnly:true,syntheticTlsStartup:true,dataListenerDenied:true,localizedZhEnJa:true,wideAndNarrow:true,labelsAndFocus:true,formContrast:true,expiredExportBlocked:true}}));
  }finally{await page?.close();await app?.close();}
});
