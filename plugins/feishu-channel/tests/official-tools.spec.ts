import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { OfficialToolContexts, registerOfficialTools } from '../src/tools.js';
import { LarkClient } from '../vendor/openclaw-lark/dist/core/lark-client.js';

describe('official tool scopes', () => {
  it('messages mode registers messaging and image tools only', () => {
    const names: string[] = [];
    const ctx = {
      get(name: string) {
        if (name !== 'tools') return undefined;
        return {
          register(tool: { name: string }) { names.push(tool.name); return () => {}; },
          get() { return undefined; },
        };
      },
      logger: { info() {}, warn() {}, debug() {} },
    };
    const dispose = registerOfficialTools(
      ctx as never,
      { appId: 'cli_test', appSecret: 'secret' },
      { appId: 'cli_test', appSecret: 'secret' },
      new OfficialToolContexts(),
      undefined,
      'messages',
    );
    expect([...names].sort()).toEqual([
      'feishu_im_bot_image',
      'feishu_im_user_fetch_resource',
      'feishu_im_user_message',
      'feishu_send_file',
      'feishu_send_image',
    ]);
    expect(names.some((name) => /doc|sheet|oauth|search|chat/.test(name))).toBe(false);
    dispose();
  });

  it('returns the actually sent image as a model-visible preview', async () => {
    const workspace = join(process.env.DSH_HOME!, 'home', 'agents', 'personal-investment', 'users', 'u_test');
    await mkdir(workspace, { recursive: true });
    const file = join(workspace, 'introduction.png');
    await writeFile(file, 'image bytes');
    const definitions = new Map<string, { output: { render(args: unknown, value: unknown): unknown[] }, execute(args: unknown, exec: unknown): Promise<unknown> }>();
    const attachment = { attachmentId: 'sha256:sent-image', variantId: 'original' };
    const tools = { register(tool: { name: string }) { definitions.set(tool.name, tool as never); return () => {}; }, get() { return undefined; } };
    const ctx = {
      get(name: string) {
        if (name === 'tools') return tools;
        if (name === 'attachments') return { saveImage: vi.fn(async () => attachment) };
        return undefined;
      },
      logger: { info() {}, warn() {}, debug() {} },
    };
    const contexts = new OfficialToolContexts();
    contexts.bind('session', { chatId: 'oc_chat', accountId: 'default' } as never);
    const client = { sdk: { im: {
      image: { create: vi.fn(async () => ({ data: { image_key: 'img_sent' } })) },
      message: { create: vi.fn(async () => ({ code: 0, data: { message_id: 'om_sent' } })) },
    } } };
    vi.spyOn(LarkClient, 'fromCfg').mockReturnValue(client as never);
    const dispose = registerOfficialTools(ctx as never, { appId: 'cli_test', appSecret: 'secret' }, { appId: 'cli_test', appSecret: 'secret' }, contexts);
    try {
      const tool = definitions.get('feishu_send_image')!;
      const result = await tool.execute({ path: file }, { agent: { session: { id: 'session' } } }) as { sent: boolean; previewId: string };
      expect(result.sent).toBe(true);
      const blocks = tool.output.render({}, result);
      expect(blocks).toContainEqual({ type: 'image', attachment });
      expect(tool.output.render({}, result)).not.toContainEqual({ type: 'image', attachment });
    } finally { dispose(); }
  });
});
