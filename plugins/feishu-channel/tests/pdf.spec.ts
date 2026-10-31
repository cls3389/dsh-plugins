import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { pdfMessageContent } from '../src/pdf.js';

const logger = { info() {}, warn() {} };

describe('Feishu PDF attachment extraction', () => {
  it('injects PDF text without requiring a model tool call', async () => {
    const bytes = await readFile('/data/dsh/attachments/v1/files/90/905d69d9a006e6d839488680e0787671a3da3fc34ca6dbfc94b0c3fd5730d578/20261018格兰周策略：坚守底线.pdf');
    const agent = { ctx: { get: () => { throw new Error('text PDF must not need image attachments'); } } } as unknown as Agent;
    const blocks = await pdfMessageContent(agent, '周策略.pdf', bytes, logger);
    expect(blocks).toHaveLength(1);
    expect(blocks?.[0]).toMatchObject({ type: 'text' });
    const text = blocks?.[0]?.type === 'text' ? blocks[0].text : '';
    expect(text).toContain('无需再调用文档转换工具');
    expect(text).toContain('周策略：坚守底线');
    expect(text).toContain('上证指数');
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
    expect(blocks?.filter((block) => block.type === 'image')).toHaveLength(7);
    expect(blocks?.[0]?.type === 'text' && blocks[0].text).toContain('逐页阅读');
  });
});
