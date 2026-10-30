import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertNoPublicSecrets,assertFullCheckReport } from '../../scripts/security-full-contract.mjs';
import { fullFixture } from '../fixtures/security-full-report.mjs';

test('full check requires business/engine, browser and every native group',()=>{
 assertFullCheckReport(fullFixture());
 for(const mutate of [r=>r.native.pop(),r=>r.native[0].unit.skip=1,r=>r.checks.registeredRecovery=false,r=>r.browser.groups[0].timedOut=true,r=>r.totalPass++,r=>r.scope.performanceTested=true,r=>r.scope.realTwoDeviceTested=true]){const r=fullFixture();mutate(r);assert.throws(()=>assertFullCheckReport(r));}
});
test('public artifact scanning rejects private keys, bearer and URL secrets without rejecting error codes',()=>{
 assertNoPublicSecrets(Buffer.from('SECURITY_CREDENTIAL_REVOKED; Bearer <token>; privateKeyFile field'));
 for(const text of ['-----BEGIN PRIVATE KEY-----\n'+'a'.repeat(60)+'\n-----END PRIVATE KEY-----','Bearer '+'a'.repeat(48),'https://synthetic/?session='+'b'.repeat(48)])assert.throws(()=>assertNoPublicSecrets(Buffer.from(text)));
});
