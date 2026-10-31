import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { apply as applyPdf } from './index.js';
import { apply as applyDocument } from '../document-tools/index.js';
import { readPdf, assertRenderablePage } from './reader.js';

const temporary = await mkdtemp(join(tmpdir(), 'pdf-tools-test-'));
try {
  const csv = join(temporary, 'test.csv');
  await writeFile(csv, 'name,value\nPDF split,ok\n');
  function registry() {
    const tools = new Map();
    return { tools, ctx: {
      tools: { register: (tool) => { tools.set(tool.name, tool); return () => {}; } },
      get: () => undefined,
      logger: { info() {}, warn() {} },
    } };
  }
  const docs = registry();
  applyDocument(docs.ctx);
  const converted = await docs.tools.get('doc_to_markdown').execute({ file_path: csv });
  assert.equal(converted.status, 'ok');
  assert.match(converted.markdown, /PDF split/);
  assert.equal((await docs.tools.get('doc_to_markdown').execute({ file_path: '/data/dsh/attachments/v1/files/90/905d69d9a006e6d839488680e0787671a3da3fc34ca6dbfc94b0c3fd5730d578/20261018格兰周策略：坚守底线.pdf' })).code, 'unsupported');

  const pdf = registry();
  applyPdf(pdf.ctx);
  const result = await pdf.tools.get('pdf_read').execute({
    file_path: '/data/dsh/attachments/v1/files/90/905d69d9a006e6d839488680e0787671a3da3fc34ca6dbfc94b0c3fd5730d578/20261018格兰周策略：坚守底线.pdf',
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.type, 'text');
  assert.match(result.markdown, /周策略：坚守底线/);
  assert.equal(result.totalPages, 13);
  assert.equal(result.processedPages, 13);
  assert.equal(result.truncated, false);
  const textLimited = await readPdf(await readFile('/data/dsh/attachments/v1/files/90/905d69d9a006e6d839488680e0787671a3da3fc34ca6dbfc94b0c3fd5730d578/20261018格兰周策略：坚守底线.pdf'), { maxTextChars: 100 });
  assert.equal(textLimited.truncated.text, true);
  const limited = await pdf.tools.get('pdf_read').execute({ file_path: '/data/dsh/attachments/v1/files/90/905d69d9a006e6d839488680e0787671a3da3fc34ca6dbfc94b0c3fd5730d578/20261018格兰周策略：坚守底线.pdf', max_pages: 6 });
  assert.equal(limited.totalPages, 13);
  assert.equal(limited.processedPages, 6);
  assert.equal(limited.truncatedPages, true);
  assert.match(pdf.tools.get('pdf_read').output.render({}, limited)[0].text, /共 13 页，已处理前 6 页/);
  assert.match(pdf.tools.get('pdf_read').output.render({}, limited)[0].text, /其余 7 页未读取/);
  assert.equal((await pdf.tools.get('pdf_read').execute({ file_path: csv })).code, 'unsupported');
  console.log('PASS: anydoc CSV conversion, PDF rejection, independent pdf_read text extraction');

  const scanned = await readPdf(await readFile('/data/dsh/attachments/v1/files/b1/b1830e71fa48aa75ecd6750aafc9829cc4a42e79a925ff56fe8dc987354f6c73/20260802格兰周策略：8月开篇.pdf'));
  assert.equal(scanned.totalPages, 13);
  assert.equal(scanned.images.length, 13);
  assert.deepEqual(scanned.images.map((image) => image.page), Array.from({ length: 13 }, (_, index) => index + 1));
  assert.ok(scanned.images.every((image) => image.width >= 794 && image.height >= 1123));
  console.log('PASS: all 13 scanned pages retain full resolution, no shared pixel-budget shrinkage');

  const textPath = join(temporary, 'text.pdf');
  const imagePath = join(temporary, 'image-%d.pdf');
  const decryptedPath = join(temporary, 'image-decrypted.pdf');
  const mixedPath = join(temporary, 'mixed.pdf');
  execFileSync('pdfseparate', ['-f', '1', '-l', '1', '/data/dsh/attachments/v1/files/90/905d69d9a006e6d839488680e0787671a3da3fc34ca6dbfc94b0c3fd5730d578/20261018格兰周策略：坚守底线.pdf', textPath]);
  execFileSync('pdfseparate', ['-f', '1', '-l', '1', '/data/dsh/attachments/v1/files/19/1994d56345f107f9364fac14b2abf741d38cdc956f2474cddc7e70a9b5de262c/20260920格兰周策略：股池梳理.pdf', imagePath]);
  execFileSync('gs', ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=pdfwrite', `-sOutputFile=${decryptedPath}`, join(temporary, 'image-1.pdf')]);
  execFileSync('pdfunite', [textPath, decryptedPath, textPath, mixedPath]);
  const mixed = await readPdf(await readFile(mixedPath));
  assert.equal(mixed.totalPages, 3);
  assert.equal(mixed.processedPages, 3);
  assert.deepEqual(mixed.renderedPages, [2]);
  assert.deepEqual(mixed.images.map((image) => image.page), [2]);
  assert.match(mixed.text, /【PDF 第 2 页 · 文字层】/);
  assert.deepEqual(mixed.pageErrors, []);
  console.log('PASS: mixed PDF keeps scan page 2 as an image with explicit text-page boundaries');

  assert.throws(() => assertRenderablePage({ page: 1, width: 1, height: 1 }), /页面渲染尺寸异常/);
  assert.throws(() => assertRenderablePage({ page: 6, width: 16, height: 22 }), /16×22px/);
  console.log('PASS: page totals/truncation are explicit and tiny renders are rejected');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
