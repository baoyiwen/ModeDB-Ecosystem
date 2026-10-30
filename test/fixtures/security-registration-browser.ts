/** CDP only against a new headless Chrome profile, loopback debugger and synthetic HTTPS pin. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WebSocket as Socket } from 'ws';

const {WebSocket}=await import(new URL('../../packages/server/node_modules/ws/wrapper.mjs',import.meta.url).href) as typeof import('ws');

const delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
export async function waitFor<T>(read:()=>Promise<T>,accept:(value:T)=>boolean,timeout=15000):Promise<T>{
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const value=await read();if(accept(value))return value;await delay(100);}
  throw Error('REGISTRATION_BROWSER_READINESS_TIMEOUT');
}
export async function registrationBrowser(root:string,spkiBase64:string){
  const browser=process.env.MODELDB_TEST_BROWSER??'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  assert.ok(existsSync(browser),'Chrome is required; this acceptance must not be skipped');
  const profile=join(root,'isolated-browser-profile');
  const child=spawn(browser,['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--no-proxy-server','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1',`--user-data-dir=${profile}`,'--host-resolver-rules=MAP modeldb-a.example.test 127.0.0.1',`--ignore-certificate-errors-spki-list=${spkiBase64}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
  let startupError=false;child.on('error',()=>{startupError=true;});
  let socket:Socket|undefined;
  let counter=0;
  const pending=new Map<number,{method:string;done:(value:unknown)=>void;fail:(error:Error)=>void}>();
  try{
    const file=join(profile,'DevToolsActivePort');
    await waitFor(async()=>{if(startupError)throw Error('REGISTRATION_BROWSER_UNAVAILABLE');return existsSync(file);},Boolean);
    const port=Number(readFileSync(file,'utf8').split(/\r?\n/)[0]);assert.ok(port>0&&port<=65535);
    const target=await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'}).then(r=>r.json()) as {webSocketDebuggerUrl:string};
    const endpoint=new URL(target.webSocketDebuggerUrl);assert.equal(endpoint.hostname,'127.0.0.1');assert.equal(endpoint.port,String(port));
    socket=new WebSocket(endpoint);
    await new Promise<void>((done,fail)=>{socket!.addEventListener('open',()=>done(),{once:true});socket!.addEventListener('error',()=>fail(Error('REGISTRATION_CDP_UNAVAILABLE')),{once:true});});
    socket.addEventListener('message',event=>{const message=JSON.parse(String(event.data)) as {id?:number;error?:unknown;result?:unknown};if(message.id){const item=pending.get(message.id);pending.delete(message.id);if(message.error)item?.fail(Error('REGISTRATION_CDP_COMMAND_FAILED'));else item?.done(message.result);}});
    socket.addEventListener('close',()=>{for(const item of pending.values())item.fail(Error('REGISTRATION_CDP_CLOSED:'+item.method));pending.clear();});
    const call=<T=Record<string,unknown>>(method:string,params:object={}):Promise<T>=>{
      const id=++counter;
      return new Promise((done,fail)=>{const timer=setTimeout(()=>{pending.delete(id);fail(Error('REGISTRATION_CDP_TIMEOUT:'+method));},30000);
        pending.set(id,{method,done:value=>{clearTimeout(timer);done(value as T);},fail:error=>{clearTimeout(timer);fail(error);}});socket!.send(JSON.stringify({id,method,params}));});
    };
    await call('Runtime.enable');await call('Page.enable');await call('Network.enable');
    await call('WebAuthn.enable');
    const authenticator=await call<{authenticatorId:string}>('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',ctap2Version:'ctap2_1',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
    const version=await call<{product:string}>('Browser.getVersion');
    return {call,version:version.product,authenticatorId:authenticator.authenticatorId,
      async evaluate<T>(expression:string):Promise<T>{const result=await call<{result:{value:T};exceptionDetails?:unknown}>('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});assert.equal(Boolean(result.exceptionDetails),false,'Browser evaluation failed; proof and secrets are intentionally not logged');return result.result.value;},
      async close(){try{await call('WebAuthn.removeVirtualAuthenticator',authenticator);await call('Browser.close');}catch{/* Child may already have exited. */}finally{socket?.close();if(child.exitCode===null){const closed=new Promise<void>(r=>child.once('close',()=>r()));child.kill();await Promise.race([closed,delay(5000)]);}}},
    };
  }catch(error){socket?.close();child.kill();throw error;}
}
