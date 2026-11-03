import { describe, expect, it } from 'vitest';
import { StreamingMarkdownFilter as PortFilter, filterMarkdown } from '../src/protocol/markdown.js';
import { StreamingMarkdownFilter as VendorFilter } from '../vendor/openclaw-weixin/src/messaging/markdown-filter.js';

function run(filter: { feed(d: string): string; flush(): string }, chunks: string[]): string {
  return chunks.map((chunk) => filter.feed(chunk)).join('') + filter.flush();
}

const CORPUS = [
  'plain text with **bold** and `code`',
  '```ts\nconst x = * 2;\n```\nafter',
  '| a | b |\n| --- | --- |\n| 1 | 2 |',
  'before ![diagram](https://example.test/a.png) after',
  '前 *中文斜体* 后 *latin* 尾 ___下划线___',
  '##### H5\n###### H6\n#### H4 kept?',
  '---\n***\n___\n',
  '~~strike~~ and > quote line',
  'unclosed **bold and *italic and ![img',
  'indent    code?\tnormal',
];

describe('markdown port equals the vendor snapshot', () => {
  it('produces identical output for the whole corpus', () => {
    for (const sample of CORPUS) {
      expect(run(new PortFilter(), [sample])).toBe(run(new VendorFilter(), [sample]));
      expect(filterMarkdown(sample)).toBe(run(new VendorFilter(), [sample]));
    }
  });

  it('stays identical for every single split point', () => {
    for (const sample of CORPUS) {
      for (let split = 1; split < sample.length; split += 1) {
        const chunks = [sample.slice(0, split), sample.slice(split)];
        expect(run(new PortFilter(), chunks)).toBe(run(new VendorFilter(), chunks));
      }
    }
  });
});
