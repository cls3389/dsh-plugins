import { describe, expect, it } from 'vitest';
import {
  buildCardContent,
  buildStreamingPreAnswerCard,
  buildStreamingThinkingCard,
} from '../vendor/openclaw-lark/dist/card/builder.js';
import type { ToolUseDisplayStep } from '../vendor/openclaw-lark/dist/card/tool-use-display.js';

const step = {
  id: '1',
  seq: 1,
  toolName: 'read',
  title: 'Read file',
  titleZh: '读取文件',
  status: 'success',
  iconToken: 'file',
} as ToolUseDisplayStep;

function elements(card: unknown): Array<Record<string, unknown>> {
  const value = card as {
    elements?: Array<Record<string, unknown>>;
    body?: { elements: Array<Record<string, unknown>> };
  };
  return value.elements ?? value.body?.elements ?? [];
}

describe('official card tool-use visibility', () => {
  it('omits the tool panel throughout a turn without tool calls', () => {
    expect(
      elements(buildStreamingThinkingCard()).some((item) => item.tag === 'collapsible_panel'),
    ).toBe(false);
    expect(
      elements(buildStreamingPreAnswerCard({})).some((item) => item.tag === 'collapsible_panel'),
    ).toBe(false);
    for (const state of ['streaming', 'complete'] as const) {
      const card = buildCardContent(state, { text: 'Answer', showToolUse: true, toolUseSteps: [] });
      expect(elements(card).some((item) => item.tag === 'collapsible_panel')).toBe(false);
      expect(JSON.stringify(card)).not.toContain('暂无工具步骤');
      expect(JSON.stringify(card)).toContain('Answer');
    }
  });

  it('renders the tool panel when an actual tool step exists', () => {
    expect(
      elements(buildStreamingPreAnswerCard({ steps: [step] })).some(
        (item) => item.tag === 'collapsible_panel',
      ),
    ).toBe(true);
    for (const state of ['streaming', 'complete'] as const) {
      const card = buildCardContent(state, {
        text: 'Answer',
        showToolUse: true,
        toolUseSteps: [step],
      });
      expect(elements(card).some((item) => item.tag === 'collapsible_panel')).toBe(true);
      expect(JSON.stringify(card)).not.toContain('暂无工具步骤');
    }
  });
});
