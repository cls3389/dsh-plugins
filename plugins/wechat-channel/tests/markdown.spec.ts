import { describe, expect, it } from "vitest";

import { StreamingMarkdownFilter } from "../vendor/openclaw-weixin/src/messaging/markdown-filter.ts";

function render(chunks: string[]): string {
  const filter = new StreamingMarkdownFilter();
  return chunks.map((chunk) => filter.feed(chunk)).join("") + filter.flush();
}

function renderOneShot(input: string): string {
  return render([input]);
}

function everySplit(input: string): string[][] {
  const chunks: string[][] = [];
  for (let split = 1; split < input.length; split += 1) {
    chunks.push([input.slice(0, split), input.slice(split)]);
  }
  return chunks;
}

describe("StreamingMarkdownFilter", () => {
  it("preserves the same result when image syntax crosses chunk boundaries", () => {
    const input = "before ![diagram](https://example.test/a.png) after";

    for (const chunks of everySplit(input)) {
      expect(render(chunks)).toBe(renderOneShot(input));
    }
    expect(render(["before !", "[diagram](https://example.test/a", ".png) after"])).toBe(
      "before  after",
    );
  });

  it("keeps CJK emphasis content while markers arrive in separate chunks", () => {
    expect(render(["前 *中", "文", "* 后"])).toBe("前 中文 后");
    expect(render(["前 ___中", "文", "___ 后"])).toBe("前 中文 后");
  });

  it("does not lose or duplicate fenced code when fence markers are split", () => {
    const chunks = ["intro\n`", "``\nconst x = *", "* 1;\n`", "``\nend"];
    expect(render(chunks)).toBe("intro\n```\nconst x = ** 1;\n```\nend");
  });

  it("retains supported emphasis and ordinary text across arbitrary split points", () => {
    const input = "plain ***bold*** and *latin* plus ___under___\nnext";
    const expected = renderOneShot(input);

    for (const chunks of everySplit(input)) {
      expect(render(chunks)).toBe(expected);
    }
  });

  it("flushes an unfinished construct without silently dropping input", () => {
    expect(render(["prefix !", "[unfinished"])).toBe("prefix ![unfinished");
    expect(render(["prefix *", "unfinished"])).toBe("prefix *unfinished");
  });
});
