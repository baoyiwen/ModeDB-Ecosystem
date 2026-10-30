import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAuthenticationResilienceTap } from '../../scripts/security-authentication-resilience-check.mjs';

function fixture() {
  const matrix = {format: 'modeldb.authentication-resilience-matrix.v1', ok: true, hardExitCases: 30, signedRaceCases: 10, auditFaultCases: 4, checks: Object.fromEntries(['hardProcessExits','atomicSessionAudit','unknownOutcomeInspectable','noRevivalAfterRestart','disableEnableProofBarrier','latestReduction','maintenanceCas','legacyApiPairingManagement','noSecretsInLogs'].map(k=>[k,true])), liveMaterialRead: false, hardwareAuthenticatorTested: false};
  const tap = () => '# ' + JSON.stringify(matrix) + '\n# tests 55\n# pass 55\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  return {matrix,tap};
}
test('requires complete synthetic process-exit and signed-race evidence with explicit hardware limits', () => {
  const f=fixture(), r=parseAuthenticationResilienceTap(f.tap(),0);
  assert.equal(r.unit.pass,55); assert.equal(r.matrix.hardExitCases,30); assert.equal(r.matrix.hardwareAuthenticatorTested,false);
});
test('rejects missing, duplicate, skipped, failed and count-drifted resilience TAP', () => {
  const f=fixture(), tap=f.tap();
  for(const text of [tap.replace(/^# \{.*\}\n/m,''),tap+'# pass 55\n',tap.replace('# skipped 0','# skipped 1'),tap.replace('# tests 55','# tests 54'),tap+'not ok 55 - failed\n',tap+'# SKIP disabled\n']) assert.throws(()=>parseAuthenticationResilienceTap(text,0));
  assert.throws(()=>parseAuthenticationResilienceTap(tap,1));
});
test('rejects incomplete matrix and any claim of hardware or live-material access', () => {
  for(const mutate of [f=>f.matrix.hardExitCases--,f=>f.matrix.signedRaceCases--,f=>f.matrix.auditFaultCases--,f=>f.matrix.hardwareAuthenticatorTested=true,f=>f.matrix.liveMaterialRead=true,...['hardProcessExits','atomicSessionAudit','unknownOutcomeInspectable','noRevivalAfterRestart','disableEnableProofBarrier','latestReduction','maintenanceCas','legacyApiPairingManagement','noSecretsInLogs'].map(k=>f=>f.matrix.checks[k]=false)]) {
    const f=fixture();mutate(f);assert.throws(()=>parseAuthenticationResilienceTap(f.tap(),0));
  }
});
