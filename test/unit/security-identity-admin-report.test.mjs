import assert from 'node:assert/strict';
import {test} from 'node:test';
import {identityAdminChecks,parseIdentityAdminTap} from '../../scripts/security-identity-admin-check.mjs';
const fixture=()=>({format:'modeldb.identity-admin-browser.v1',ok:true,browser:'Chrome/156.0.0.0',screenshots:24,hardwareAuthenticatorTested:false,systemTrustInstalled:false,liveMaterialRead:false,checks:Object.fromEntries(identityAdminChecks.map(k=>[k,true]))});
const tap=b=>`# ${JSON.stringify(b)}\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
test('identity admin report accepts formal UI/native checks and accurate browser limits',()=>assert.equal(parseIdentityAdminTap(tap(fixture()),0).unit.pass,1));
test('identity admin report rejects incomplete, skipped or ambiguous TAP summaries',()=>{const good=tap(fixture());for(const bad of [good.replace('# tests 1','# tests 2'),good.replace('# skipped 0','# skipped 1'),good.replace('# fail 0',''),good+'# pass 1\n',good+'not ok 2 - hidden\n'])assert.throws(()=>parseIdentityAdminTap(bad,0));assert.throws(()=>parseIdentityAdminTap(good,1));});
test('identity admin report requires every formal UI check and one browser record',()=>{for(const key of identityAdminChecks){const b=fixture();b.checks[key]=false;assert.throws(()=>parseIdentityAdminTap(tap(b),0));}assert.throws(()=>parseIdentityAdminTap(tap(fixture())+tap(fixture()),0));});
test('identity admin report rejects hardware/trust inflation and missing layouts',()=>{for(const edit of [{hardwareAuthenticatorTested:true},{systemTrustInstalled:true},{liveMaterialRead:true},{screenshots:6},{browser:'SyntheticBrowser'}])assert.throws(()=>parseIdentityAdminTap(tap({...fixture(),...edit}),0));});
