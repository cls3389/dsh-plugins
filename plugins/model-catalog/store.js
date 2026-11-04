import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { normalizeProvider, mergeModels, fetchCatalog } from './catalog.js';
import { materialize, keyRef } from './adapter.js';
import { credentialRef } from '@deepseek-ai/dsh-credentials';

export function providerInput(raw) {
  const normalized = normalizeProvider({...raw, models:raw.overrides ?? raw.models ?? {}});
  if (!normalized.baseURL) throw new Error('请填写服务地址');
  const interval = raw.refreshIntervalSeconds ?? 300;
  if (!Number.isInteger(interval) || interval < 0 || interval > 86400 || interval > 0 && interval < 30) throw new Error('同步间隔应为 0（关闭）或 30–86400 秒');
  return {id:normalized.id, displayName:normalized.displayName, baseURL:normalized.baseURL, api:normalized.api,
    catalogURL:normalized.catalogURL ?? '', enabled:raw.enabled !== false, refreshIntervalSeconds:interval, overrides:normalized.models,
    ...(typeof raw.credentialId === 'string' && /^[A-F0-9]{16}$/.test(raw.credentialId) ? {credentialId:raw.credentialId} : {})};
}
export class CatalogStore {
  constructor(file,credentials,validate=()=>{}) {this.file=file;this.credentials=credentials;this.validate=validate;this.active=new Map();}
  async read() {
    try {
      const data=JSON.parse(await readFile(this.file,'utf8'));
      if(data.version!==1 || !Number.isSafeInteger(data.revision) || !Array.isArray(data.providers) || !data.catalogs || typeof data.catalogs!=='object' || Array.isArray(data.catalogs)) throw new Error('模型目录状态文件无效');
      data.providers=data.providers.map(providerInput);
      return data;
    } catch(error) {if(error.code==='ENOENT') return {version:1,revision:0,providers:[],catalogs:{}};throw error;}
  }
  async mutate(revision,operation) {
    await mkdir(dirname(this.file),{recursive:true,mode:0o700});
    return withFileLock(this.file,async()=>{
      const state=await this.read();
      if(revision!==undefined && revision!==state.revision) {const error=new Error('配置已发生变化，请刷新后再试');error.status=409;throw error;}
      await operation(state);
      materialize(state);this.validate(state);
      state.revision++;
      await writeFileAtomic(this.file,JSON.stringify(state,null,2)+'\n',{mode:0o600,dirMode:0o700});
      return state;
    });
  }
  async save(raw,revision,apiKey) {
    const provider=providerInput(raw);
    if(apiKey!==undefined && (typeof apiKey!=='string'||!apiKey.trim()||!/^[\x21-\x7E]+$/.test(apiKey.trim()))) throw new Error('API Key 格式无效');
    return this.mutate(revision,async state=>{
      const prior=state.providers.find(p=>p.id===provider.id);
      // Credential references are immutable generations, so in-flight calls cannot
      // pick up a replacement endpoint's key while awaiting credential resolution.
      delete provider.credentialId;
      if (apiKey !== undefined) provider.credentialId=randomBytes(8).toString('hex').toUpperCase();
      else if (prior?.credentialId) provider.credentialId=prior.credentialId;
      if (prior && prior.baseURL!==provider.baseURL && apiKey===undefined) throw new Error('更改服务地址时请重新填写 API Key');
      const next=state.providers.filter(p=>p.id!==provider.id);next.push(provider);
      state.providers=next;
      // A catalog belongs to an endpoint. Never carry old models into a new endpoint.
      if(prior && (prior.baseURL!==provider.baseURL||prior.catalogURL!==provider.catalogURL)) delete state.catalogs[provider.id];
      materialize(state);this.validate(state);
      if(apiKey!==undefined) await this.credentials.set(credentialRef(keyRef(provider.id,provider.credentialId)),apiKey.trim());
    });
  }
  async remove(id,revision) {return this.mutate(revision,state=>{state.providers=state.providers.filter(p=>p.id!==id);delete state.catalogs[id];});}
  async sync(id,revision,signal) {
    if(this.active.has(id)) throw new Error('该端点正在同步，请稍候');
    const marker={};this.active.set(id,marker);
    try {
      const state=await this.read();
      if(revision!==undefined&&revision!==state.revision){const e=new Error('配置已发生变化，请刷新后再试');e.status=409;throw e;}
      const provider=state.providers.find(p=>p.id===id);if(!provider) throw new Error('模型端点不存在');
      const fingerprint=JSON.stringify(provider);
      const apiKey=(await this.credentials.resolve(credentialRef(keyRef(id,provider.credentialId))))?.value;
      try {
        const models=await fetchCatalog(provider,{apiKey,signal});
        return await this.mutate(undefined,current=>{
          if(JSON.stringify(current.providers.find(p=>p.id===id))!==fingerprint) {const e=new Error('同步期间配置已更改，请重新同步');e.status=409;throw e;}
          current.catalogs[id]={models,syncedAt:new Date().toISOString(),attemptedAt:new Date().toISOString(),error:''};
        });
      } catch(error) {
        await this.mutate(undefined,current=>{
          if(JSON.stringify(current.providers.find(p=>p.id===id))===fingerprint) current.catalogs[id]={...(current.catalogs[id]??{models:[]}),attemptedAt:new Date().toISOString(),error:String(error.message).slice(0,500)};
        });
        throw error;
      }
    } finally {if(this.active.get(id)===marker)this.active.delete(id);}
  }
  async publicState() {
    const state=await this.read();
    const providers=await Promise.all(state.providers.map(async p=>({...p,hasApiKey:Boolean((await this.credentials.describe(credentialRef(keyRef(p.id,p.credentialId)))).configured)})));
    // 排序基准与 materialize 一致:override.priority 优先,否则跟随上游数组顺序。
    const effective=Object.fromEntries(state.providers.map(p=>{
      const merged=mergeModels(state.catalogs[p.id]?.models??[],p.overrides);
      const ordered=merged.map((entry,position)=>({entry,position}))
        .sort((a,b)=>((a.entry.priority??a.position)-(b.entry.priority??b.position)))
        .map((x)=>x.entry);
      return [p.id,ordered];
    }));
    return {revision:state.revision,providers,catalogs:state.catalogs,effective};
  }
}
