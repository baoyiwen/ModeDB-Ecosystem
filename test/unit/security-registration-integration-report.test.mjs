import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRegistrationIntegrationTap } from '../../scripts/security-registration-integration-check.mjs';

function fixture(){
  const browser={format:'modeldb.registration-virtual-authenticator.v1',ok:true,browser:'Chrome/140.0',checks:Object.fromEntries(['actualBrowserWebAuthn','nativeHttpsDpapiCli','approval','proofRejected','singleUseCompetition','revisionConflict','outstandingChallengeCapacity1000','localRepairAtCapacity','restartWithRegistrationDisabled','noBusinessSession','instanceKeyUnchanged'].map(k=>[k,true])),hardwareAuthenticatorTested:false,systemTrustInstalled:false};
  const tap=()=>`TAP version 13\n# ${JSON.stringify(browser)}\n1..9\n# tests 9\n# pass 9\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
  return {browser,tap};
}
test('integration report requires all nine cases and actual virtual-authenticator evidence',()=>{
  const f=fixture();assert.equal(parseRegistrationIntegrationTap(f.tap(),0).unit.pass,9);
});
test('integration report rejects failure, skip, cancellation, todo, count drift and duplicate summaries',()=>{
  const f=fixture();for(const text of [f.tap().replace('# skipped 0','# skipped 1'),f.tap().replace('# fail 0','# fail 1'),f.tap().replace('# cancelled 0','# cancelled 1'),f.tap().replace('# todo 0','# todo 1'),f.tap().replace('# pass 9','# pass 8'),f.tap()+'# pass 9\n',f.tap()+'not ok 9 - failed\n'])assert.throws(()=>parseRegistrationIntegrationTap(text,0));
  assert.throws(()=>parseRegistrationIntegrationTap(f.tap(),1));
});
test('integration report fails closed if native/browser/capacity or no-session checks are missing',()=>{
  for(const name of ['actualBrowserWebAuthn','nativeHttpsDpapiCli','outstandingChallengeCapacity1000','noBusinessSession']){const f=fixture();f.browser.checks[name]=false;assert.throws(()=>parseRegistrationIntegrationTap(f.tap(),0));}
  assert.throws(()=>parseRegistrationIntegrationTap(fixture().tap().replace(/^# \{.*\}\n/m,''),0));
});
test('integration evidence cannot claim hardware testing or install system trust',()=>{
  const f=fixture();f.browser.hardwareAuthenticatorTested=true;assert.throws(()=>parseRegistrationIntegrationTap(f.tap(),0));
  f.browser.hardwareAuthenticatorTested=false;f.browser.systemTrustInstalled=true;assert.throws(()=>parseRegistrationIntegrationTap(f.tap(),0));
});
