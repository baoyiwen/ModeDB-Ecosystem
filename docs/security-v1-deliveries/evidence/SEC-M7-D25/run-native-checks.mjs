/** Native checks use synthetic temporary instances only. Preserve every original result. */
import assert from 'node:assert/strict';
import {copyFileSync,cpSync,mkdirSync,writeFileSync} from 'node:fs';
import {checkIdentityAdmin} from '../../../../scripts/security-identity-admin-check.mjs';
import {checkDesignerIdentity} from '../../../../scripts/security-designer-identity-check.mjs';
import {checkHostingIntegration} from '../../../../scripts/security-hosting-integration-check.mjs';
const base='docs/security-v1-deliveries/evidence/SEC-M7-D25/';
for(const [name,run,report,log,directory] of [
  ['admin',checkIdentityAdmin,'admin-integration-check.json','admin-native.original.txt','screenshots/admin'],
  ['identity',checkDesignerIdentity,'identity-integration-check.json','identity-native.original.txt','screenshots/identity'],
  ['hosting',checkHostingIntegration,'integration-check.json','native.original.txt','screenshots'],
]){
  const result=await run();writeFileSync(base+name+'-final.original.json.txt',JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  copyFileSync(result.report,base+report);copyFileSync(result.log,base+log);
  mkdirSync(base+directory,{recursive:true});cpSync(result.screenshots,base+directory,{recursive:true});
  console.log(JSON.stringify({name,ok:result.ok,exitCode:result.exitCode,root:result.root}));assert.equal(result.ok,true);
}
