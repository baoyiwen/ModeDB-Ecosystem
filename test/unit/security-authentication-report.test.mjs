import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAuthenticationIntegrationTap } from '../../scripts/security-authentication-integration-check.mjs';

function fixture(){
  const browser={format:'modeldb.authentication-browser.v1',ok:true,browser:'Chrome/140.0',checks:Object.fromEntries(['actualBrowserWebAuthnGet','freshSdkBundle','nativeTlsDpapiApproval','pendingDenied','httpOnlySecureStrict','dataScope','adminDenied','reloadRecovery','csrfRotation','logout','restartRecovery','disabledNewLogin','expiredRegistrationIndependent','noApiCredential','instanceKeyUnchanged'].map(k=>[k,true])),hardwareAuthenticatorTested:false,systemTrustInstalled:false};
  const tap=()=>`TAP version 13\n# ${JSON.stringify(browser)}\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
  return {browser,tap};
}
test('integration report requires all one cases and actual virtual-authenticator evidence',()=>{
  const f=fixture();assert.equal(parseAuthenticationIntegrationTap(f.tap(),0).unit.pass,1);
});
test('integration report rejects failure, skip, cancellation, todo, count drift and duplicate summaries',()=>{
  const f=fixture();for(const text of [f.tap().replace('# skipped 0','# skipped 1'),f.tap().replace('# fail 0','# fail 1'),f.tap().replace('# cancelled 0','# cancelled 1'),f.tap().replace('# todo 0','# todo 1'),f.tap().replace('# pass 1','# pass 0'),f.tap()+'# pass 1\n',f.tap()+'not ok 9 - failed\n'])assert.throws(()=>parseAuthenticationIntegrationTap(text,0));
  assert.throws(()=>parseAuthenticationIntegrationTap(f.tap(),1));
});
test('integration report fails closed if native/browser/session checks are missing',()=>{
  for(const name of ['actualBrowserWebAuthnGet','nativeTlsDpapiApproval','httpOnlySecureStrict','csrfRotation','noApiCredential']){const f=fixture();f.browser.checks[name]=false;assert.throws(()=>parseAuthenticationIntegrationTap(f.tap(),0));}
  assert.throws(()=>parseAuthenticationIntegrationTap(fixture().tap().replace(/^# \{.*\}\n/m,''),0));
});
test('integration evidence cannot claim hardware testing or install system trust',()=>{
  const f=fixture();f.browser.hardwareAuthenticatorTested=true;assert.throws(()=>parseAuthenticationIntegrationTap(f.tap(),0));
  f.browser.hardwareAuthenticatorTested=false;f.browser.systemTrustInstalled=true;assert.throws(()=>parseAuthenticationIntegrationTap(f.tap(),0));
});
