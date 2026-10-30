import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRecipientTap, recipientChecks } from '../../scripts/security-recipient-check.mjs';
const browser={format:'modeldb.recipient-browser.v1',ok:true,browser:'Chrome/156',screenshots:18,hardwareAuthenticatorTested:false,systemTrustInstalled:false,liveMaterialRead:false,checks:Object.fromEntries(recipientChecks.map(k=>[k,true]))};
const tap=(value=browser)=>'# '+JSON.stringify(value)+'\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
test('recipient report requires exact native counts, checks and scope',()=>{assert.equal(parseRecipientTap(tap(),0).unit.pass,1);});
test('recipient report rejects failures, skips and missing or duplicate diagnostics',()=>{
  for(const value of [tap().replace('# skipped 0','# skipped 1'),tap().replace('# pass 1','# pass 0'),tap().replace('# tests 1','# tests 2'),tap().replace(/^# .*\n/,''),tap()+'# '+JSON.stringify(browser)+'\n',tap()+'# TODO omitted\n'])assert.throws(()=>parseRecipientTap(value,0));
  assert.throws(()=>parseRecipientTap(tap(),1));
});
test('recipient report rejects untested scope and incomplete browser evidence',()=>{
  for(const value of [{...browser,hardwareAuthenticatorTested:true},{...browser,liveMaterialRead:true},{...browser,screenshots:0},{...browser,browser:'synthetic'},{...browser,checks:{...browser.checks,offlineProof:false}},{...browser,checks:{}}])assert.throws(()=>parseRecipientTap(tap(value),0));
});
