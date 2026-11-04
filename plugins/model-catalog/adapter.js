import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { LlmAdapter, LlmError, resolveRetryPolicy, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { mergeModels } from './catalog.js';

const APIS = { 'openai-completions': openAICompletionsApi, 'openai-responses': openAIResponsesApi, 'anthropic-messages': anthropicMessagesApi };
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export function keyRef(id, credentialId = '') { return `MODEL_CATALOG_${Buffer.from(id).toString('hex').toUpperCase()}${credentialId ? `_${credentialId}` : ''}_API_KEY`; }

export function materialize(state) {
  const profiles = new Map();
  const defaults = new Map();
  for (const provider of state.providers) {
    if (!provider.enabled) continue;
    const remote = state.catalogs[provider.id]?.models ?? [];
    // 排序基准:显式 override.priority 优先(用户拖拽),否则跟随上游数组顺序;
    // 上游 priority 数值不参与排序,数组换序即可经同步传播。
    const effective = mergeModels(remote, provider.overrides)
      .map((entry, position) => ({ entry, position }))
      .sort((a, b) => ((a.entry.priority ?? a.position) - (b.entry.priority ?? b.position)))
      .map((x) => x.entry);
    const models = effective.map(entry => {
      const contextWindow = entry.contextWindow ?? 262144;
      const maxTokens = entry.maxTokens ?? Math.min(32768, contextWindow);
      if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0 || !Number.isSafeInteger(maxTokens) || maxTokens <= 0 || maxTokens > contextWindow) throw new Error(`模型 ${entry.id} 的上下文和输出上限必须是正整数，输出不能超过上下文`);
      const thinkingLevelMap = Object.fromEntries(LEVELS.map(level => [level, null]));
      for (const level of entry.reasoningEfforts || []) thinkingLevelMap[level] = level === 'off' ? 'none' : level;
      const reasoning = Boolean(entry.reasoningEfforts && entry.reasoningEfforts.some(level => level !== 'off'));
      const defaultReasoning = entry.defaultReasoning && entry.reasoningEfforts?.includes(entry.defaultReasoning) ? entry.defaultReasoning : undefined;
      if (defaultReasoning) defaults.set(`${provider.id}\0${entry.id}`, defaultReasoning);
      return { id: entry.id, name: entry.name || entry.id, api: provider.api, provider: provider.id,
        baseUrl: provider.baseURL, input: entry.input?.length ? [...entry.input] : ['text'],
        cost: {input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow, maxTokens, reasoning,
        ...(reasoning ? {thinkingLevelMap} : {}), ...(entry.compat ? {compat:structuredClone(entry.compat)} : {}) };
    });
    const protocol = APIS[provider.api]?.();
    if (!protocol) throw new Error('不支持的请求格式');
    const piProvider = { id:provider.id, name:provider.displayName, baseUrl:provider.baseURL,
      auth:{apiKey:{ name:provider.displayName, resolve:async ({credential})=>({auth:credential?.key ? {apiKey:credential.key} : {},source:'model-catalog'}) }},
      getModels:()=>models,
      stream:(model,context,options)=>protocol.stream(model,context,options),
      streamSimple:(model,context,options)=>protocol.streamSimple(model,context,options) };
    profiles.set(provider.id, { provider:provider.id, displayName:provider.displayName, api:provider.api, baseURL:provider.baseURL,
      apiKeyEnv:keyRef(provider.id,provider.credentialId), piProvider, modelErrors:new Map(),
      configuredMaxTokens:new Map(models.map(m=>[m.id,provider.overrides?.[m.id]?.maxTokens ?? Math.min(12288,m.maxTokens)])),
      streamIdleTimeoutMs:300000,maxRequestImageBytes:20971520,requestImagePixelBudget:4194304,requestImageMaxBytes:1048576,
      retryPolicy:resolveRetryPolicy(undefined,'model-catalog') });
  }
  return {profiles,defaults};
}

/** Every preparation holds one immutable adapter generation across credential waits and syncs. */
export class CatalogAdapter extends LlmAdapter {
  constructor(ctx, state) { super(); this.ctx=ctx; this.replace(state); }
  replace(state) {
    const {profiles,defaults}=materialize(state);
    const inner=new PiAiAdapter({profiles:()=>profiles,
      resolveApiKey:async(_provider,profile)=>{
        const key=(await this.ctx.credentials.resolve(credentialRef(profile.apiKeyEnv)))?.value;
        if (!key) throw new LlmError('请在模型目录设置中填写 API Key','MISSING_CREDENTIAL');
        return key;
      },
      auth:{credentials:{read:async()=>undefined,list:async()=>[],modify:async(_id,fn)=>fn(undefined),delete:async()=>{}},authContext:{env:async()=>undefined,fileExists:async()=>false}},
      resolveAttachments:()=>this.ctx.get('attachments'),
      resolveImageAccess:(attachments,ref)=>resolveImageAttachmentAccess(attachments,path=>this.ctx.get('fs')?.processPathFromHostPath(path),ref),
      onReplayDegrade:()=>this.ctx.logger?.warn('model-catalog: assistant replay metadata unavailable; using portable history')
    });
    this.generation={inner,defaults};
  }
  providerInfo(provider){ return this.generation.inner.providerInfo(provider); }
  providerRetryPolicy(provider){ return this.generation.inner.providerRetryPolicy(provider); }
  imageRequestTarget(provider,model,image){return this.generation.inner.imageRequestTarget(provider,model,image);}
  listModels(provider){return this.generation.inner.listModels(provider);}
  async resolveModel(provider,model,signal){return (await this.prepareCall(provider,model,signal)).model;}
  async prepareCall(provider,model,signal){
    const {inner,defaults}=this.generation;
    const prepared=await inner.prepareCall(provider,model,signal);
    const effort=defaults.get(`${provider}\0${model}`);
    const metadata=effort && prepared.model.reasoning ? {...prepared.model,reasoning:{...prepared.model.reasoning,defaultEffort:effort}} : prepared.model;
    return {model:metadata,stream:options=>prepared.stream(effort && options.reasoningEffort===undefined ? {...options,reasoningEffort:effort} : options)};
  }
  async *stream(options){const prepared=await this.prepareCall(options.provider,options.model,options.signal);yield* prepared.stream(options);}
}
