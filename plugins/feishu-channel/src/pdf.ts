import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';

const MAX_TEXT_CHARS = 500_000;
const MAX_PDF_PAGES = 20;

export interface PdfLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** Extract PDF content at the channel boundary, before the model sees the message. */
export async function pdfMessageContent(
  agent: Agent,
  fileName: string,
  bytes: Uint8Array,
  logger: PdfLogger,
  contentType?: string,
): Promise<ContentBlock[] | undefined> {
  if (!fileName.toLowerCase().endsWith('.pdf') && contentType !== 'application/pdf') return undefined;
  try {
    const { extractPdf } = await import('clawpdf');
    const result = await extractPdf(bytes, { maxPages: MAX_PDF_PAGES });
    const text = result.text.trim();
    const blocks: ContentBlock[] = [];
    const notes = [`以下是飞书 PDF「${fileName}」的自动解析内容，无需再调用文档转换工具。`];
    if (result.truncated.text || result.truncated.images) notes.push('仅处理前 20 页；其余内容仍保存在原文件中。');
    if (text.length > 0) {
      notes.push(`【提取的文本${text.length > MAX_TEXT_CHARS ? '（已截断）' : ''}】\n${text.slice(0, MAX_TEXT_CHARS)}`);
    }
    if (result.images.length > 0) notes.push('请结合随后附上的 PDF 页面图片逐页阅读。');
    if (text.length === 0 && result.images.length === 0) {
      notes.push('未能提取到文本或页面图片，请使用原始附件路径处理。');
    }
    blocks.push({ type: 'text', text: notes.join('\n\n') });
    if (result.images.length > 0) {
      const attachments = agent.ctx.get('attachments');
      if (!attachments) throw new Error('PDF 页面需要附件服务，但当前会话未提供');
      const refs = await attachments.saveImages(result.images.map((image) => ({
        data: image.bytes,
        mediaType: image.mimeType,
        name: `${fileName}-page-${image.page}.png`,
      })));
      for (let i = 0; i < refs.length; i++) {
        blocks.push({ type: 'text', text: `【${fileName} · 第 ${result.images[i]?.page} 页】` });
        blocks.push({ type: 'image', attachment: refs[i]! });
      }
    }
    logger.info(`[lark] PDF auto-extracted: ${fileName} (text=${text.length}, pages=${result.images.length})`);
    return blocks;
  } catch (error) {
    logger.warn(`[lark] PDF auto-extraction failed: ${fileName}: ${String(error)}`);
    return [{ type: 'text', text: `飞书 PDF「${fileName}」自动解析失败：${String(error)}。原始附件路径如下，可用文档工具重试。` }];
  }
}
