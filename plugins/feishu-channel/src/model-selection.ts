import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentSetup, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { SessionStore } from './session-store.js';

/** Chat-pinned model override persisted in the Lark session store. */
export interface ChatModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

function toModelSelection(selection: ChatModelSelection): ModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }),
  };
}

/** Structural slice of ctx.llm consumed here; the real service satisfies it. */
export interface ModelsLlm {
  listProviders(): readonly { id: string; name?: string }[];
  listModels(provider: string): Promise<readonly { id: string; name?: string }[]>;
  resolveCallConfig(config: {
    provider: string;
    model: string;
    reasoningEffort?: string;
  }): Promise<unknown>;
  resolveModelInfo(
    provider: string,
    model: string,
  ): Promise<{ reasoning?: { efforts: readonly { id: string; name?: string }[] } }>;
}

/** Structural slice of ctx.agentDefaultModel consumed here. */
export interface ModelsDefaultModel {
  currentSelection(): ModelSelection;
  saveSelection(next: ModelSelection): Promise<void>;
}

export interface ModelCommandsDeps {
  /** Lazy so registration order against the llm plugins never matters. */
  readonly getLlm: () => ModelsLlm | undefined;
  readonly getDefaultModel: () => ModelsDefaultModel | undefined;
  /** ctx.agents.get — cheap live-agent lookup without resuming persistence. */
  readonly getLiveAgent: (sessionId: string) => Agent | undefined;
  readonly resolveAgent: (sessionId: string, cwd: string) => Promise<Agent>;
  readonly registry: ModelSelectionRegistry;
  readonly sessions: SessionStore;
  readonly logger?: { warn(message: string): void };
}

interface CatalogEntry {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
}

type MatchResult =
  | { readonly entry: CatalogEntry }
  | { readonly candidates: readonly CatalogEntry[] }
  | { readonly unknown: true };

const CATALOG_TTL_MS = 60_000;

/**
 * Live per-session ModelSelectionRef registry. Refs are installed exactly once
 * per agent publication through the AgentSetup built by {@link setup}; the map
 * entry outlives nothing else because agent-scope disposal removes it.
 */
export class ModelSelectionRegistry {
  private readonly refs = new Map<string, ModelSelectionRef>();

  constructor(
    private readonly install: (
      agentCtx: Context,
      selection: ModelSelectionRef,
    ) => unknown = installModelSelection,
  ) {}

  ref(sessionId: string): ModelSelectionRef | undefined {
    return this.refs.get(sessionId);
  }

  /** AgentSetup that installs a mutable selection seeded with the stored override. */
  setup(override: ChatModelSelection | undefined): AgentSetup {
    return (agentCtx, agent) => {
      const id = agent.id as string;
      const ref: ModelSelectionRef = {
        current: override ? toModelSelection(override) : undefined,
        assembled: undefined,
      };
      this.install(agentCtx, ref);
      agentCtx.effect(() => () => {
        if (this.refs.get(id) === ref) this.refs.delete(id);
      });
      return {
        commit: () => {
          this.refs.set(id, ref);
        },
      };
    };
  }
}

/** `/model` and `/effort` slash-command handling for one Lark deployment. */
export class ModelCommands {
  private catalogCache?: { at: number; entries: readonly CatalogEntry[] };

  constructor(private readonly deps: ModelCommandsDeps) {}

  /** Route one command line; returns the reply text. */
  async handle(chatId: string, text: string): Promise<string> {
    const trimmed = text.trim();
    const space = trimmed.indexOf(' ');
    const command = space === -1 ? trimmed : trimmed.slice(0, space);
    const argument = space === -1 ? '' : trimmed.slice(space + 1).trim();
    if (command === '/model') {
      return argument ? this.switchModel(chatId, argument) : this.status(chatId);
    }
    return argument ? this.switchEffort(chatId, argument) : this.effortStatus(chatId);
  }

  private async status(chatId: string): Promise<string> {
    const current = this.effectiveSelection(chatId);
    const lines = [
      `本会话模型：${label(current?.selection)}（${sourceLabel(current?.source)}）`,
      `全局默认：${label(this.defaultModel()?.currentSelection())}`,
      '可用模型：',
    ];
    for (const [provider, entries] of await this.groupedCatalog()) {
      lines.push(`${provider}: ${entries.map((entry) => entry.id).join(' · ')}`);
    }
    lines.push('用法：/model <名称> 切换 · /model reset 恢复 · /effort <级别> 调思考强度');
    return lines.join('\n');
  }

  private async switchModel(chatId: string, query: string): Promise<string> {
    if (query === 'reset' || query === 'default' || query === '重置') {
      return this.resetModel(chatId);
    }
    const entries = await this.catalog();
    if (entries.length === 0) return '没有可用的模型目录，请检查 llm provider 配置。';
    const match = matchModel(entries, query);
    if ('unknown' in match) return `未找到模型“${query}”。\n${await this.catalogText()}`;
    if ('candidates' in match) {
      return [
        `“${query}”匹配到多个模型，请用 provider/模型 精确指定：`,
        ...match.candidates.map((entry) => `- ${entry.provider}/${entry.id}`),
      ].join('\n');
    }
    const entry = match.entry;
    const selection = await this.withKeptEffort(chatId, entry);
    try {
      await this.llm().resolveCallConfig(selection);
    } catch (error) {
      return `切换失败：${messageOf(error)}\n${await this.catalogText()}`;
    }
    return this.apply(
      chatId,
      selection,
      `已切换模型：${label(selection)}（下次请求生效，会话历史保留）`,
    );
  }

  private async resetModel(chatId: string): Promise<string> {
    this.deps.sessions.clearModel(chatId);
    await this.deps.sessions.save();
    const binding = this.deps.sessions.get(chatId);
    const live = this.deps.getLiveAgent(binding.sessionId);
    const ref = live && this.deps.registry.ref(live.id as string);
    if (ref) ref.current = undefined;
    return '已取消本会话的模型固定：后续请求沿用本会话最近使用的模型，其次全局默认。';
  }

  private async effortStatus(chatId: string): Promise<string> {
    const current = this.effectiveSelection(chatId);
    if (!current?.selection) return '当前没有生效的模型，先用 /model <名称> 选择一个。';
    const efforts = await this.effortsOf(current.selection.provider, current.selection.model);
    const listed = efforts?.length
      ? efforts.join(' · ')
      : '未知（可直接 /effort <级别> 尝试，由网关校验）';
    const active = current.selection.reasoningEffort ?? '模型默认';
    return `当前模型 ${label(current.selection)} · 思考强度：${active}\n可选强度：${listed}\n用法：/effort <级别>`;
  }

  private async switchEffort(chatId: string, query: string): Promise<string> {
    const current = this.effectiveSelection(chatId);
    if (!current?.selection) return '当前没有生效的模型，先用 /model <名称> 选择一个。';
    const { provider, model } = current.selection;
    const efforts = await this.effortsOf(provider, model);
    if (efforts !== undefined && efforts.length > 0) {
      const wanted = efforts.find((effort) => effort.toLowerCase() === query.toLowerCase());
      if (!wanted) {
        const suggestion = nearestOption(query, efforts);
        return `“${query}”不是 ${label(current.selection)} 支持的强度。可选：${efforts.join(' · ')}${
          suggestion ? `（是不是想输 ${suggestion}？）` : ''
        }`;
      }
      return this.applyEffort(chatId, provider, model, wanted);
    }
    // No advertised metadata: let the gateway's route validation decide. An
    // unsupported explicit effort rejects in resolveCallConfig before any I/O.
    return this.applyEffort(chatId, provider, model, query.toLowerCase());
  }

  private async applyEffort(
    chatId: string,
    provider: string,
    model: string,
    reasoningEffort: string,
  ): Promise<string> {
    const selection: ChatModelSelection = { provider, model, reasoningEffort };
    try {
      await this.llm().resolveCallConfig(selection);
    } catch (error) {
      return `设置失败：${messageOf(error)}`;
    }
    return this.apply(
      chatId,
      selection,
      `已设置思考强度：${reasoningEffort}（${label(selection)}，下次请求生效）`,
    );
  }

  /** Persist the override, apply it to the live agent, and mirror the global default. */
  private async apply(
    chatId: string,
    selection: ChatModelSelection,
    summary: string,
  ): Promise<string> {
    this.deps.sessions.setModel(chatId, selection);
    await this.deps.sessions.save();
    const binding = this.deps.sessions.get(chatId);
    try {
      const agent = await this.deps.resolveAgent(binding.sessionId, binding.cwd);
      const ref = this.deps.registry.ref(agent.id as string);
      if (ref) ref.current = toModelSelection(selection);
    } catch (error) {
      this.deps.logger?.warn(`[lark] model switch agent apply failed: ${messageOf(error)}`);
    }
    const fallback = this.defaultModel();
    if (fallback) {
      void fallback
        .saveSelection(toModelSelection(selection))
        .catch((error: unknown) =>
          this.deps.logger?.warn(
            `[lark] model selection applied to the session but the default was not saved: ${messageOf(error)}`,
          ),
        );
    }
    return `${summary}\n已同步为全局默认模型。`;
  }

  private async withKeptEffort(chatId: string, entry: CatalogEntry): Promise<ChatModelSelection> {
    const previous = this.effectiveSelection(chatId)?.selection;
    const selection: ChatModelSelection = { provider: entry.provider, model: entry.id };
    if (!previous?.reasoningEffort) return selection;
    const efforts = await this.effortsOf(entry.provider, entry.id);
    if (efforts?.includes(previous.reasoningEffort)) {
      return { ...selection, reasoningEffort: previous.reasoningEffort };
    }
    return selection;
  }

  private effectiveSelection(chatId: string): {
    readonly selection?: ChatModelSelection;
    readonly source: 'override' | 'sticky' | 'default' | 'unset';
  } {
    const binding = this.deps.sessions.get(chatId);
    const ref = this.deps.registry.ref(binding.sessionId);
    if (ref?.current) return { selection: { ...ref.current }, source: 'override' };
    const live = this.deps.getLiveAgent(binding.sessionId);
    const header = live && requestHeaderOf(live);
    if (header) {
      return {
        selection: {
          provider: header.provider,
          model: header.model,
          ...(header.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: header.reasoningEffort }),
        },
        source: 'sticky',
      };
    }
    const current = this.defaultModel()?.currentSelection();
    if (current) return { selection: { ...current }, source: 'default' };
    return { source: 'unset' };
  }

  private async effortsOf(provider: string, model: string): Promise<readonly string[] | undefined> {
    try {
      const info = await this.llm().resolveModelInfo(provider, model);
      const efforts = info.reasoning?.efforts.map((effort) => effort.id);
      return efforts && efforts.length > 0 ? efforts : undefined;
    } catch (error) {
      // Never silent: an unavailable catalog must not masquerade as
      // "the model cannot switch effort".
      this.deps.logger?.warn(
        `[lark] effort metadata unavailable for ${provider}/${model}: ${messageOf(error)}`,
      );
      return undefined;
    }
  }

  private async catalog(): Promise<readonly CatalogEntry[]> {
    const now = Date.now();
    if (this.catalogCache && now - this.catalogCache.at < CATALOG_TTL_MS) {
      return this.catalogCache.entries;
    }
    const llm = this.llm();
    const entries: CatalogEntry[] = [];
    if (llm) {
      for (const provider of llm.listProviders()) {
        try {
          const models = await llm.listModels(provider.id);
          entries.push(
            ...models.map((info) => ({
              provider: provider.id,
              id: info.id,
              ...(info.name === undefined ? {} : { name: info.name }),
            })),
          );
        } catch (error) {
          this.deps.logger?.warn(
            `[lark] model list failed for ${provider.id}: ${messageOf(error)}`,
          );
        }
      }
    }
    this.catalogCache = { at: now, entries };
    return entries;
  }

  private async groupedCatalog(): Promise<readonly (readonly [string, readonly CatalogEntry[]])[]> {
    const groups = new Map<string, CatalogEntry[]>();
    for (const entry of await this.catalog()) {
      const bucket = groups.get(entry.provider) ?? [];
      bucket.push(entry);
      groups.set(entry.provider, bucket);
    }
    return [...groups.entries()].map(([provider, list]) => [provider, list] as const);
  }

  private async catalogText(): Promise<string> {
    const lines: string[] = [];
    for (const [provider, entries] of await this.groupedCatalog()) {
      lines.push(`${provider}: ${entries.map((entry) => entry.id).join(' · ')}`);
    }
    return lines.join('\n');
  }

  private llm(): ModelsLlm {
    const llm = this.deps.getLlm();
    if (!llm) throw new Error('llm 服务不可用');
    return llm;
  }

  private defaultModel(): ModelsDefaultModel | undefined {
    return this.deps.getDefaultModel();
  }
}

function matchModel(entries: readonly CatalogEntry[], query: string): MatchResult {
  const normalized = query.trim().toLowerCase();
  if (normalized.includes('/')) {
    const slash = normalized.indexOf('/');
    const provider = normalized.slice(0, slash);
    const model = normalized.slice(slash + 1);
    const entry = entries.find(
      (candidate) =>
        candidate.provider.toLowerCase() === provider && candidate.id.toLowerCase() === model,
    );
    return entry ? { entry } : { unknown: true };
  }
  const exact = entries.filter((entry) => entry.id.toLowerCase() === normalized);
  {
    const [first] = exact;
    if (exact.length === 1 && first) return { entry: first };
  }
  if (exact.length > 1) return { candidates: exact };
  const partial = entries.filter(
    (entry) =>
      entry.id.toLowerCase().includes(normalized) ||
      (entry.name?.toLowerCase().includes(normalized) ?? false),
  );
  {
    const [first] = partial;
    if (partial.length === 1 && first) return { entry: first };
  }
  if (partial.length > 1) return { candidates: partial };
  return { unknown: true };
}

function requestHeaderOf(
  agent: Agent,
): { provider: string; model: string; reasoningEffort?: string } | undefined {
  const session = (agent as { session?: { requestHeader?: () => unknown } }).session;
  const header = session?.requestHeader?.() as
    | { config?: { provider?: string; model?: string; reasoningEffort?: string } }
    | undefined;
  const config = header?.config;
  if (!config?.provider || !config?.model) return undefined;
  return {
    provider: config.provider,
    model: config.model,
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
  };
}

function label(selection: { provider: string; model: string } | undefined): string {
  return selection ? `${selection.provider}/${selection.model}` : '未设置';
}

function sourceLabel(source: 'override' | 'sticky' | 'default' | 'unset' | undefined): string {
  switch (source) {
    case 'override':
      return '本会话固定';
    case 'sticky':
      return '沿用会话最近模型';
    case 'default':
      return '全局默认';
    default:
      return '未设置';
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Closest advertised option within a small edit distance, for typo hints. */
function nearestOption(query: string, options: readonly string[]): string | undefined {
  let best: { option: string; distance: number } | undefined;
  for (const option of options) {
    const distance = editDistance(query.toLowerCase(), option.toLowerCase());
    if (distance <= 2 && (!best || distance < best.distance)) {
      best = { option, distance };
    }
  }
  return best?.option;
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current: number[] = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column] ?? 0;
      const diagonal = previous[column - 1] ?? 0;
      const behind = current[column - 1] ?? 0;
      const substitution = diagonal + (left[row - 1] === right[column - 1] ? 0 : 1);
      current[column] = Math.min(above + 1, behind + 1, substitution);
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}
