import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRequiredTap,assertRegressionReport,engineIntegrations } from '../../scripts/security-regression-contract.mjs';
const tap='# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
test('full regression requires unique complete TAP counts and successful process',()=>{
  assert.equal(parseRequiredTap(tap,0).pass,2);
  for(const text of [tap+'# pass 2\n',tap.replace('# skipped 0','# skipped 1'),tap.replace('# tests 2','# tests 3'),tap.replace('# fail 0\n',''),tap+'not ok 3 - failed\n',tap+'ok 3 - omitted # SKIP missing\n'])assert.throws(()=>parseRequiredTap(text,0));
  assert.throws(()=>parseRequiredTap(tap,1));
});
test('full regression rejects missing engine flows, duplicate unit files, timeout and skip',()=>{
  const fixture=()=>({format:'modeldb.security-regression.v1',ok:true,unitFiles:['synthetic.test.ts'],unit:parseRequiredTap(tap,0),integrationScripts:engineIntegrations,results:['unit',...engineIntegrations].map(name=>({name,exitCode:0,timedOut:false}))});
  assertRegressionReport(fixture());
  for(const mutate of [r=>r.results.pop(),r=>r.unitFiles.push(r.unitFiles[0]),r=>r.results[0].timedOut=true,r=>r.unit.skip=1]){const r=fixture();mutate(r);assert.throws(()=>assertRegressionReport(r));}
});
