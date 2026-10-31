import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply as applyPdf } from './index.js';
import { apply as applyDocument } from '../document-tools/index.js';

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
  assert.equal((await pdf.tools.get('pdf_read').execute({ file_path: csv })).code, 'unsupported');
  console.log('PASS: anydoc CSV conversion, PDF rejection, independent pdf_read text extraction');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
