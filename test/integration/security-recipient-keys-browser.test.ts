/** New public-key association UI, native DPAPI and offline holder CLI; synthetic data only. */
import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { ensureModelDbLayoutAtRoot } from '../../packages/server/src/modeldb-default-home.js';
import { loadModelDBServerConfig } from '../../packages/server/src/config-loader.js';
import { buildDualTrackFastify } from '../../packages/server/src/dual-track-app.js';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';
import { callLocalSecurity } from '../../packages/server/src/security/local-management-channel.js';
import { WindowsSecretProtector } from '../../packages/server/src/security/windows-secret-protector.js';
import { createMigrationKey } from '../../packages/server/src/security/migration-key.js';
import { answerRecipientChallenge } from '../../packages/server/src/security/recipient-keys.js';
import { openMigrationKey } from '../../packages/server/src/security/migration-key.js';
import { hostedSecurityLaunchUrl } from '../../packages/server/src/cli-security.js';
import { registrationBrowser, waitFor } from '../fixtures/security-registration-browser.js';
import { utc } from '../fixtures/security-registration-integration.js';
import type { DeviceRegistrationConnectionDescriptorV1, RecipientChallenge, RecipientKeyPage } from '@mode-db/shared';

test('recipient UI verifies possession, replaces and retires versions, with offline CLI and localized layouts', {timeout:300000}, async t=>{
  assert.equal(process.platform,'win32','Native Windows is required');
  const root=mkdtempSync(join(tmpdir(),'ModeDB-Recipient-UI-')),dir=join(root,'security');
  const cfg=await loadModelDBServerConfig(ensureModelDbLayoutAtRoot(root),{port:0});
  const registry=SecurityRegistry.open(dir),instanceId=registry.status().instanceId;registry.close();
  const reservation=createServer();await new Promise<void>((done,fail)=>{reservation.once('error',fail);reservation.listen(0,'127.0.0.1',done);});
  const address=reservation.address();assert.ok(address&&typeof address!=='string');const port=address.port;
  await new Promise<void>((done,fail)=>reservation.close(e=>e?fail(e):done()));
  const origin=`https://modeldb-a.example.test:${port}`,tls=fileURLToPath(new URL('../fixtures/security-registration-tls/',import.meta.url));
  const cert=new X509Certificate(readFileSync(join(tls,'modeldb-a.crt'))),spki=createHash('sha256').update(cert.publicKey.export({type:'spki',format:'der'})).digest(),now=Date.now();
  const descriptor:DeviceRegistrationConnectionDescriptorV1={format:'modeldb.device-registration-connection.v1',version:1,instanceId,serverOrigin:origin,rpId:'modeldb-a.example.test',registrationMode:'enabled',issuedAtUtc:utc(now-1000),expiresAtUtc:utc(now+3600000),deploymentDescriptorSha256:'a'.repeat(64),tls:{mode:'owner-pinned',minVersion:'TLS1.2',spkiSha256:spki.toString('hex')}};
  const build=process.env.MODELDB_HOSTING_TEST_BUILD,screenshots=process.env.MODELDB_HOSTING_TEST_SCREENSHOTS;assert.ok(build);assert.ok(screenshots);mkdirSync(screenshots,{recursive:true});
  const options={...cfg,host:'127.0.0.1',port,publicBaseUrl:origin,securityMode:'registry' as const,securityAuthentication:{enabled:true,allowStorageMigration:true},securityRegistration:{descriptor,allowStorageMigration:true},securityHosting:{enabled:true,designerDirectory:build,managementPort:0},securityNetwork:{transport:{mode:'tls' as const,certificateFile:join(tls,'modeldb-a.crt'),privateKeyFile:join(tls,'modeldb-a.key')},data:{allowListEnabled:false}},securityAudit:{maxEvents:20000,retentionDays:365}};
  let app:Awaited<ReturnType<typeof buildDualTrackFastify>>|undefined,page:Awaited<ReturnType<typeof registrationBrowser>>|undefined;
  const local=(input:unknown)=>callLocalSecurity(dir,input);
  const click=async(selector:string)=>{await waitFor(()=>page!.evaluate<boolean>(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !!e&&!e.disabled;})()`),Boolean,30000);await page!.evaluate(`document.querySelector(${JSON.stringify(selector)}).click();true`);};
  const input=async(selector:string,value:string)=>{await page!.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);};
  const ready=()=>waitFor(()=>page!.evaluate<boolean>(`document.querySelector('.recipient-keys')?.getAttribute('aria-busy')==='false'`),Boolean,30000);
  const reload=async()=>{await click('[data-recipient-reload]');await ready();};
  const file=async(selector:string,path:string)=>{const dom=await page!.call<{root:{nodeId:number}}>('DOM.getDocument');const node=await page!.call<{nodeId:number}>('DOM.querySelector',{nodeId:dom.root.nodeId,selector});assert.ok(node.nodeId);await page!.call('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[path]});};
  const submit=async()=>{
    await waitFor(()=>page!.evaluate<boolean>(`document.activeElement===document.querySelector('[data-recipient-review]')`),Boolean);
    assert.equal(await page!.evaluate<boolean>(`document.querySelector('[data-recipient-submit]').disabled`),true);
    await click('[data-recipient-confirm]');await click('[data-recipient-submit]');await ready();
    assert.equal(await page!.evaluate<boolean>(`!!document.querySelector('[data-recipient-success]')&&!document.querySelector('[data-recipient-issue]')`),true);
  };
  const shot=async(scene:string)=>{
    for(const locale of ['zh','en','ja'])for(const width of [1280,390]){
      await page!.call('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:false});
      await input('.designer-language-selector select',locale);
      const messages=JSON.parse(readFileSync(join('apps/model-designer/src/i18n/locales',locale,'ui.json'),'utf8')) as Record<string,string>;
      await waitFor(()=>page!.evaluate<string>(`document.querySelector('.recipient-keys h2')?.textContent`),v=>v===messages.recipientKeys_title);
      assert.equal(await page!.evaluate<boolean>(`(()=>{const r=document.querySelector('.recipient-keys');return document.documentElement.scrollWidth<=innerWidth&&r.scrollWidth<=r.clientWidth+1&&[...r.querySelectorAll('input,select')].every(e=>e.labels.length>0)&&!r.textContent.includes('recipientKeys_')&&!r.textContent.includes('modeldb.recipient-proof.v1');})()`),true,'localized layout '+scene+locale+width);
      await page!.evaluate(`document.querySelector(${JSON.stringify(scene==='review'?'[data-recipient-review]':scene==='history'?'.recipient-keys-list':'.recipient-keys')}).scrollIntoView({block:'start',behavior:'instant'});true`);
      const image=await page!.call<{data:string}>('Page.captureScreenshot',{format:'png'});writeFileSync(join(screenshots,scene+'-'+locale+'-'+width+'.png'),Buffer.from(image.data,'base64'));
    }
    await page!.call('Emulation.setDeviceMetricsOverride',{width:1280,height:1100,deviceScaleFactor:1,mobile:false});
    if(scene==='review') { await page!.evaluate(`document.querySelector('[data-recipient-review]').focus();true`); }
  };
  try {
    app=await buildDualTrackFastify(options);page=await registrationBrowser(root,spki.toString('base64'));
    await page.call('Page.navigate',{url:origin+'/designer/'});await waitFor(()=>page!.evaluate<boolean>(`document.querySelector('.designer-identity')?.getAttribute('aria-busy')==='false'`),Boolean,30000);
    await page.evaluate(`document.querySelector('.designer-identity details').open=true;true`);await input('[data-identity-name]','Synthetic recipient owner');await click('[data-identity-register]');
    await waitFor(()=>page!.evaluate<string>(`document.querySelector('[data-identity-state]')?.getAttribute('data-identity-state')`),v=>v==='pending',30000);
    const registrationId=await page.evaluate<string>(`document.querySelector('[data-identity-state] dd').textContent`);
    const list=await local({action:'registration.list',instanceId}) as {revision:number};
    const approved=await local({action:'registration.approve',instanceId,id:registrationId,revision:list.revision,confirm:true,name:'Synthetic recipient owner',grants:[]}) as {userId:string;credentialId:string};
    const launch=await local({action:'browser.hosted.security.launch'}) as {origin:string;url:string;code:string};
    await page.call('Page.navigate',{url:hostedSecurityLaunchUrl(launch).href});
    await waitFor(()=>page!.evaluate<boolean>(`!!document.querySelector('.security-center-navigation-title')`),Boolean,30000);
    await input('.designer-language-selector select','en');
    await page.evaluate(`[...document.querySelectorAll('.security-center-navigation nav button')].find(e=>e.textContent==='Recipient keys').click();true`);await ready();
    await click('[data-recipient-initialize]');await submit();await reload();
    const protector=new WindowsSecretProtector(),holder=join(root,'holder'),output=join(root,'proofs'),transfer=join(root,'transfer');protector.ensureDirectory(holder);protector.ensureDirectory(output);mkdirSync(transfer);
    const passphrase='synthetic-recipient-only-'+createHash('sha256').update(root).digest('hex'),material=createMigrationKey(passphrase),privateFile=join(holder,'recipient.private.json'),publicFile=join(transfer,'recipient.pem'),phraseFile=join(holder,'phrase.txt');
    writeFileSync(privateFile,material.privateKey,{flag:'wx'});writeFileSync(phraseFile,passphrase,{flag:'wx'});writeFileSync(publicFile,material.publicKey,{flag:'wx'});material.privateKey.fill(0);
    await input('[data-recipient-user]',approved.userId);await file('[data-recipient-public]',publicFile);await waitFor(()=>page!.evaluate<boolean>(`!!document.querySelector('[data-recipient-public-ready]')`),Boolean);await click('[data-recipient-begin]');await submit();await shot('challenge');
    await page.call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:transfer});await click('[data-recipient-download]');
    const challengeFile=join(transfer,'recipient-challenge.json');await waitFor(async()=>existsSync(challengeFile),Boolean);
    const challenge=JSON.parse(readFileSync(challengeFile,'utf8')) as RecipientChallenge;assert.equal(challenge.userId,approved.userId);assert.equal(challenge.fingerprint,material.recipientId);
    const tool=(args:string[])=>spawnSync(process.execPath,[fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs',import.meta.url)),fileURLToPath(new URL('../../scripts/security-recipient-key.ts',import.meta.url)),...args],{encoding:'utf8',windowsHide:true});
    const inspect=tool(['inspect','--challenge',challengeFile]);assert.equal(inspect.status,0,inspect.stderr);const metadata=JSON.parse(inspect.stdout) as {bindingDigest:string;binding:{fingerprint:string}};assert.equal(metadata.binding.fingerprint,material.recipientId);
    const proofFile=join(output,'proof.json'),args=['prove','--challenge',challengeFile,'--private-key',privateFile,'--passphrase-file',phraseFile,'--output',proofFile,'--binding-digest',metadata.bindingDigest];
    const bad=tool([...args.slice(0,-1),'0'.repeat(64)]);assert.equal(bad.status,1);assert.equal(existsSync(proofFile),false);assert.match(bad.stderr,/^SECURITY_RECIPIENT_TOOL_FAILED\s*$/);
    const proved=tool(args);assert.equal(proved.status,0,proved.stderr);assert.doesNotMatch(proved.stdout,/"proof"|PRIVATE KEY|scrypt/);assert.equal(tool(args).status,1,'Existing proof is not overwritten');
    await file('[data-recipient-proof]',proofFile);await click('[data-recipient-complete]');await shot('review');await submit();await reload();
    let keys=await local({action:'registration.recipient.list',instanceId}) as RecipientKeyPage;assert.equal(keys.total,1);assert.equal(keys.keys[0].state,'active');
    // Fresh independent key: the original private key is intentionally not needed for recovery replacement.
    await reload();const nextMaterial=createMigrationKey(passphrase),nextPublic=join(transfer,'replacement.pem');writeFileSync(nextPublic,nextMaterial.publicKey);await input('[data-recipient-user]',approved.userId);await file('[data-recipient-public]',nextPublic);await click('[data-recipient-begin]');await submit();
    // Downloaded challenge, then prove with the same offline API (CLI covered above).
    await page.call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:output});await click('[data-recipient-download]');const nextChallenge=join(output,'recipient-challenge.json');await waitFor(async()=>existsSync(nextChallenge),Boolean);
    const next=JSON.parse(readFileSync(nextChallenge,'utf8')) as RecipientChallenge;assert.equal(next.keyVersion,2);assert.equal(next.previousKeyId,keys.keys[0].id);
    const proof=answerRecipientChallenge(next,openMigrationKey(nextMaterial.privateKey,passphrase));nextMaterial.privateKey.fill(0);const nextProof=join(output,'replacement-proof.json');writeFileSync(nextProof,JSON.stringify(proof));
    await file('[data-recipient-proof]',nextProof);await click('[data-recipient-complete]');await submit();await reload();await shot('history');
    keys=await local({action:'registration.recipient.list',instanceId}) as RecipientKeyPage;assert.deepEqual(keys.keys.map(k=>k.state),['retired','active']);
    await reload();await click('[data-recipient-retire]');
    await local({action:'registration.recipient.list',instanceId});await click('[data-recipient-confirm]');await click('[data-recipient-submit]');await ready();assert.equal(await page.evaluate<string>(`document.querySelector('[data-recipient-issue]')?.getAttribute('data-recipient-issue')`),'conflict');
    await reload();await click('[data-recipient-retire]');await submit();await reload();keys=await local({action:'registration.recipient.list',instanceId}) as RecipientKeyPage;assert.ok(keys.keys.every(k=>k.state==='retired'));
    assert.equal(await page.evaluate<boolean>(`!Object.keys(localStorage).some(k=>/recipient|proof/i.test(k))&&!Object.keys(sessionStorage).some(k=>/recipient|proof/i.test(k))`),true);
    await app.close();app=undefined;app=await buildDualTrackFastify(options);const reboot=await local({action:'registration.recipient.list',instanceId}) as RecipientKeyPage;assert.deepEqual(reboot.keys,keys.keys);
    t.diagnostic(JSON.stringify({format:'modeldb.recipient-browser.v1',ok:true,browser:page.version,screenshots:18,hardwareAuthenticatorTested:false,systemTrustInstalled:false,liveMaterialRead:false,checks:{freshDesignerBuild:true,nativeDpapi:true,osPairedManagement:true,explicitMigration:true,uiPublicImport:true,uiChallengeDownload:true,offlineInspect:true,offlineProof:true,wrongBindingRejected:true,noOverwrite:true,explicitConfirmation:true,uiAssociation:true,uiReplacement:true,uiRetirement:true,conflictRequiresReload:true,noWebStorageSecrets:true,restartHistory:true,localizedZhEnJa:true,wideAndNarrow:true,labelsAndFocus:true}}));
  }finally{await page?.close();await app?.close();}
});
