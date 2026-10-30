/** Retain final commands and output. Explicit source-only checks; no runtime configuration. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const base='docs/security-v1-deliveries/evidence/SEC-M7-D24/';
const source=['packages/sdk/src/browser-registration.ts','packages/sdk/src/browser-session.ts','packages/sdk/src/index.ts','packages/shared/src/device-authentication-contracts.ts','packages/server/src/security/authentication-service.ts','scripts/security-designer-identity-check.mjs','scripts/security-release-evidence.mjs','scripts/security-registration-storage-check.mjs'];
const ui=['apps/model-designer/src/components/BrowserIdentityPanel.tsx','apps/model-designer/src/components/ConnectionFlow.tsx','apps/model-designer/src/config/browser-identity-state.ts','apps/model-designer/src/config/connection-prefs.ts','apps/model-designer/src/styles/designer-shell.css',...['zh','en','ja'].map(l=>`apps/model-designer/src/i18n/locales/${l}/ui.json`)];
const docs=['docs/security-v1/device-registration-protocol-contract.md','docs/security-v1/device-registration-runtime-guide.md','docs/security-v1/overview.md','docs/security-v1/user-guide.md','docs/security-v1-plan.md','docs/security-v1/AGENTS.md','docs/security-v1-milestones.md','docs/security-v1-deliveries/SEC-M7.md','test/README.md'];
const commands=[];
const run=(args,name,command=process.execPath)=>{
  const r=spawnSync(command,args,{encoding:'utf8',windowsHide:true});writeFileSync(base+name,r.stdout+r.stderr,{flag:'wx'});commands.push({command:[command,...args],exitCode:r.status,log:name});console.log(JSON.stringify({name,exitCode:r.status}));assert.equal(r.status,0,r.error?.message??'Check failed: '+name);
};
if(process.argv[2]==='consumer'){
  run(['scripts/security-registration-consumer-check.mjs'],'consumer-native.original.txt');
  writeFileSync(base+'consumer-native.command.json',JSON.stringify(commands,null,2)+'\n');
}else{
  assert.equal(process.argv.length,2);
  run(['node_modules/tsx/dist/cli.mjs','--test','--test-reporter=tap','test/unit/browser-pairing-launch.test.ts','test/unit/browser-connection-credentials.test.ts'],'launch-compat.original.txt');
  writeFileSync(base+'launch-final.command.json',JSON.stringify(commands,null,2)+'\n');commands.length=0;
  run(['scripts/security-registration-storage-check.mjs'],'types.original.txt');
  writeFileSync(base+'types.command.json',JSON.stringify(commands,null,2)+'\n');commands.length=0;
  run(['node_modules/eslint/bin/eslint.js',...source],'lint.original.txt');
  run(['node_modules/prettier/bin/prettier.cjs','--check',...source,...ui,...docs,'package.json'],'format.original.txt');
  run(['diff','--check','--',...source,...ui,...docs,'package.json'],'diff.original.txt','git');
  run(['scripts/assert-no-security-material.mjs'],'material-guard.original.txt');
  writeFileSync(base+'static-commands.json',JSON.stringify(commands,null,2)+'\n');
}
