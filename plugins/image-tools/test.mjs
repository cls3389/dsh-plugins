import assert from 'node:assert/strict';
import { apply } from './index.js';

const reference = { attachmentId: 'sha256:test', variantId: 'original', mediaType: 'image/png' };
const tools = new Map();
const ctx = {
  get(name) {
    if (name === 'attachments') return { saveImage: async ({ data, mediaType, name }) => {
      assert(data.length > 0);
      assert.equal(mediaType, 'image/jpeg');
      assert.match(name, /\.jpg$/);
      return reference;
    } };
    return undefined;
  },
  tools: { register: (tool) => { tools.set(tool.name, tool); return () => {}; } },
  logger: { info() {}, warn() {}, error() {} },
};
const previousFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  assert.match(url, /\/images\/generations$/);
  assert.equal(options.headers.Authorization, 'Bearer test-key');
  // Actual providers may return JPEG bytes even when PNG was requested.
  const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffdb004300' + '00'.repeat(64) + 'ffc00011080001000103012200021101031101ffd9', 'hex');
  return new Response(JSON.stringify({ data: [{ b64_json: jpeg.toString('base64') }] }), { status: 200 });
};
try {
  apply(ctx, { apiKey: 'test-key', imageDir: `/tmp/image-tools-test-${process.pid}` });
  const result = await tools.get('image_generate').execute({ prompt: '自我介绍图', n: 1 });
  assert.equal(result.status, 'ok');
  assert.match(result.image_path, /\.jpg$/);
  assert.equal(result.images[0].format, 'jpg');
  const blocks = tools.get('image_generate').output.render({}, result);
  assert(blocks.some((block) => block.type === 'image' && block.attachment === reference));
  assert.match(blocks.at(-1).text, /直接检查上方实际生成的图片/);
  console.log('PASS: generated image is returned as a model-visible attachment');
} finally {
  globalThis.fetch = previousFetch;
}
