import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { isPdf, readPdf } from '@dsh-friends/pdf-tools/reader';

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
  if (!isPdf(fileName, contentType)) return undefined;
  try {
    const result = await readPdf(bytes, { maxPages: MAX_PDF_PAGES, maxTextChars: MAX_TEXT_CHARS });
    const text = result.text.trim();
    const blocks: ContentBlock[] = [];
    const notes = [
      `以下是飞书 PDF「${fileName}」的自动解析内容，无需再调用 PDF 工具。`,
      '工具边界：自动解析的正文可直接阅读，无需重复调用 PDF 工具。可围绕文档核验少量关键行情，但不得把阅读任务扩展为全市场扫描；未获明确请求不得查询账户、持仓、委托或自选股等个人数据，也不要为同一目的反复调用等价工具。',
    ];
    notes.push(`PDF 共 ${result.totalPages} 页，已处理前 ${result.processedPages} 页${result.images.length > 0 ? `，其中 ${result.images.length} 页补充页面图片` : ''}。`);
    if (result.truncated.images) notes.push(`仅处理前 ${MAX_PDF_PAGES} 页；其余 ${result.totalPages - result.processedPages} 页仍保存在原文件中。`);
    if (result.truncated.text) notes.push('文字层达到长度上限，已截断；请使用原始附件分段阅读。');
    for (const item of result.pageErrors) notes.push(item.error);
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
    return [{ type: 'text', text: `飞书 PDF「${fileName}」自动解析失败：${String(error)}。原始附件路径如下，可用 pdf_read 重试。` }];
  }
}
