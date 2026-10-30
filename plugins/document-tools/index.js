import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

const name = 'document-tools';
const inject = ['tools'];
// 允许前缀默认值：通用目录 + 本机 DSH_HOME（可移植；profile 可用 allowedPathPrefixes 覆盖）
const dshHome = process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
const DEFAULT_PREFIXES = ['/tmp/', `${dshHome}/`, '/home/'];
const MAX_OUTPUT_CHARS = 500_000;
const ERRORS = {
  unsupported: '不支持的文件格式。PDF 请直接用其他工具处理。',
  malformed: '文件结构损坏,无法解析。',
  encrypted: '文件已加密或受密码保护,无法转换。',
  resourceLimit: '文件超出安全限制(解压体积/嵌套深度/节点数过大)。',
  missingPart: '文件缺少必要组成部分,可能已损坏。',
  io: '文件读取失败,请检查路径是否正确。',
};
const anyJsonOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
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

export function apply(ctx, config) {
  const prefixes = config?.allowedPathPrefixes ?? DEFAULT_PREFIXES;
  ctx.tools.register({
    name: 'doc_to_markdown',
    description: '将本地文档转为 Markdown(docx/doc/pptx/ppt/xlsx/xls/rtf/epub/csv/odt/ods/odp)。毫秒级本地转换,无需 OCR;不支持 PDF 与加密文档。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文档绝对路径' },
        format_hint: { type: 'string', description: '自动检测失败时手动指定格式', enum: ['docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls', 'rtf', 'epub', 'csv', 'odt', 'ods', 'odp'] },
      },
      required: ['file_path'],
    },
    output: anyJsonOutput,
    async execute(args) {
      const filePath = String(args.file_path || '').trim();
      if (!filePath) return { error: 'file_path 不能为空' };
      const resolved = path.resolve(filePath);
      if (!prefixes.some((prefix) => resolved.startsWith(prefix))) return { error: `路径必须在允许前缀内: ${prefixes.join(', ')}` };
      if (!fs.existsSync(resolved)) return { error: `文件不存在: ${resolved}`, code: 'io' };
      let lib;
      try { lib = loadAnydoc(); } catch (error) { return { error: error.message }; }
      const bytes = fs.readFileSync(resolved);
      const formatHint = args.format_hint || (path.extname(resolved).toLowerCase() === '.csv' ? 'csv' : undefined);
      let result;
      try {
        result = formatHint ? await lib.toMarkdownBytes(bytes, formatHint) : await lib.toMarkdownBytes(bytes);
      } catch (error) {
        const code = error.code || 'unknown';
        return { error: ERRORS[code] || String(error.message || error), code };
      }
      let markdown = typeof result === 'string' ? result : String(result);
      let format = 'unknown';
      try { format = lib.formatFromBytes(bytes) || formatHint || 'unknown'; } catch { /* optional detection */ }
      let truncated = false;
      if (markdown.length > MAX_OUTPUT_CHARS) {
        markdown = `${markdown.slice(0, MAX_OUTPUT_CHARS)}\n\n<!-- 文档过长已截断,原文共 ${markdown.length} 字符 -->`;
        truncated = true;
      }
      ctx.logger.info?.(`[document-tools] converted ${resolved} (${format}, ${markdown.length} chars)`);
      return { status: 'ok', format, markdown, charCount: markdown.length, truncated };
    },
  });
  ctx.logger.info('[document-tools] active: doc_to_markdown');
  return () => {};
}

export { name, inject };
