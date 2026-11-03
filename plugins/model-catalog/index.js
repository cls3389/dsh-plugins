import z from '@deepseek-ai/schemastery';
import { join } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { CatalogStore } from './store.js';
import { CatalogAdapter } from './adapter.js';

export const name='model-catalog';
export const inject=['llm','credentials'];
export const Config=z.object({stateFile:z.string().default(''), pollIntervalMs:z.number().default(5000)});
export async function apply(ctx,config) {
  let registration,adapter,lastRevision=-1,closed=false,cycleActive=false;
  const owned=new Set();
  const validate=state=>{
    const conflicts=ctx.llm.listProviders().filter(p=>!owned.has(p.id)&&state.providers.some(s=>s.id===p.id&&s.enabled));
    if(conflicts.length) throw new Error(`服务商 ID ${conflicts.map(p=>p.id).join(', ')} 已被其他模型配置使用，请选用新的 ID`);
  };
  const file=config.stateFile||join(resolveDshHome(),'model-catalog','catalog.json');
  const store=new CatalogStore(file,ctx.credentials,validate);
  function activate(state) {
    if(closed||state.revision===lastRevision)return;
    validate(state);
    const previous=adapter?.generation;
    if(!adapter)adapter=new CatalogAdapter(ctx,state);else adapter.replace(state);
    const routes=state.providers.filter(p=>p.enabled).map(p=>p.id);
    try {
      if(registration)registration.replace(routes);
      else if(routes.length)registration=ctx.llm.registerAdapter(routes,adapter);
      owned.clear();for(const route of routes)owned.add(route);
      lastRevision=state.revision;
    } catch(error){if(previous)adapter.generation=previous;throw error;}
  }
  activate(await store.read());
  const controller=new AbortController();
  ctx.on('dispose',()=>{closed=true;controller.abort();});
  async function cycle() {
    if(closed||cycleActive)return;cycleActive=true;
    try {
      const state=await store.read();activate(state);
      for(const p of state.providers) {
        if(!p.enabled||!p.refreshIntervalSeconds||store.active.has(p.id))continue;
        const previous=state.catalogs[p.id];
        const since=Date.parse(previous?.attemptedAt||previous?.syncedAt||0)||0;
        if(Date.now()-since<p.refreshIntervalSeconds*1000)continue;
        try {activate(await store.sync(p.id,undefined,controller.signal));}
        catch {activate(await store.read());}
      }
    } catch(error){if(!closed)ctx.logger.warn('model-catalog: %s',error.message);}
    finally{cycleActive=false;}
  }
  ctx.effect(()=>{
    const timer=setInterval(cycle,Math.max(1000,config.pollIntervalMs));timer.unref?.();
    queueMicrotask(cycle);
    return ()=>clearInterval(timer);
  });
  ctx.inject(['connection'],child=>{
    child.connection.fetch.register({path:'/api/model-catalog/state',methods:['GET','POST'],requestBody:'buffered',fetch:async request=>{
      const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
      try {
        if(request.method==='GET')return json(await store.publicState());
        const raw=await request.text();if(raw.length>1024*1024)return json({error:'配置数据超过限制'},413);
        const body=JSON.parse(raw);
        if(!Number.isSafeInteger(body.revision)||body.revision<0)return json({error:'缺少配置版本，请刷新'},400);
        let state;
        if(body.op==='save')state=await store.save(body.provider,body.revision,body.apiKey);
        else if(body.op==='sync')state=await store.sync(body.id,body.revision,AbortSignal.any([request.signal,controller.signal]));
        else if(body.op==='remove')state=await store.remove(body.id,body.revision);
        else return json({error:'未知操作'},400);
        activate(state);return json(await store.publicState());
      }catch(error){
        try{activate(await store.read());}catch{}
        return json({error:error instanceof SyntaxError?'配置 JSON 格式无效':String(error.message).slice(0,500)},error.status??400);
      }
    }});
  });
}
