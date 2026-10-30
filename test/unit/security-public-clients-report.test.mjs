import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePublicClientsTap, publicClientChecks } from '../../scripts/security-public-clients-check.mjs';

const report = app => ({ format:'modeldb.public-identity-browser.v1', app, ok:true, browser:'Chrome/156.0.0.0', screenshots:app==='web'?16:24, hardwareAuthenticatorTested:false, systemTrustInstalled:false, liveMaterialRead:false, checks:Object.fromEntries(publicClientChecks.map(k=>[k,true])) });
const tap = (reports=[report('data-studio'),report('web')]) => reports.map(r=>'# '+JSON.stringify(r)+'\n').join('') + ['model-designer','data-studio','web'].map(app=>'# [security-browser] '+app+': pairing, workspace, reload, HttpOnly and logout passed\n').join('') + ['model-designer','data-studio','web'].map(app=>'# [security-browser] '+app+': application credential controls, scoped listing and memory-only reload passed\n').join('') + '# tests 3\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
test('public clients report requires both real consumers and three legacy applications',()=>assert.equal(parsePublicClientsTap(tap(),0).unit.pass,3));
test('public clients report rejects failures, skip, missing/duplicate consumers and false boundaries',()=>{
  assert.throws(()=>parsePublicClientsTap(tap(),1));
  for(const input of [tap().replace('# skipped 0','# skipped 1'),tap([report('web')]),tap([report('web'),report('web')]),tap().replace('[security-browser] web:', '[missing] web:')]) assert.throws(()=>parsePublicClientsTap(input,0));
  for(const key of publicClientChecks){const r=report('web');r.checks[key]=false;assert.throws(()=>parsePublicClientsTap(tap([report('data-studio'),r]),0));}
});
test('public clients report rejects hardware/system trust/live material claims and screenshot drift',()=>{
  for(const edit of [r=>r.hardwareAuthenticatorTested=true,r=>r.systemTrustInstalled=true,r=>r.liveMaterialRead=true,r=>r.screenshots++]){const r=report('web');edit(r);assert.throws(()=>parsePublicClientsTap(tap([report('data-studio'),r]),0));}
});
test('public clients report rejects absent summaries and inflated counts',()=>{
  for(const input of [tap().replace('# tests 3',''),tap().replace('# pass 3','# pass 4'),tap()+'# pass 3\n',tap()+'not ok 4 - synthetic\n'])assert.throws(()=>parsePublicClientsTap(input,0));
});
