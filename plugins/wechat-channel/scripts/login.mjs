#!/usr/bin/env node
/**
 * Explicit Weixin QR login for the DSH wechat-channel plugin.
 *
 * Usage:
 *   node scripts/login.mjs --account <accountId> --data-dir <dir>
 *
 * Writes <dataDir>/credentials.json (0600). The channel service never logs in
 * by itself; run this script manually whenever a bot needs (re)authorization.
 */
import { parseArgs } from 'node:util';
import { WeixinStateStore, fetchQrCode, pollQrStatus } from '../lib/protocol.js';

const { values } = parseArgs({
  options: {
    account: { type: 'string', default: 'default' },
    'data-dir': { type: 'string' },
    'bot-type': { type: 'string', default: '3' },
  },
});

const dataDir = values['data-dir']
  ?? process.env.DSH_WECHAT_DATA_DIR
  ?? `${process.env.DSH_HOME ?? `${process.env.HOME}/.dsh`}/wechat`;

const state = new WeixinStateStore(dataDir, values.account);

async function displayQr(url) {
  try {
    const qrterm = await import('qrcode-terminal');
    qrterm.default.generate(url, { small: true });
  } catch {
    /* qrcode-terminal is optional; the raw URL below is enough */
  }
  process.stdout.write(`若二维码未能显示，请打开以下链接或将其转成二维码后用微信扫描：\n${url}\n`);
}

async function readVerifyCode() {
  process.stdout.write('请输入手机微信上显示的数字：');
  return new Promise((resolve) => {
    let input = '';
    const onData = (chunk) => {
      input += chunk.toString();
      if (input.includes('\n')) {
        process.stdin.removeListener('data', onData);
        process.stdin.pause();
        resolve(input.trim());
      }
    };
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
  });
}

const qr = await fetchQrCode({ botType: values['bot-type'] });
if (!qr.qrcode || !qr.qrcode_img_content) {
  console.error('获取二维码失败:', JSON.stringify(qr));
  process.exit(1);
}
await displayQr(qr.qrcode_img_content);

const deadline = Date.now() + 8 * 60_000;
let verifyCode;
let baseUrl;
while (Date.now() < deadline) {
  const status = await pollQrStatus({ qrcode: qr.qrcode, baseUrl, verifyCode });
  if (status.redirect_host) baseUrl = `https://${status.redirect_host}`;
  switch (status.status) {
    case 'confirmed': {
      if (!status.bot_token || !status.ilink_bot_id) {
        console.error('登录确认但缺少凭证:', JSON.stringify(status));
        process.exit(1);
      }
      await state.saveAccount({
        accountId: values.account,
        botId: status.ilink_bot_id,
        token: status.bot_token,
        baseUrl: status.baseurl ?? baseUrl ?? 'https://ilinkai.weixin.qq.com',
        ...(status.ilink_user_id ? { userId: status.ilink_user_id } : {}),
      });
      process.stdout.write(`登录成功，凭证已写入 ${state.root}/credentials.json\n`);
      if (status.ilink_user_id) {
        process.stdout.write(`扫码用户 ilink_user_id：${status.ilink_user_id}（可加入 allowedUsers）\n`);
      }
      process.exit(0);
      break;
    }
    case 'expired':
      console.error('二维码已过期，请重新运行登录。');
      process.exit(1);
      break;
    case 'need_verifycode':
      verifyCode = await readVerifyCode();
      break;
    case 'scaned_but_redirect':
      if (!baseUrl) process.stdout.write('检测到线路切换，继续等待确认…\n');
      break;
    case 'scaned':
      process.stdout.write('已扫码，等待确认…\n');
      break;
    default:
      break;
  }
  verifyCode = undefined;
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
console.error('登录超时，请重试。');
process.exit(1);
