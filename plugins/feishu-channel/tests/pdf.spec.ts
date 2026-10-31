import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { pdfMessageContent } from '../src/pdf.js';
import { LarkChannel } from '../src/channel.js';
import type { MessageContext } from '../vendor/openclaw-lark/dist/messaging/types.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Feishu PDF attachment extraction', () => {
  it('injects PDF text without requiring a model tool call', async () => {
    const bytes = await readFile('/data/dsh/attachments/v1/files/90/905d69d9a006e6d839488680e0787671a3da3fc34ca6dbfc94b0c3fd5730d578/20261018格兰周策略：坚守底线.pdf');
    const agent = { ctx: { get: () => { throw new Error('text PDF must not need image attachments'); } } } as unknown as Agent;
    const blocks = await pdfMessageContent(agent, '周策略.pdf', bytes, logger);
    expect(blocks).toHaveLength(1);
    expect(blocks?.[0]).toMatchObject({ type: 'text' });
    const text = blocks?.[0]?.type === 'text' ? blocks[0].text : '';
    expect(text).toContain('无需再调用 PDF 工具');
    expect(text).toContain('周策略：坚守底线');
    expect(text).toContain('上证指数');
    expect(text).toContain('未获明确请求不得查询账户、持仓、委托或自选股');
  });

  it('saves scanned pages as durable image blocks', async () => {
    const bytes = await readFile('/data/dsh/attachments/v1/files/19/1994d56345f107f9364fac14b2abf741d38cdc956f2474cddc7e70a9b5de262c/20260920格兰周策略：股池梳理.pdf');
    const agent = { ctx: { get: (name: string) => name === 'attachments' ? {
      saveImages: async (images: Array<{ data: Uint8Array; mediaType: string; name: string }>) => images.map((image, index) => ({
        attachmentId: `pdf-page-${index}`,
        mediaType: image.mediaType,
        bytes: image.data.length,
        width: 100,
        height: 100,
      })),
    } : undefined } } as unknown as Agent;
    const blocks = await pdfMessageContent(agent, '扫描周策略.pdf', bytes, logger);
    // The source has 25 pages; maxPages=20 is the explicit truncation, not 7 shared-budget thumbnails.
    expect(blocks?.filter((block) => block.type === 'image')).toHaveLength(20);
    expect(blocks?.[0]?.type === 'text' && blocks[0].text).toContain('逐页阅读');
  });

  it('delivers extracted text through the Feishu message boundary', async () => {
    const bytes = await readFile('/data/dsh/attachments/v1/files/90/905d69d9a006e6d839488680e0787671a3da3fc34ca6dbfc94b0c3fd5730d578/20261018格兰周策略：坚守底线.pdf');
    const media = await import('../vendor/openclaw-lark/dist/messaging/outbound/media.js');
    vi.spyOn(media, 'downloadMessageResourceFeishu').mockResolvedValue({ buffer: bytes, fileName: '周策略.pdf', contentType: 'application/pdf' });
    const dir = await mkdtemp(join(tmpdir(), 'feishu-pdf-'));
    temporary.push(dir);
    const channel = new LarkChannel({ config: {}, logger } as never);
    const agent = { ctx: { get: () => undefined } } as unknown as Agent;
    const blocks = await (channel as unknown as { messageContent(message: MessageContext, cwd: string, agent: Agent): Promise<Array<{ type: string; text?: string }>> }).messageContent({
      content: '', messageId: 'om_pdf', chatId: 'oc_pdf', resources: [{ fileKey: 'file_pdf', type: 'file', fileName: '周策略.pdf' }],
    } as MessageContext, dir, agent);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.text).not.toContain('could not be downloaded');
    expect(blocks[1]?.text).toContain('无需再调用 PDF 工具');
    expect(blocks[1]?.text).toContain('周策略：坚守底线');
  });
});
