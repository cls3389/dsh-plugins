#!/usr/bin/env node
/** Authorized end-to-end regression; secrets stay in the local private registry. */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const home = process.env.DSH_HOME ?? '/data/dsh';
const credentialFile = process.env.FEISHU_SANDBOX_TOKEN_FILE ?? `${home}/lark/sandbox-test-user-token.json`;
const botsFile = process.env.FEISHU_BOTS_FILE ?? `${home}/lark/bots-guests.json`;
const token = JSON.parse(await readFile(credentialFile, 'utf8'));
const bot = JSON.parse(await readFile(botsFile, 'utf8')).find((item) => item.appId === token.appId);
if (!bot) throw new Error('OAuth application is absent from the private bot registry');
if (!token.scope.split(/\s+/).includes('im:message')) throw new Error('User OAuth does not include im:message');
if (Date.now() > token.expiresAt - 60_000) {
  const response = await fetch('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: bot.appId, client_secret: bot.appSecret }),
  });
  const next = await response.json();
  if (!response.ok || !next.access_token) throw new Error(`OAuth refresh failed: ${next.error_description ?? next.error ?? response.status}`);
  Object.assign(token, next);
  await writeFile(credentialFile, JSON.stringify(token), { mode: 0o600 });
}
const text = process.argv.slice(2).join(' ') || '管理员自动沙箱回归：请只用 bash 执行 pwd、hostname、python3 --version、node --version，以及 curl --connect-timeout 2 https://example.com；随后用 bash_compact 执行 echo compact-ok。不要查询业务数据、不要读取或修改其他文件。原样报告命令输出。';
const response = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
  method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ receive_id: process.env.FEISHU_TEST_CHAT_ID ?? 'oc_017484b6538be20e5431b8dee37f7eb7', msg_type: 'text', content: JSON.stringify({ text }), uuid: randomUUID() }),
});
const sent = await response.json();
if (!response.ok || sent.code !== 0) throw new Error(`Feishu send failed: ${sent.msg ?? response.status}`);
console.log(JSON.stringify({ messageId: sent.data.message_id, sentAt: Date.now() }));

if (process.env.FEISHU_TEST_NO_WAIT === '1') process.exit(0);
const transcript = process.env.FEISHU_TEST_TRANSCRIPT ?? `${home}/sessions/--data-dsh-home-agents-investment-assistant-users-u_mvuwm8zz31008e43--/lark-1793427271841-561d39d1/session.v4.jsonl.zstd`;
const started = Date.now();
await new Promise((resolve) => setTimeout(resolve, 15_000));
const events = execFileSync('zstd', ['-dc', resolve(transcript)], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim().split('\n').map(JSON.parse);
const calls = new Map();
let bashOutput = '';
for (const event of events) {
  if (event.type === 'tool/call' && ['bash', 'bash_compact'].includes(event.data.name) && event.time >= started - 2_000) calls.set(event.data.callId, event.data.name);
  if (event.type === 'tool/result' && calls.has(event.data.message?.toolCallId)) {
    const text = event.data.message.content?.map((item) => item.text ?? '').join('\n') ?? '';
    if (calls.get(event.data.message.toolCallId) === 'bash') bashOutput += text;
    console.log(JSON.stringify({ tool: calls.get(event.data.message.toolCallId), error: event.data.message.isError, content: event.data.message.content }));
  }
}
if (!bashOutput.includes('Python 3.12.') || !bashOutput.includes('v22.') || bashOutput.includes('\nlin\n') || !/\n[0-9a-f]{12}\n/.test(bashOutput) || !bashOutput.includes('curl_exit=6')) {
  throw new Error('REGRESSION FAILED: a command escaped the session Docker sandbox');
}
console.log('PASS: real Feishu user message executed inside the session Docker sandbox');
