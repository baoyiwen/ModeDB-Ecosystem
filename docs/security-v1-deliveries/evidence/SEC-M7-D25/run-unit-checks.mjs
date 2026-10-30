/** Repeat scoped tests with raw output. Reads development files only; each fixture is temporary. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync,createWriteStream,writeFileSync} from 'node:fs';
const base='docs/security-v1-deliveries/evidence/SEC-M7-D25/';
const inherited=JSON.parse(readFileSync('docs/security-v1-deliveries/evidence/SEC-M7-D23/regression-commands.json','utf8'));
const groups=inherited.map(x=>({name:x.log.split('.')[0],files:x.command.slice(4)}));
groups.push({name:'hosting',files:['test/unit/security-hosting.test.ts','test/unit/security-hosting-report.test.mjs']},
  {name:'identity-admin',files:['test/unit/security-identity-admin.test.ts','test/unit/security-identity-admin-report.test.mjs']},
  {name:'identity',files:['test/unit/security-designer-identity.test.ts','test/unit/security-designer-identity-report.test.mjs']},
  {name:'tools',files:['test/unit/security-release-evidence.test.mjs','test/unit/security-authentication-report.test.mjs','test/unit/security-authentication-resilience-report.test.mjs']},
  {name:'launch-compat',files:['test/unit/browser-pairing-launch.test.ts','test/unit/browser-connection-credentials.test.ts']});
const results=[];
for(const group of groups){
  assert.ok(group.files.every(p=>/^test\/(unit|integration)\/[^/]+\.test\.(ts|mjs)$/.test(p)));
  const args=['node_modules/tsx/dist/cli.mjs','--test','--test-reporter=tap',...group.files],path=base+group.name+'.original.txt',stream=createWriteStream(path,{flags:'wx'}),start=Date.now();
  const child=spawn(process.execPath,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.pipe(stream,{end:false});child.stderr.pipe(stream,{end:false});
  const exitCode=await new Promise((done,fail)=>{child.once('error',fail);child.once('close',done);});await new Promise(done=>stream.end(done));
  results.push({command:[process.execPath,...args],exitCode,durationMs:Date.now()-start,log:path});writeFileSync(base+'regression-commands.json',JSON.stringify(results,null,2)+'\n');
  console.log(JSON.stringify({name:group.name,exitCode,durationMs:Date.now()-start}));
}
assert.ok(results.every(x=>x.exitCode===0));
