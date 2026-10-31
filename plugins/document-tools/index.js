import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

const name = 'document-tools';
const inject = ['tools'];
const dshHome = process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
const DEFAULT_PREFIXES = ['/tmp/', `${dshHome}/`, '/home/'];
const MAX_OUTPUT_CHARS = 500_000;
const ERRORS = {
  unsupported: '不支持的文件格式。',
  malformed: '文件结构损坏,无法解析。',
  encrypted: '文件已加密或受密码保护,无法转换。',
  resourceLimit: '文件超出安全限制(解压体积/嵌套深度/节点数过大)。',
  missingPart: '文件缺少必要组成部分,可能已损坏。',
  io: '文件读取失败,请检查路径是否正确。',
};
let anydoc;
function loadAnydoc() {
  if (anydoc) return anydoc;
  try {
    anydoc = createRequire(import.meta.url)('@firecrawl/anydoc');
    return anydoc;
  } catch (error) {
    throw new Error(`无法加载 @firecrawl/anydoc: ${error.message}`);
  }
}

// PDF 附件暂存:docId → Map<pageNum, attachmentRef>
const pdfAttachmentStore = new Map();
let pdfDocCounter = 0;

let _clawpdf;
async function loadClawpdf() {
  if (_clawpdf) return _clawpdf;
  _clawpdf = await import('clawpdf');
  return _clawpdf;
}

async function handlePdf(ctx, resolved) {
  const { extractPdf } = await loadClawpdf();
  const buf = fs.readFileSync(resolved);
  const data = new Uint8Array(buf);

  let result;
  try {
    result = await extractPdf(data, { maxPages: 20 });
  } catch (error) {
    if (error.code === 'password') return { error: 'PDF 已加密,暂不支持密码保护文档', code: 'encrypted' };
    return { error: `PDF 解析失败: ${error.message}`, code: 'pdf_error' };
  }

  const text = result.text?.trim() ?? '';
  const images = result.images ?? [];

  // 文本型 PDF(有文本层,文字量足够)
  if (text.length > 100 && images.length === 0) {
    let truncated = false;
    let md = text;
    if (md.length > MAX_OUTPUT_CHARS) {
      md = `${md.slice(0, MAX_OUTPUT_CHARS)}\n\n<!-- PDF 过长已截断,原文共 ${md.length} 字符 -->`;
      truncated = true;
    }
    ctx.logger.info?.(`[document-tools] PDF text: ${resolved} (${md.length} chars)`);
    return { status: 'ok', format: 'pdf', type: 'text', markdown: md, charCount: md.length, truncated };
  }

  // 图片型或混合型 PDF:注册附件给模型看图
  const docId = `pdf-${++pdfDocCounter}`;
  const pageAttachments = new Map();
  pdfAttachmentStore.set(docId, pageAttachments);
  const attachments = ctx.get('attachments');
  const imageList = [];
  for (const img of images) {
    const pageNum = img.page;
    if (attachments?.saveImage) {
      try {
        const ref = await attachments.saveImage({ data: Buffer.from(img.bytes), mediaType: img.mimeType ?? 'image/png', name: `page-${pageNum}.png` });
        pageAttachments.set(pageNum, ref);
        imageList.push({ page: pageNum });
      } catch { imageList.push({ page: pageNum, error: '附件注册失败' }); }
    } else {
      imageList.push({ page: pageNum, error: '附件服务不可用' });
    }
  }
  ctx.logger.info?.(`[document-tools] PDF images: ${resolved} (${imageList.length} pages, text=${text.length})`);
  const out = {
    status: 'ok', format: 'pdf', type: 'image', docId,
    totalPages: result.pagesProcessed?.length ?? imageList.length,
    renderedPages: imageList.length,
    textLength: text.length,
    images: imageList,
  };
  if (text.length > 0) out.markdown = text.slice(0, MAX_OUTPUT_CHARS);
  if (result.truncated?.images) out.note = '部分页面未渲染(超出限制)';
  return out;
}

export function apply(ctx, config) {
  const prefixes = config?.allowedPathPrefixes ?? DEFAULT_PREFIXES;
  ctx.tools.register({
    name: 'doc_to_markdown',
    description: '将本地文档转为 Markdown(docx/doc/pptx/ppt/xlsx/xls/rtf/epub/csv/odt/ods/odp/pdf)。文本型 PDF 直接提取文字;图片型 PDF 渲染为图片返回给模型识别。不支持加密文档。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文档绝对路径' },
        format_hint: { type: 'string', description: '自动检测失败时手动指定格式', enum: ['docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls', 'rtf', 'epub', 'csv', 'odt', 'ods', 'odp', 'pdf'] },
      },
      required: ['file_path'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (value.type === 'image' && Array.isArray(value.images)) {
          const pageAtts = pdfAttachmentStore.get(value.docId);
          const blocks = [{ type: 'text', text: `图片型 PDF,共 ${value.totalPages} 页,已渲染 ${value.renderedPages} 页。${value.textLength > 0 ? `同时提取到 ${value.textLength} 字符文本。` : ''}请逐页识别:` }];
          if (value.markdown) blocks.push({ type: 'text', text: `\n【提取的文本层】\n${value.markdown.slice(0, 3000)}` });
          for (const img of value.images) {
            blocks.push({ type: 'text', text: `\n--- 第 ${img.page} 页 ---` });
            const att = pageAtts?.get(img.page);
            if (att) blocks.push({ type: 'image', attachment: att });
            else blocks.push({ type: 'text', text: img.error ?? '(图片加载失败)' });
          }
          // 用完后清理
          if (value.docId) pdfAttachmentStore.delete(value.docId);
          return blocks;
        }
        return [{ type: 'text', text: JSON.stringify(value, null, 1) }];
      },
    },
    async execute(args) {
      try {
        const filePath = String(args.file_path || '').trim();
        if (!filePath) return { error: 'file_path 不能为空' };
        const resolved = path.resolve(filePath);
        if (!prefixes.some((prefix) => resolved.startsWith(prefix))) return { error: `路径必须在允许前缀内: ${prefixes.join(', ')}` };
        if (!fs.existsSync(resolved)) return { error: `文件不存在: ${resolved}`, code: 'io' };
        const ext = path.extname(resolved).toLowerCase();
        if (ext === '.pdf' || args.format_hint === 'pdf') return handlePdf(ctx, resolved);
        let lib;
        try { lib = loadAnydoc(); } catch (error) { return { error: error.message }; }
        const bytes = fs.readFileSync(resolved);
        const formatHint = args.format_hint || (ext === '.csv' ? 'csv' : undefined);
        let result;
        try {
          result = formatHint ? await lib.toMarkdownBytes(bytes, formatHint) : await lib.toMarkdownBytes(bytes);
        } catch (error) {
          const code = error.code || 'unknown';
          return { error: ERRORS[code] || String(error.message || error), code };
        }
        let markdown = typeof result === 'string' ? result : String(result);
        let format = 'unknown';
        try { format = lib.formatFromBytes(bytes) || formatHint || 'unknown'; } catch { /* optional */ }
        let truncated = false;
        if (markdown.length > MAX_OUTPUT_CHARS) {
          markdown = `${markdown.slice(0, MAX_OUTPUT_CHARS)}\n\n<!-- 文档过长已截断,原文共 ${markdown.length} 字符 -->`;
          truncated = true;
        }
        ctx.logger.info?.(`[document-tools] converted ${resolved} (${format}, ${markdown.length} chars)`);
        return { status: 'ok', format, markdown, charCount: markdown.length, truncated };
      } catch (error) {
        ctx.logger?.warn?.(`doc_to_markdown failed: ${error?.message ?? error}`);
        throw error;
      }
    },
  });
  ctx.logger.info('[document-tools] active: doc_to_markdown (with clawpdf)');
  return () => {};
}

export { name, inject };
