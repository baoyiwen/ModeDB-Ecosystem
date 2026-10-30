import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseDeploymentTap,deploymentChecks} from '../../scripts/security-deployment-wizard-check.mjs';
const fixture=()=>({format:'modeldb.deployment-wizard-browser.v1',ok:true,browser:'Chrome/156.0.0.0',screenshots:24,hardwareAuthenticatorTested:false,systemTrustInstalled:false,liveMaterialRead:false,checks:Object.fromEntries(deploymentChecks.map(k=>[k,true]))});
const tap=x=>`# ${JSON.stringify(x)}\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
test('deployment report requires actual browser and all native, preview, offline and UI checks',()=>{assert.equal(parseDeploymentTap(tap(fixture()),0).unit.pass,1);});
test('deployment report rejects missing/duplicate records, process failure, skips and count drift',()=>{const good=tap(fixture());for(const bad of [good.replace('# tests 1','# tests 2'),good.replace('# skipped 0','# skipped 1'),good.replace('# todo 0',''),good+'# pass 1\n',good+'not ok 1 - hidden\n',good.split('\n').slice(1).join('\n'),good+good.split('\n')[0]+'\n'])assert.throws(()=>parseDeploymentTap(bad,0));assert.throws(()=>parseDeploymentTap(good,1));});
test('deployment report rejects every missing native/browser acceptance gate',()=>{for(const check of deploymentChecks){const x=fixture();delete x.checks[check];assert.throws(()=>parseDeploymentTap(tap(x),0));}});
test('deployment report rejects inflated physical trust/hardware claims and incomplete visuals',()=>{for(const change of [{hardwareAuthenticatorTested:true},{systemTrustInstalled:true},{liveMaterialRead:true},{screenshots:6},{browser:'SyntheticChrome'}])assert.throws(()=>parseDeploymentTap(tap({...fixture(),...change}),0));});
