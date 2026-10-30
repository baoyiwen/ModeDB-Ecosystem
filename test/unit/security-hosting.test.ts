import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync, linkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { hostingFixture } from '../fixtures/security-hosting.js';
import { SID } from '../fixtures/security-registration-integration.js';
import { loadHostedAssets, validateBrowserHostingConfig, hostedDataOrigin } from '../../packages/server/src/security/browser-hosting.js';
import { hostedSecurityLaunchUrl } from '../../packages/server/src/cli-security.js';
import { dispatchLocalSecurity } from '../../packages/server/src/security/local-management-channel.js';
import { startHostedManagement } from '../../packages/server/src/security/management-listener.js';
import { loadModelDBServerConfig } from '../../packages/server/src/config-loader.js';
import { formatModelDBStartupInfo } from '../../packages/server/src/server-access-info.js';

async function call(origin:string,path:string,body?:unknown,headers:Record<string,string>={},method=body===undefined?'GET':'POST') {
  // Restart tests rebind the same port: do not reuse the closed listener's pooled socket.
  return new Promise<{status:number;body:string;headers:import('node:http').IncomingHttpHeaders}>((done,fail)=>{
    const url=new URL(origin);
    const req=request({hostname:'127.0.0.1',port:Number(url.port),path,method,agent:false,headers:{host:url.host,...(body!==undefined?{'content-type':'application/json'}:{}),...headers}},res=>{let body='';res.setEncoding('utf8');res.on('data',b=>body+=b);res.on('end',()=>done({status:res.statusCode!,body,headers:res.headers}));});req.on('error',fail);req.end(body===undefined?undefined:JSON.stringify(body));
  });
}
const parsed=(r:{body:string})=>JSON.parse(r.body) as {csrf:string;securityAdmin:boolean;expiresAt:string;absoluteExpiresAt:string;error?:string};
const cookie=(r:{headers:import('node:http').IncomingHttpHeaders})=>r.headers['set-cookie']![0]!.split(';')[0]!;

test('hosting remains explicit and validates every field without address or file discovery',async()=>{
  for(const value of [null,[],true,{}, {enabled:1},{enabled:true},{enabled:true,designerDirectory:''},{enabled:true,designerDirectory:'public',host:'0.0.0.0'},{enabled:true,designerDirectory:'public',managementPort:-1},{enabled:true,designerDirectory:'public',managementPort:65536}])assert.throws(()=>validateBrowserHostingConfig(value),{code:'SECURITY_INVALID_CONFIG'});
  for(const value of [undefined,{enabled:false},{enabled:true,designerDirectory:'public',managementPort:0}])validateBrowserHostingConfig(value);
  assert.equal(hostedDataOrigin({host:'127.0.0.1'},9123),'http://127.0.0.1:9123');
  assert.throws(()=>hostedDataOrigin({host:'0.0.0.0'},9123),{code:'SECURITY_INVALID_CONFIG'});
  const root=mkdtempSync(join(tmpdir(),'ModeDB-Hosting-Config-')),config=join(root,'fixture.json');
  writeFileSync(config,JSON.stringify({security:{version:1,hosting:{enabled:true,designerDirectory:'public',managementPort:0}},workspace:'business',host:'127.0.0.1',port:0}));
  const cfg=await loadModelDBServerConfig(config,{});assert.equal(cfg.securityHosting?.designerDirectory,'public');assert.equal(cfg.securityHosting?.managementPort,0);
  const info=formatModelDBStartupInfo(cfg,12345);assert.match(info,/http:\/\/127\.0\.0\.1:12345\/designer\//);assert.match(info,/security security-open/);assert.doesNotMatch(info,/--url|localhost:12345/);
});

for(const extra of ['modeldb.config.json','.env','server.key','bundle.js.map','source.ts','arbitrary.html'])test(`build snapshot refuses ${extra} without serving it`,()=>{
  const root=mkdtempSync(join(tmpdir(),'ModeDB-Hosting-Assets-'));writeFileSync(join(root,'index.html'),'<main>public</main>');writeFileSync(join(root,extra),'synthetic excluded file');
  assert.throws(()=>loadHostedAssets(root,[]),{code:'SECURITY_INVALID_CONFIG'});
});
test('build snapshot rejects protected overlap, directory junctions, hardlinks and oversized files',()=>{
  const root=mkdtempSync(join(tmpdir(),'ModeDB-Hosting-Paths-')),publicDir=join(root,'public'),privateDir=join(root,'private');mkdirSync(publicDir);mkdirSync(privateDir);writeFileSync(join(publicDir,'index.html'),'<main>public</main>');
  assert.throws(()=>loadHostedAssets(publicDir,[root]),{code:'SECURITY_INVALID_CONFIG'});
  assert.throws(()=>loadHostedAssets(root,[privateDir]),{code:'SECURITY_INVALID_CONFIG'});
  const linked=join(root,'linked');symlinkSync(publicDir,linked,process.platform==='win32'?'junction':'dir');assert.throws(()=>loadHostedAssets(linked,[]),{code:'SECURITY_INVALID_CONFIG'});
  writeFileSync(join(privateDir,'synthetic.js'),'synthetic linked content');linkSync(join(privateDir,'synthetic.js'),join(publicDir,'linked.js'));assert.throws(()=>loadHostedAssets(publicDir,[]),{code:'SECURITY_INVALID_CONFIG'});
  const large=join(root,'large');mkdirSync(large);writeFileSync(join(large,'index.html'),Buffer.alloc(16*1024*1024+1));assert.throws(()=>loadHostedAssets(large,[]),{code:'SECURITY_INVALID_CONFIG'});
});

test('public build serves only exact GET/HEAD snapshot paths with same-origin security headers',async()=>{
  const x=await hostingFixture();try{
    const page=await call(x.origin,'/designer/');assert.equal(page.status,200);assert.match(page.body,/synthetic public app/);assert.match(String(page.headers['content-security-policy']),/script-src 'self'/);assert.match(String(page.headers['content-security-policy']),/frame-ancestors 'none'/);assert.equal(page.headers['x-content-type-options'],'nosniff');assert.equal(page.headers['cache-control'],'no-store');
    assert.equal((await call(x.origin,'/assets/test.js',undefined,{},'HEAD')).body,'');
    assert.equal((await call(x.origin,'/assets/test.js?secret=bad')).status,400);
    writeFileSync(join(x.build,'assets','test.js'),'changed after start');assert.match((await call(x.origin,'/assets/test.js')).body,/dataset.loaded/);
    assert.notEqual((await call(x.origin,'/modeldb.config.json')).status,200);assert.notEqual((await call(x.origin,'/arbitrary/spa/route')).status,200);
    assert.notEqual((await call(x.origin,'/designer/',{})).status,200);
  }finally{await x.close();}
});

for(const [name,path,headers] of [
  ['encoded traversal','/assets/%2e%2e/security/registry.mds',{}],['double encoding','/assets/%252e%252e/secret',{}],['encoded slash','/api/v1/security%2fadmin/overview',{}],['raw traversal','/assets/../security/registry.mds',{}],['backslash','/assets/..\\security',{}],['rebinding','/designer/',{host:'attacker.example:1234'}],['wrong port','/designer/',{host:'127.0.0.1:1'}],['null origin','/designer/',{origin:'null'}],['cross-origin','/designer/',{origin:'https://attacker.example'}],['same-site ports','/designer/',{'sec-fetch-site':'same-site'}],
] as const)test(`data listener refuses ${name} before static or API handlers`,async()=>{const x=await hostingFixture();try{assert.equal((await call(x.origin,path,undefined,headers)).status,403);assert.ok(x.f.registry.auditEvents().some(e=>e.action==='hosting.reject'));}finally{await x.close();}});

for(const header of ['forwarded','x-forwarded-for','x-forwarded-host','x-forwarded-proto','x-real-ip','via'])test(`management listener rejects ${header} even on its real loopback socket`,async()=>{const x=await hostingFixture();try{assert.equal((await call(x.managementOrigin,'/security/',undefined,{[header]:'127.0.0.1'})).status,403);}finally{await x.close();}});

test('management APIs and page cannot be reached through data listener, even from loopback',async()=>{
  const x=await hostingFixture();try{
    for(const path of ['/security/','/api/v1/security/admin/overview','/api/v1/security/admin/control','/api/v1/security/admin/audit','/api/v1/security/admin/audit/export'])assert.equal((await call(x.origin,path)).status,404);
    for(const path of ['/api/v1/rpc','/api/v1/stream','/api/v1/management/databases','/security/authentication/v1/capabilities','/designer/'])assert.equal((await call(x.managementOrigin,path)).status,404);
    assert.equal((await call(x.managementOrigin,'/api/v1/security/admin/overview')).status,401);
    assert.equal((await call(x.managementOrigin,'/security/',undefined,{host:'localhost:'+new URL(x.managementOrigin).port})).status,403);
  }finally{await x.close();}
});

test('OS launch is exact, one-use, management-only and never consumed by a wrong session role',async()=>{
  const x=await hostingFixture();try{
    assert.throws(()=>dispatchLocalSecurity(x.f.registry,{action:'browser.hosted.security.launch',origin:'http://evil.invalid'},[],undefined,()=>x.managementOrigin),{code:'SECURITY_LOCAL_CHANNEL_UNAVAILABLE'});
    assert.throws(()=>dispatchLocalSecurity(x.f.registry,{action:'browser.security.launch',origin:x.managementOrigin},[],undefined,()=>x.managementOrigin),{code:'SECURITY_INVALID_REQUEST'});
    const launch=x.launch(),link=hostedSecurityLaunchUrl(launch);assert.equal(link.origin,x.managementOrigin);assert.equal(link.pathname,'/security/');assert.equal(link.search,'');assert.equal(new URLSearchParams(link.hash.slice(1)).get('modeldb-pair'),launch.code);
    for(const edit of [{url:'http://evil.invalid/security/'},{url:launch.url+'?code=bad'},{origin:'http://localhost:1'},{code:'invalid'}])assert.throws(()=>hostedSecurityLaunchUrl({...launch,...edit}),{code:'SECURITY_INVALID_REQUEST'});
    assert.throws(()=>x.f.registry.consumePairing(launch.code,x.managementOrigin,15,'data'),{code:'SECURITY_FORBIDDEN'});
    const paired=await call(x.managementOrigin,'/api/v1/security/pair',{code:launch.code},{origin:x.managementOrigin});assert.equal(paired.status,200);assert.equal(parsed(paired).securityAdmin,true);assert.match(paired.headers['set-cookie']![0]!,/HttpOnly; SameSite=Strict/);
    const headers={origin:x.managementOrigin,cookie:cookie(paired)};
    assert.equal((await call(x.managementOrigin,'/api/v1/security/pair',{code:launch.code},{origin:x.managementOrigin})).status,401);
    assert.equal((await call(x.managementOrigin,'/api/v1/security/admin/overview',undefined,headers)).status,200);
    assert.equal((await call(x.managementOrigin,'/api/v1/security/session/logout',{},headers)).status,403);
    const refreshed=await call(x.managementOrigin,'/api/v1/security/session/refresh',{}, {...headers,'x-modeldb-csrf':parsed(paired).csrf});assert.equal(refreshed.status,200);assert.notEqual(parsed(refreshed).csrf,parsed(paired).csrf);
    assert.equal((await call(x.managementOrigin,'/api/v1/security/session',undefined,headers)).status,401);
    assert.equal((await call(x.origin,'/api/v1/security/admin/overview',undefined,{cookie:cookie(refreshed)})).status,404);
    const logout=await call(x.managementOrigin,'/api/v1/security/session/logout',{}, {origin:x.managementOrigin,cookie:cookie(refreshed),'x-modeldb-csrf':parsed(refreshed).csrf});assert.equal(logout.status,200);
    await x.restart();assert.equal((await call(x.managementOrigin,'/api/v1/security/session',undefined,{origin:x.managementOrigin,cookie:cookie(refreshed)})).status,401);
    assert.ok(x.f.registry.listCredentials().every(c=>c.grants.length===0));
  }finally{await x.close();}
});

test('hosted management idle 15 minutes and absolute 60 minutes survive refresh and restart',async()=>{
  const x=await hostingFixture();try{
    const launch=x.launch();let paired=await call(x.managementOrigin,'/api/v1/security/pair',{code:launch.code},{origin:x.managementOrigin});const absolute=Date.parse(parsed(paired).absoluteExpiresAt);
    assert.equal(Date.parse(parsed(paired).expiresAt)-x.f.now,15*60000);assert.equal(absolute-x.f.now,60*60000);
    for(let i=0;i<4;i++){x.f.advance(14*60000);paired=await call(x.managementOrigin,'/api/v1/security/session/refresh',{}, {origin:x.managementOrigin,cookie:cookie(paired),'x-modeldb-csrf':parsed(paired).csrf});assert.equal(paired.status,200);assert.equal(Date.parse(parsed(paired).absoluteExpiresAt),absolute);}
    await x.restart();assert.equal((await call(x.managementOrigin,'/api/v1/security/session',undefined,{origin:x.managementOrigin,cookie:cookie(paired)})).status,200);
    x.f.advance(5*60000);assert.equal((await call(x.managementOrigin,'/api/v1/security/session',undefined,{origin:x.managementOrigin,cookie:cookie(paired)})).status,401);
    const next=x.launch(),fresh=await call(x.managementOrigin,'/api/v1/security/pair',{code:next.code},{origin:x.managementOrigin});x.f.advance(16*60000);assert.equal((await call(x.managementOrigin,'/api/v1/security/session',undefined,{origin:x.managementOrigin,cookie:cookie(fresh)})).status,401);
  }finally{await x.close();}
});

test('data pairings cannot create a management session and conflict binding never falls back',async()=>{
  const x=await hostingFixture();try{
    const api=x.f.registry.withLocalActor(SID,()=>x.f.registry.createLocalBrowserPairing(x.managementOrigin,['synthetic_business']));
    assert.equal((await call(x.managementOrigin,'/api/v1/security/pair',{code:api.code},{origin:x.managementOrigin})).status,403);
    x.f.registry.consumePairing(api.code,x.managementOrigin,30,'data');
    await assert.rejects(()=>startHostedManagement({port:Number(new URL(x.managementOrigin).port),assets:x.assets,entrypoints:{registry:x.f.registry,dispatcher:{} as never,designerWorkspace:'synthetic_designer',workspace:x.f.root,writeGate:{} as never,getEngine:async()=>{throw Error();},listDatabases:()=>[],catalog:async()=>{throw Error();}}}),{code:'EADDRINUSE'});
    assert.equal((await call(x.managementOrigin,'/security/')).status,200);
  }finally{await x.close();}
});

test('old eight-hour management identities are refused by the hosted management listener',async()=>{
  const x=await hostingFixture();try{
    const legacy=x.f.registry.withLocalActor(SID,()=>x.f.registry.createLocalBrowserPairing(x.managementOrigin,[],true));
    const old=x.f.registry.consumePairing(legacy.code,x.managementOrigin),valid=x.f.registry.verifyBrowserSession(old.session,x.managementOrigin);
    const hash=await import('node:crypto');const name='mdbs_session_'+hash.createHash('sha256').update(x.managementOrigin+'|'+x.managementOrigin).digest('hex').slice(0,24);
    for(const path of ['/api/v1/security/session','/api/v1/security/admin/overview','/api/v1/security/admin/audit'])assert.equal((await call(x.managementOrigin,path,undefined,{origin:x.managementOrigin,cookie:name+'='+old.session})).status,403);
    assert.equal(valid.securityAdmin,true);
  }finally{await x.close();}
});

test('failed hosted rejection audit cannot report an ordinary denial or return static bytes',async()=>{
  const x=await hostingFixture();try{x.f.fail(true);const r=await call(x.origin,'/designer/',undefined,{host:'attacker.example'});assert.equal(r.status,503);assert.doesNotMatch(r.body,/synthetic public app/);}finally{await x.close();}
});

test('management websocket upgrade cannot bypass its data-route allowlist',{timeout:10000},async()=>{
  const x=await hostingFixture();try{
    await new Promise<void>((done,fail)=>{
      const req=request(x.managementOrigin+'/api/v1/stream',{headers:{connection:'Upgrade',upgrade:'websocket','sec-websocket-version':'13','sec-websocket-key':'dGhlIHNhbXBsZSBub25jZQ=='}},res=>{try{assert.equal(res.statusCode,404);done();}catch(e){fail(e);}finally{res.destroy();req.destroy();}});
      req.on('upgrade',(_res,socket)=>{socket.destroy();fail(Error('MANAGEMENT_WEBSOCKET_ACCEPTED'));});req.on('error',fail);req.setTimeout(5000,()=>{req.destroy();fail(Error('MANAGEMENT_WEBSOCKET_TIMEOUT'));});req.end();
    });
  }finally{await x.close();}
});
