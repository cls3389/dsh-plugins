import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { CatalogAdapter, materialize } from './adapter.js';

function state(baseURL,api='openai-completions') {return {providers:[{id:'catalog-test',displayName:'我的模型',baseURL,api,enabled:true,overrides:{}}],catalogs:{'catalog-test':{models:[{id:'test-model',name:'测试模型',contextWindow:272000,maxTokens:64000,input:['text','image'],reasoningEfforts:['off','low','high','max'],defaultReasoning:'high'}]}}};}
const ctx={credentials:{resolve:async()=>({value:'test-key'})},get:()=>undefined};
test('advertises names, image capability, context and exact supported reasoning levels',async()=>{
 const adapter=new CatalogAdapter(ctx,state('http://127.0.0.1:1/v1'));
 assert.equal(adapter.providerInfo('catalog-test').name,'我的模型');
 const m=await adapter.resolveModel('catalog-test','test-model');
 assert.equal(m.name,'测试模型');assert.equal(m.context.contextWindow,272000);assert.equal(m.defaultMaxTokens,12288);
 assert.deepEqual(m.inputModalities,['text','image']);assert.deepEqual(m.reasoning.efforts.map(e=>String(e.id)),['off','low','high','max']);assert.equal(m.reasoning.defaultEffort,'high');
});
test('prepared request stays on captured endpoint generation and sends reasoning default',async t=>{
 let captured;
 const server=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  captured={url:req.url,headers:req.headers,body:JSON.parse(body)};
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.end('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'test-model',choices:[{index:0,delta:{role:'assistant',content:'OK'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'test-model',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})+'\n\ndata: [DONE]\n\n');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const adapter=new CatalogAdapter(ctx,state(`http://127.0.0.1:${server.address().port}/v1`));
 const prepared=await adapter.prepareCall('catalog-test','test-model');
 adapter.replace(state('http://127.0.0.1:1/v1'));
 const chunks=[];for await(const chunk of prepared.stream({provider:'catalog-test',model:'test-model',messages:[{role:'user',content:[{type:'text',text:'Hello'}]}],tools:[]}))chunks.push(chunk);
 assert.equal(captured.url,'/v1/chat/completions');assert.equal(captured.headers.authorization,'Bearer test-key');
 assert.equal(captured.body.reasoning_effort,'high');assert.ok(chunks.some(c=>c.type==='text-delta'));
 assert.ok(captured.headers['user-agent']);
});
test('rejects invalid limits without replacing current generation',async()=>{
 const adapter=new CatalogAdapter(ctx,state('http://127.0.0.1:1/v1'));
 const bad=state('http://127.0.0.1:1/v1');bad.providers[0].overrides={'test-model':{contextWindow:100,maxTokens:200}};
 assert.throws(()=>adapter.replace(bad),/输出不能超过上下文/);
 assert.equal((await adapter.resolveModel('catalog-test','test-model')).context.contextWindow,272000);
});
test('materializes all three request protocols',()=>{
 for(const api of ['openai-completions','openai-responses','anthropic-messages'])assert.equal(materialize(state('http://localhost/v1',api)).profiles.get('catalog-test').api,api);
});
