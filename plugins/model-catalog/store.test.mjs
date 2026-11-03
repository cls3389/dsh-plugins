import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {CatalogStore} from './store.js';
const credentials=()=>{const keys=new Map();return {set:async(k,v)=>keys.set(k,v),resolve:async k=>keys.has(k)?{value:keys.get(k)}:undefined,describe:async k=>({configured:keys.has(k)})};};
async function setup(){const dir=await mkdtemp(join(tmpdir(),'dsh-model-catalog-'));return new CatalogStore(join(dir,'catalog.json'),credentials());}
const provider={id:'catalog-unit',displayName:'模型源',baseURL:'http://localhost:1/v1',api:'openai-completions',enabled:true,refreshIntervalSeconds:300,overrides:{}};
test('configuration revisions protect concurrent edits and secrets never enter public state',async()=>{
 const store=await setup();await store.save(provider,0,'secret-test');
 const pub=await store.publicState();assert.equal(pub.revision,1);assert.equal(pub.providers[0].hasApiKey,true);
 assert.ok(!JSON.stringify(pub).includes('secret-test'));assert.ok(!(await readFile(store.file,'utf8')).includes('secret-test'));
 await assert.rejects(store.save({...provider,displayName:'stale'},0),e=>e.status===409);
 await Promise.allSettled([store.save({...provider,displayName:'one'},1),store.save({...provider,displayName:'two'},1)]);
 assert.equal((await store.read()).revision,2);
});
test('sync preserves overrides across refresh, retains catalog on errors, clears cache on endpoint change',async t=>{
 let fail=false;
 const server=createServer((_req,res)=>{if(fail){res.writeHead(502);res.end('error');return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({models:[{slug:'unit-model',display_name:'Upstream',visibility:'list',context_window:272000}]}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const store=await setup();const p={...provider,baseURL:`http://127.0.0.1:${server.address().port}/v1`,overrides:{'unit-model':{name:'我的模型',contextWindow:128000}}};
 await store.save(p,0,'secret-test');await store.sync(p.id,1);await store.sync(p.id,2);
 let pub=await store.publicState();assert.equal(pub.effective[p.id][0].name,'我的模型');assert.equal(pub.effective[p.id][0].contextWindow,128000);
 fail=true;await assert.rejects(store.sync(p.id,3),/HTTP 502/);pub=await store.publicState();
 assert.equal(pub.effective[p.id][0].name,'我的模型');assert.match(pub.catalogs[p.id].error,/502/);
 await store.save({...p,baseURL:'http://localhost:2/v1'},pub.revision,'new-endpoint-key');pub=await store.publicState();assert.deepEqual(pub.effective[p.id],[]);
});
test('endpoint and key changes allocate a separate credential reference',async()=>{
 const store=await setup();await store.save(provider,0,'first-key');
 const original=(await store.read()).providers[0];
 await assert.rejects(store.save({...provider,baseURL:'http://localhost:2/v1'},1),/重新填写 API Key/);
 await store.save({...provider,baseURL:'http://localhost:2/v1'},1,'second-key');
 const next=(await store.read()).providers[0];
 assert.notEqual(original.credentialId,next.credentialId);
 const {keyRef}=await import('./adapter.js');
 assert.equal((await store.credentials.resolve(keyRef(original.id,original.credentialId))).value,'first-key');
 assert.equal((await store.credentials.resolve(keyRef(next.id,next.credentialId))).value,'second-key');
});

test('disabled model override survives sync without being advertised',async()=>{
 const store=await setup();await store.save({...provider,overrides:{m:{enabled:false}}},0);
 await store.mutate(1,s=>{s.catalogs[provider.id]={models:[{id:'m',name:'M'},{id:'n',name:'N'}]};});
 const pub=await store.publicState();assert.deepEqual(pub.effective[provider.id].map(m=>m.id),['n']);assert.equal(pub.providers[0].overrides.m.enabled,false);
});
