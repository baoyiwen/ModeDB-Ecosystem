import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { minifyModule } from '../../scripts/minify-module.mjs';
import { artifactFile, temporaryReleaseRoot, installedUpgradeChecks, assertInstalledUpgradeReport } from '../../scripts/security-install-contract.mjs';
const report = () => ({format:'modeldb.installed-upgrade.v1',task:'DR-P4.3',ok:true,platform:'win32',releaseManifestSha256:'a'.repeat(64),checks:Object.fromEntries(installedUpgradeChecks.map(k=>[k,true])),scope:{temporarySyntheticOnly:true,liveMaterialRead:false,realTwoDeviceTested:false,hardwareAuthenticatorTested:false,fullHistoricalPackageDowngradeTested:false,performanceTested:false,frontendChanged:false}});
test('separate minified modules preserve globals after same-named local bindings',async()=>{
  const load = async source => import('data:text/javascript;base64,'+Buffer.from(await minifyModule(source)).toString('base64'));
  const local = await load("import { Buffer } from 'node:buffer'; import process from 'node:process'; export const value = Buffer.from(process.platform).length;");
  const global = await load("export const value = Buffer.from(process.platform).length;");
  assert.equal(local.value,global.value);assert.ok(global.value>0);
});
test('minification retains public exports, method keys and CLI shebang',async()=>{
  const code=await minifyModule('#!/usr/bin/env node\nexport class PublicClient { read(){ return 42; } } export const api = { status(){return "ok";} };');
  assert.match(code,/^#!/);const module=await import('data:text/javascript;base64,'+Buffer.from(code.replace(/^#![^\n]*\n/,'')).toString('base64'));
  assert.equal(new module.PublicClient().read(),42);assert.equal(module.api.status(),'ok');
});
test('installed upgrade report rejects missing checks, future formats and inflated scope',()=>{
  assertInstalledUpgradeReport(report());
  for(const key of installedUpgradeChecks){const r=report();r.checks[key]=false;assert.throws(()=>assertInstalledUpgradeReport(r));}
  for(const mutate of [r=>delete r.checks.nativeDpapi,r=>r.format='future',r=>r.scope.fullHistoricalPackageDowngradeTested=true,r=>r.scope.realTwoDeviceTested=true,r=>r.scope.temporarySyntheticOnly=false]){const r=report();mutate(r);assert.throws(()=>assertInstalledUpgradeReport(r));}
});
test('artifact reads reject traversal, absolute paths, missing files and directories',()=>{
  const root=mkdtempSync(join(tmpdir(),'ModeDB-Release-'));mkdirSync(join(root,'safe'));writeFileSync(join(root,'safe','file.txt'),'synthetic');
  assert.equal(temporaryReleaseRoot(root),root);assert.equal(artifactFile(root,'safe/file.txt'),join(root,'safe','file.txt'));
  for(const p of ['../secret','/etc/passwd','safe/../file.txt','C:/secret','safe\\file.txt','safe','safe/missing'])assert.throws(()=>artifactFile(root,p));
  assert.throws(()=>temporaryReleaseRoot(join(root,'safe')));
});
