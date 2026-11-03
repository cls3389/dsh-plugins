import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const name = 'officecli-tools';
const inject = ['tools'];
const dshHome = process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
const DEFAULT_CONFIG = {
  binary: path.join(homedir(), '.local', 'bin', 'officecli'),
  allowedPathPrefixes: ['/tmp/', `${dshHome}/`, '/home/'],
  maxOutputChars: 500_000,
  requestTimeoutMs: 180_000,
  gateway: {
    enabled: true,
    baseUrl: 'http://127.0.0.1:18090',
    apiTokenRef: 'BROWSER_GATEWAY_TOKEN',
    requestTimeoutMs: 90_000,
  },
};
const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx']);
const VIEW_MODES = ['outline', 'text', 'annotated', 'stats', 'issues', 'html', 'screenshot', 'svg', 'pdf'];
const EDIT_OPERATIONS = ['add', 'set', 'remove', 'move', 'swap', 'batch'];
const GATEWAY_MAX_HTML_CHARS = 7_500_000;

function renderJson(value, budget = 20_000) {
  const text = JSON.stringify(value, null, 1);
  return [{ type: 'text', text: text.length > budget ? `${text.slice(0, budget)}\n…(已截断,共 ${text.length} 字符)` : text }];
}

function pathAllowed(value, prefixes) {
  const resolved = path.resolve(String(value));
  return prefixes.some((prefix) => {
    const normalized = path.resolve(prefix);
    return resolved === normalized || resolved.startsWith(`${normalized}${path.sep}`);
  });
}

async function resolveAllowedPath(value, prefixes, { forCreate = false } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('file_path 不能为空');
  if (!path.isAbsolute(raw)) throw new Error('file_path 必须是绝对路径');
  const resolved = path.resolve(raw);
  if (!pathAllowed(resolved, prefixes)) throw new Error(`路径必须在允许前缀内: ${prefixes.join(', ')}`);
  const realPrefixes = await Promise.all(prefixes.map(async (prefix) => {
    try { return await fs.promises.realpath(prefix); } catch { return path.resolve(prefix); }
  }));
  const stat = await fs.promises.lstat(resolved).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat?.isSymbolicLink()) throw new Error('不接受符号链接路径，请使用真实文件路径');
  if (stat && !stat.isFile() && !forCreate) throw new Error(`路径不是文件: ${resolved}`);
  const probe = forCreate ? path.dirname(resolved) : resolved;
  try {
    const real = await fs.promises.realpath(probe);
    if (!realPrefixes.some((prefix) => real === prefix || real.startsWith(`${prefix}${path.sep}`))) {
      throw new Error('路径解析后超出允许目录');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!forCreate) throw new Error(`文件不存在: ${resolved}`);
  }
  return resolved;
}

function extensionFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!OFFICE_EXTENSIONS.has(ext)) throw new Error('仅支持 .docx、.xlsx、.pptx 文件');
  return ext;
}

function scalar(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function propsToArgs(props) {
  if (props == null) return [];
  if (typeof props !== 'object' || Array.isArray(props)) throw new Error('props 必须是对象');
  return Object.entries(props).flatMap(([key, value]) => [`--prop`, `${key}=${scalar(value)}`]);
}

function parseOutput(stdout, stderr, maxChars) {
  const raw = `${stdout}${stderr ? `\n${stderr}` : ''}`.trim();
  let parsed;
  try { parsed = JSON.parse(stdout.trim()); } catch { /* OfficeCLI 的部分命令输出人类可读文本 */ }
  const output = raw.length > maxChars ? `${raw.slice(0, maxChars)}\n…(输出已截断,共 ${raw.length} 字符)` : raw;
  return parsed === undefined ? { output } : { output, data: parsed };
}

async function run(binary, args, timeoutMs, maxOutputChars) {
  try {
    const result = await execFileAsync(binary, [...args, '--json'], {
      timeout: timeoutMs,
      maxBuffer: Math.max(maxOutputChars * 2, 1_000_000),
      windowsHide: true,
      env: { ...process.env, OFFICECLI_SKIP_UPDATE: '1' },
    });
    return { status: 'ok', ...parseOutput(result.stdout, result.stderr, maxOutputChars) };
  } catch (error) {
    const parsed = parseOutput(error.stdout ?? '', error.stderr ?? '', maxOutputChars);
    const envelope = parsed.data;
    // OfficeCLI 退出码 2 = "已落地但带警告"（envelope success:true，如 unsupported_property 被丢弃）。
    // JSON envelope 存在时以它的 success 为准，避免把成功操作误判为失败。
    if (!error.killed && envelope && typeof envelope === 'object' && envelope.success === true) {
      return { status: 'ok', ...parsed };
    }
    const envelopeCode = !error.killed && envelope && typeof envelope === 'object' && typeof envelope.error?.code === 'string'
      ? envelope.error.code
      : undefined;
    return {
      status: 'error',
      code: error.killed ? 'timeout' : (envelopeCode ?? (error.code || 'officecli_error')),
      ...(error.killed || envelopeCode === undefined ? {} : { exitCode: error.code }),
      error: parsed.output || String(error.message ?? error),
      ...(parsed.data === undefined ? {} : { data: parsed.data }),
    };
  }
}

function baseOutput() {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => renderJson(value),
  };
}

function viewOutput() {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => {
      const blocks = renderJson(value);
      if (value?.attachment) blocks.push({ type: 'image', attachment: value.attachment });
      return blocks;
    },
  };
}

/* ── browser-gateway 截图链路(HTML 直传,零网络拓扑依赖) ── */

// 凭据文件兜底(与 browser-tools/image-tools 同款):credentials 服务未挂载时读 refs 段。
async function readCredentialRef(refName) {
  try {
    const base = dshHome;
    const text = await fs.promises.readFile(path.join(base, '.credentials.yaml'), 'utf8');
    const escaped = refName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lineRe = new RegExp(`^\\s+${escaped}:\\s*(.+?)\\s*$`);
    let inRefs = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
      if (!inRefs) continue;
      if (/^\S/.test(line)) break;
      const match = line.match(lineRe);
      if (match === null) continue;
      let value = match[1];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return value.length > 0 ? value : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function captureHtmlViaGateway(ctx, gw, { html, outputPath, viewport, deviceScaleFactor, fullPage }) {
  let token = gw.apiToken;
  if (!token && gw.apiTokenRef) {
    const stored = await ctx.get('credentials')?.resolve(gw.apiTokenRef);
    token = stored?.value ?? await readCredentialRef(gw.apiTokenRef);
  }
  if (!token) throw new Error(`browser-gateway apiToken 未配置(${gw.apiTokenRef ?? '未设 ref'})`);
  if (html.length > GATEWAY_MAX_HTML_CHARS) {
    throw new Error(`渲染 HTML ${Math.round(html.length / 1024)}KB 超过网关请求体上限(约 8MB);请减少内嵌图片或拆分页面`);
  }
  const wantJpeg = /\.(jpe?g)$/i.test(outputPath);
  const body = {
    html,
    // officecli HTML 自包含(资源全内嵌),load 会在浏览器冷启动时挂死(504);
    // domcontentloaded 即可取到完整渲染树。
    wait_until: 'domcontentloaded',
    timeout_ms: gw.requestTimeoutMs,
    full_page: fullPage ?? true,
    image_format: wantJpeg ? 'jpeg' : 'png',
    ...(viewport ? { viewport } : {}),
    ...(deviceScaleFactor ? { device_scale_factor: deviceScaleFactor } : {}),
  };
  const resp = await fetch(`${gw.baseUrl.replace(/\/+$/, '')}/screenshot-html`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(gw.requestTimeoutMs + 15_000),
  });
  if (!resp.ok) throw new Error(`browser-gateway HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const bytes = Buffer.from(await resp.arrayBuffer());
  if (!bytes.length) throw new Error('browser-gateway 返回空截图');
  await fs.promises.writeFile(outputPath, bytes);
  return bytes.length;
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const prefixes = Array.isArray(cfg.allowedPathPrefixes) ? cfg.allowedPathPrefixes : DEFAULT_CONFIG.allowedPathPrefixes;
  const binary = String(cfg.binary || DEFAULT_CONFIG.binary);
  const timeoutMs = Math.min(Math.max(Number(cfg.requestTimeoutMs) || DEFAULT_CONFIG.requestTimeoutMs, 1_000), 600_000);
  const maxOutputChars = Math.min(Math.max(Number(cfg.maxOutputChars) || DEFAULT_CONFIG.maxOutputChars, 1_000), 2_000_000);
  const gw = { ...DEFAULT_CONFIG.gateway, ...(cfg.gateway ?? {}) };
  const workspaceFence = cfg.workspaceFence === true;

  // workspaceFence 模式:允许前缀=调用会话的个人工作区(与 write/edit 围栏同源,
  // workingDirectory 服务按 exec.agent.session 查)。拿不到工作区时 fail-closed 拒绝。
  function prefixesFor(exec) {
    if (!workspaceFence) return prefixes;
    let baseDir;
    try { baseDir = ctx.get('workingDirectory')?.get(exec?.agent?.session); } catch { /* 保持 undefined */ }
    if (typeof baseDir !== 'string' || !baseDir) {
      throw new Error('workspaceFence 模式下无法确定当前会话工作区，已拒绝执行');
    }
    return [baseDir];
  }

  ctx.tools.register({
    name: 'office_create',
    description: '用 OfficeCLI 创建空白 DOCX、XLSX 或 PPTX 文件；不需要安装 Microsoft Office。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '输出文件绝对路径，扩展名必须是 .docx/.xlsx/.pptx' },
        locale: { type: 'string', description: '可选语言区域，例如 zh-CN 或 en-US' },
        minimal: { type: 'boolean', description: '是否创建最小 OOXML 骨架' },
      },
      required: ['file_path'],
    },
    output: baseOutput(),
    async execute(args, exec) {
      try {
        const filePath = await resolveAllowedPath(args.file_path, prefixesFor(exec), { forCreate: true });
        extensionFor(filePath);
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        const cliArgs = ['create', filePath];
        if (args.locale) cliArgs.push('--locale', String(args.locale));
        if (args.minimal === true) cliArgs.push('--minimal');
        const result = await run(binary, cliArgs, timeoutMs, maxOutputChars);
        if (result.status === 'ok') result.file_path = filePath;
        ctx.logger.info?.(`[officecli-tools] create ${filePath}: ${result.status}`);
        return result;
      } catch (error) {
        return { status: 'error', error: error.message, code: error.code || 'invalid_input' };
      }
    },
  });

  ctx.tools.register({
    name: 'office_view',
    description: '读取或渲染 DOCX、XLSX、PPTX；支持 outline/text/annotated/stats/issues/html/screenshot/svg/pdf。screenshot 模式经共享浏览器网关渲染(officecli 出 HTML → browser-gateway 截图),无需本机浏览器。注意:screenshot 渲染的是 HTML 流式长页,没有 Word 打印分页概念——cantSplit/分页符等打印属性在截图里不可见,验证跨页表格请看 outline/text 或最终文件本身;截图内容不变化≠缓存问题,先核对文件是否真的改了。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Office 文件绝对路径' },
        mode: { type: 'string', enum: VIEW_MODES, description: '查看模式，默认 outline' },
        output_path: { type: 'string', description: 'html/screenshot/svg/pdf 的输出路径；screenshot 必填' },
        page: { type: 'integer', minimum: 1, description: '可选页码' },
        viewport: {
          type: 'object',
          properties: { width: { type: 'integer' }, height: { type: 'integer' } },
          description: 'screenshot 视口(需网关),如 {width:1280,height:800}',
        },
        device_scale_factor: { type: 'number', minimum: 1, maximum: 3, description: 'screenshot 高清倍率(需网关),1-3' },
        full_page: { type: 'boolean', description: 'screenshot 是否整页(需网关),默认 true' },
      },
      required: ['file_path'],
    },
    output: viewOutput(),
    async execute(args, exec) {
      try {
        const filePath = await resolveAllowedPath(args.file_path, prefixesFor(exec));
        extensionFor(filePath);
        const mode = args.mode || 'outline';
        if (!VIEW_MODES.includes(mode)) throw new Error(`不支持的查看模式: ${mode}`);
        let outputPath;
        if (args.output_path) {
          outputPath = await resolveAllowedPath(args.output_path, prefixesFor(exec), { forCreate: true });
          await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
        }
        // screenshot 优先走 browser-gateway:officecli 渲染 HTML(零浏览器依赖) → 网关 set_content 截图。
        if (mode === 'screenshot' && gw.enabled !== false) {
          if (!outputPath) return { status: 'error', error: 'screenshot(经网关)必须提供 output_path(.png/.jpg)', code: 'invalid_input' };
          const htmlPath = `${outputPath}.render.html`;
          const htmlArgs = ['view', filePath, 'html', '-o', htmlPath];
          if (args.page !== undefined) htmlArgs.push('--page', String(args.page));
          try {
            const htmlResult = await run(binary, htmlArgs, timeoutMs, maxOutputChars);
            if (htmlResult.status !== 'ok') {
              return { ...htmlResult, error: `officecli 渲染 HTML 失败: ${htmlResult.error ?? htmlResult.output ?? 'unknown'}`, file_path: filePath };
            }
            const html = await fs.promises.readFile(htmlPath, 'utf8');
            const bytes = await captureHtmlViaGateway(ctx, gw, {
              html,
              outputPath,
              viewport: args.viewport,
              deviceScaleFactor: args.device_scale_factor,
              fullPage: args.full_page,
            });
            const result = { status: 'ok', file_path: filePath, output_path: outputPath, bytes, renderer: 'browser-gateway' };
            try {
              const attachment = await ctx.get('attachments')?.saveImage({ data: await fs.promises.readFile(outputPath), mediaType: /\.(jpe?g)$/i.test(outputPath) ? 'image/jpeg' : 'image/png', name: path.basename(outputPath) });
              if (attachment) result.attachment = attachment;
            } catch (error) { ctx.logger.warn?.(`[officecli-tools] preview attachment failed: ${error.message}`); }
            ctx.logger.info?.(`[officecli-tools] view ${filePath} (screenshot via gateway): ok ${bytes}B`);
            return result;
          } catch (error) {
            return { status: 'error', code: 'screenshot_gateway_failed', error: `经 browser-gateway 截图失败: ${error.message}`, file_path: filePath };
          } finally {
            fs.promises.rm(htmlPath, { force: true }).catch(() => {});
          }
        }
        const cliArgs = ['view', filePath, mode];
        if (outputPath) cliArgs.push('-o', outputPath);
        if (args.page !== undefined) cliArgs.push('--page', String(args.page));
        const result = await run(binary, cliArgs, timeoutMs, maxOutputChars);
        if (result.status === 'ok') {
          result.file_path = filePath;
          if (outputPath) result.output_path = outputPath;
          if (outputPath && fs.existsSync(outputPath)) {
            const stat = await fs.promises.stat(outputPath);
            result.bytes = stat.size;
            if (outputPath.toLowerCase().endsWith('.png')) {
              try {
                const attachment = await ctx.get('attachments')?.saveImage({ data: await fs.promises.readFile(outputPath), mediaType: 'image/png', name: path.basename(outputPath) });
                if (attachment) result.attachment = attachment;
              } catch (error) { ctx.logger.warn?.(`[officecli-tools] preview attachment failed: ${error.message}`); }
            }
          }
        }
        ctx.logger.info?.(`[officecli-tools] view ${filePath} (${mode}): ${result.status}`);
        return result;
      } catch (error) {
        return { status: 'error', error: error.message, code: error.code || 'invalid_input' };
      }
    },
  });

  ctx.tools.register({
    name: 'office_edit',
    description: '用结构化参数编辑 Office 文件：add/set/remove/move/swap/batch；不执行任意 shell 命令。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Office 文件绝对路径' },
        operation: { type: 'string', enum: EDIT_OPERATIONS },
        path: { type: 'string', description: '目标元素路径' },
        path2: { type: 'string', description: 'swap 的第二个元素路径' },
        parent: { type: 'string', description: 'add 的父元素路径' },
        type: { type: 'string', description: 'add 的元素类型，例如 paragraph/cell/slide/shape' },
        props: { type: 'object', description: 'OfficeCLI --prop 属性对象' },
        to: { type: 'string', description: 'move 的目标父路径' },
        index: { type: 'integer', description: 'move/add 的位置' },
        commands: { type: 'array', items: { type: 'object' }, description: 'batch 的受限命令对象数组' },
      },
      required: ['file_path', 'operation'],
    },
    output: baseOutput(),
    async execute(args, exec) {
      try {
        const filePath = await resolveAllowedPath(args.file_path, prefixesFor(exec));
        extensionFor(filePath);
        const operation = String(args.operation || '');
        if (!EDIT_OPERATIONS.includes(operation)) throw new Error(`不支持的编辑操作: ${operation}`);
        let cliArgs = [operation, filePath];
        if (operation === 'add') {
          if (!args.parent || !args.type) throw new Error('add 必须提供 parent 和 type');
          cliArgs.push(args.parent, '--type', String(args.type), ...propsToArgs(args.props));
          if (args.index !== undefined) cliArgs.push('--index', String(args.index));
        } else if (operation === 'set') {
          if (!args.path) throw new Error('set 必须提供 path');
          cliArgs.push(args.path, ...propsToArgs(args.props));
        } else if (operation === 'remove') {
          if (!args.path) throw new Error('remove 必须提供 path');
          cliArgs.push(args.path);
        } else if (operation === 'move') {
          if (!args.path || !args.to) throw new Error('move 必须提供 path 和 to');
          cliArgs.push(args.path, '--to', args.to);
          if (args.index !== undefined) cliArgs.push('--index', String(args.index));
        } else if (operation === 'swap') {
          if (!args.path || !args.path2) throw new Error('swap 必须提供 path 和 path2');
          cliArgs.push(args.path, args.path2);
        } else if (operation === 'batch') {
          if (!Array.isArray(args.commands) || args.commands.length === 0) throw new Error('batch 必须提供非空 commands 数组');
          if (args.commands.length > 200) throw new Error('batch 最多 200 条命令');
          const encoded = JSON.stringify(args.commands);
          if (encoded.length > 1_000_000) throw new Error('batch commands 过大');
          cliArgs.push('--commands', encoded);
        }
        const result = await run(binary, cliArgs, timeoutMs, maxOutputChars);
        result.file_path = filePath;
        ctx.logger.info?.(`[officecli-tools] ${operation} ${filePath}: ${result.status}`);
        return result;
      } catch (error) {
        return { status: 'error', error: error.message, code: error.code || 'invalid_input' };
      }
    },
  });

  ctx.tools.register({
    name: 'office_validate',
    description: '校验 DOCX、XLSX、PPTX 是否符合 OpenXML 结构规范。',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string', description: 'Office 文件绝对路径' } },
      required: ['file_path'],
    },
    output: baseOutput(),
    async execute(args, exec) {
      try {
        const filePath = await resolveAllowedPath(args.file_path, prefixesFor(exec));
        extensionFor(filePath);
        const result = await run(binary, ['validate', filePath], timeoutMs, maxOutputChars);
        result.file_path = filePath;
        return result;
      } catch (error) {
        return { status: 'error', error: error.message, code: error.code || 'invalid_input' };
      }
    },
  });

  ctx.logger.info(`[officecli-tools] active: office_create / office_view / office_edit / office_validate (${binary})`);
  return () => {};
}

export { name, inject };
