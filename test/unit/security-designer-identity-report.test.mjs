import assert from 'node:assert/strict';
import {test} from 'node:test';
import {identityBrowserChecks,parseIdentityBrowserTap} from '../../scripts/security-designer-identity-check.mjs';
const fixture=()=>({format:'modeldb.designer-identity-browser.v1',ok:true,browser:'Chrome/156.0.0.0',screenshots:24,hardwareAuthenticatorTested:false,systemTrustInstalled:false,liveMaterialRead:false,checks:Object.fromEntries(identityBrowserChecks.map(k=>[k,true]))});
const tap=b=>`# ${JSON.stringify(b)}\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
test('identity report accepts formal UI/native checks and accurate browser limits',()=>assert.equal(parseIdentityBrowserTap(tap(fixture()),0).unit.pass,1));
test('identity report rejects incomplete, skipped or ambiguous TAP summaries',()=>{const good=tap(fixture());for(const bad of [good.replace('# tests 1','# tests 2'),good.replace('# skipped 0','# skipped 1'),good.replace('# fail 0',''),good+'# pass 1\n',good+'not ok 2 - hidden\n'])assert.throws(()=>parseIdentityBrowserTap(bad,0));assert.throws(()=>parseIdentityBrowserTap(good,1));});
test('identity report requires every formal UI check and one browser record',()=>{for(const key of identityBrowserChecks){const b=fixture();b.checks[key]=false;assert.throws(()=>parseIdentityBrowserTap(tap(b),0));}assert.throws(()=>parseIdentityBrowserTap(tap(fixture())+tap(fixture()),0));});
test('identity report rejects hardware/trust inflation and missing layouts',()=>{for(const edit of [{hardwareAuthenticatorTested:true},{systemTrustInstalled:true},{liveMaterialRead:true},{screenshots:6},{browser:'SyntheticBrowser'}])assert.throws(()=>parseIdentityBrowserTap(tap({...fixture(),...edit}),0));});
