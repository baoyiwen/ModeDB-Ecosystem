/** Browser-session write/read smoke check, restricted to a newly created synthetic database. */
import assert from 'node:assert/strict';
type Page = { evaluate<T>(expression: string): Promise<T> };
export async function assertSyntheticBrowserSave(page: Page, write: boolean) {
  const result = await page.evaluate<{ saved: boolean; csrfDenied: boolean; crossDatabaseDenied: boolean; readBack: boolean }>(`(async()=>{
    const session=await fetch('/api/v1/security/session').then(r=>r.json());
    const rpc=(database,operation,csrf=true)=>fetch('/api/v1/rpc',{method:'POST',headers:{'content-type':'application/json',...(csrf?{'x-modeldb-csrf':session.csrf}:{})},body:JSON.stringify({version:1,database,operation})});
    const insert={op:'insert',model:'SyntheticItem',data:{label:'synthetic-candidate-saved'},sync:true};
    const denied=${write}?(await rpc('synthetic_business',insert,false)).status===403:true;
    const saved=${write}?(await rpc('synthetic_business',insert)).status===200:true;
    const query={op:'executeQuery',snapshot:{plan:{version:2,originModel:'SyntheticItem',start:{kind:'all'},hops:[],trailing:{type:'atom',field:'label',op:'eq',value:'synthetic-candidate-saved'}},execute:{},analysis:{groupBy:null,compute:null}}};
    const response=await rpc('synthetic_business',query),rows=await response.json();
    return {saved,csrfDenied:denied,crossDatabaseDenied:(await rpc('synthetic_other',query)).status===403,readBack:response.status===200&&JSON.stringify(rows).includes('synthetic-candidate-saved')};
  })()`);
  assert.deepEqual(result, { saved: true, csrfDenied: true, crossDatabaseDenied: true, readBack: true });
}
