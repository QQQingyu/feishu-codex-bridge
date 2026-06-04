import { describe, expect, it } from 'vitest';
import { renderCard } from '../src/card/run-renderer';
import type { Block, RunState } from '../src/card/run-state';

describe('run renderer', () => {
  it('keeps a streaming card within Feishu-friendly size when a run has many blocks', () => {
    const blocks: Block[] = [];
    for (let i = 0; i < 40; i++) {
      blocks.push({
        kind: 'text',
        content: `第 ${i} 段文字\n${'长文本'.repeat(900)}`,
        streaming: false,
      });
      blocks.push({
        kind: 'tool',
        tool: {
          id: `tool-${i}`,
          name: 'Bash',
          input: { command: `printf ${i}` },
          status: 'done',
          output: `工具输出 ${i}\n${'0123456789'.repeat(700)}`,
        },
      });
    }

    const card = renderCard({
      blocks,
      reasoning: { content: '思考'.repeat(900), active: false },
      footer: 'tool_running',
      terminal: 'running',
    });

    expect(JSON.stringify(card).length).toBeLessThanOrEqual(30_000);
    expect(bodyElements(card).length).toBeLessThanOrEqual(18);
    expect(maxMarkdownContentLength(card)).toBeLessThanOrEqual(2_200);
    expect(markdownContents(card).join('\n')).toMatch(/较早内容已折叠/);
  });

  it('truncates a single oversized assistant text block before rendering', () => {
    const card = renderCard({
      blocks: [
        {
          kind: 'text',
          content: `长回复\n${'abcdef'.repeat(3000)}`,
          streaming: true,
        },
      ],
      reasoning: { content: '', active: false },
      footer: 'streaming',
      terminal: 'running',
    });

    expect(maxMarkdownContentLength(card)).toBeLessThanOrEqual(2_200);
    expect(markdownContents(card).join('\n')).toMatch(/内容已截断/);
  });
});

function bodyElements(card: unknown): unknown[] {
  if (!card || typeof card !== 'object') return [];
  const body = (card as { body?: { elements?: unknown } }).body;
  return Array.isArray(body?.elements) ? body.elements : [];
}

function markdownContents(card: unknown): string[] {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.content === 'string') found.push(record.content);
    for (const value of Object.values(record)) visit(value);
  };
  visit(card);
  return found;
}

function maxMarkdownContentLength(card: unknown): number {
  return Math.max(0, ...markdownContents(card).map((content) => content.length));
}
