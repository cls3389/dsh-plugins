import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { DEFAULT_MAX_PAGES, DEFAULT_MAX_TEXT_CHARS, readPdf } from './reader.js';

const name = 'pdf-tools';
const inject = ['tools'];
const dshHome = process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
const DEFAULT_PREFIXES = ['/tmp/', `${dshHome}/`, '/home/'];

/** Public pdf_read tool: independent from anydoc/doc_to_markdown. */
export function apply(ctx, config) {
  const prefixes = config?.allowedPathPrefixes ?? DEFAULT_PREFIXES;
  const maxPages = config?.maxPages ?? DEFAULT_MAX_PAGES;
  const maxTextChars = config?.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const pageAttachments = new Map();
  let documentCounter = 0;

  ctx.tools.register({
    name: 'pdf_read',
    description: '读取本地 PDF（OpenClaw clawpdf / PDFium）。文本型直接提取文字；扫描或混合型逐页渲染图片供模型识别。最多处理前 max_pages 页；支持含权限标志但可正常打开的 PDF，不支持需要密码才能打开的 PDF。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'PDF 文件绝对路径' },
        max_pages: { type: 'integer', minimum: 1, maximum: 100, description: `最多读取页数，默认 ${maxPages}` },
      },
      required: ['file_path'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const summary = value.error ?? [
          `PDF：共 ${value.totalPages} 页，已处理前 ${value.processedPages} 页${value.renderedPages ? `，其中 ${value.renderedPages} 页补充页面图片` : ''}。`,
          value.truncatedPages ? `仅处理前 max_pages 页，其余 ${value.totalPages - value.processedPages} 页未读取。` : '',
          value.truncatedText ? '文字层达到 max_text_chars 上限，已截断。' : '',
          ...(value.pageErrors ?? []).map((item) => item.error),
          value.markdown || '所选页面没有可提取文字；请结合页面图片阅读。',
        ].filter(Boolean).join('\n\n');
        const blocks = [{ type: 'text', text: summary }];
        const refs = pageAttachments.get(value.docId);
        for (const item of value.images ?? []) {
          blocks.push({ type: 'text', text: `【PDF 第 ${item.page} 页】` });
          const ref = refs?.get(item.page);
          if (ref) blocks.push({ type: 'image', attachment: ref });
          else blocks.push({ type: 'text', text: item.error ?? '页面附件不可用' });
        }
        if (value.docId) pageAttachments.delete(value.docId);
        return blocks;
      },
    },
    async execute(args) {
      const filePath = String(args.file_path || '').trim();
      if (!filePath) return { error: 'file_path 不能为空' };
      const resolved = path.resolve(filePath);
      if (!prefixes.some((prefix) => resolved.startsWith(prefix))) return { error: `路径必须在允许前缀内: ${prefixes.join(', ')}` };
      if (!fs.existsSync(resolved)) return { error: `文件不存在: ${resolved}`, code: 'io' };
      if (path.extname(resolved).toLowerCase() !== '.pdf') return { error: 'pdf_read 仅支持 PDF；Office 等文档请使用 doc_to_markdown。', code: 'unsupported' };
      try {
        const result = await readPdf(fs.readFileSync(resolved), { maxPages: args.max_pages ?? maxPages, maxTextChars });
        const out = {
          status: 'ok', format: 'pdf', type: result.images.length > 0 ? 'image' : 'text',
          markdown: result.text, charCount: result.text.length,
          totalPages: result.totalPages, processedPages: result.processedPages,
          renderedPages: result.images.length,
          pageErrors: result.pageErrors,
          truncated: result.truncated.text || result.truncated.images,
          truncatedText: result.truncated.text, truncatedPages: result.truncated.images,
        };
        if (result.images.length > 0) {
          const attachments = ctx.get('attachments');
          if (!attachments) return { error: 'PDF 页面图片需要附件服务才能返回页面图片。', code: 'attachments_unavailable' };
          const docId = `pdf-${++documentCounter}`;
          const refs = await attachments.saveImages(result.images.map((image) => ({ data: image.bytes, mediaType: image.mimeType, name: `page-${image.page}.png` })));
          const pages = new Map();
          const images = [];
          result.images.forEach((image, index) => {
            pages.set(image.page, refs[index]);
            images.push({ page: image.page });
          });
          pageAttachments.set(docId, pages);
          out.docId = docId;
          out.images = images;
        }
        ctx.logger.info?.(`[pdf-tools] read ${resolved} (text=${result.text.length}, pages=${result.images.length})`);
        return out;
      } catch (error) {
        ctx.logger.warn?.(`[pdf-tools] read failed: ${resolved}: ${error?.message ?? error}`);
        return { error: `PDF 读取失败: ${error?.message ?? error}`, code: error?.code ?? 'pdf_error' };
      }
    },
  });
  ctx.logger.info('[pdf-tools] active: pdf_read (OpenClaw clawpdf)');
  return () => {};
}

export { name, inject };
