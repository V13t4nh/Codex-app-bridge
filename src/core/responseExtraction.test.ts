import { describe, expect, test } from 'vitest';
import { selectNewResponse, selectNewResponseText, type ResponseSnapshot } from './responseExtraction.js';

const snapshot = (items: string[], source = 'article'): ResponseSnapshot => ({ source, items });

describe('selectNewResponseText', () => {
  test('selects the newest response item after the previous snapshot', () => {
    const before = snapshot(['old answer']);
    const current = snapshot(['old answer', 'new answer']);

    expect(selectNewResponseText(before, current, 'hello')).toBe('new answer');
  });

  test('ignores a new prompt echo while waiting for assistant text', () => {
    const before = snapshot(['old answer']);
    const current = snapshot(['old answer', 'Say exactly: bridge-ok']);

    expect(selectNewResponseText(before, current, 'Say exactly: bridge-ok')).toBeUndefined();
  });

  test('accepts a streaming update on the last existing item', () => {
    const before = snapshot(['partial answer']);
    const current = snapshot(['partial answer now complete']);

    expect(selectNewResponseText(before, current, 'prompt')).toBe('partial answer now complete');
  });

  test('does not reject a repeated answer if it appears as a new item', () => {
    const before = snapshot(['bridge-ok']);
    const current = snapshot(['bridge-ok', 'bridge-ok']);

    expect(selectNewResponseText(before, current, 'Say exactly: bridge-ok')).toBe('bridge-ok');
  });

  test('keeps the newest item even when previous identical e2e responses exist', () => {
    const before = snapshot(['old answer', 'bridge-e2e-ok']);
    const current = snapshot(['old answer', 'bridge-e2e-ok', 'bridge-perf-1']);

    expect(selectNewResponseText(before, current, 'Reply exactly: bridge-perf-1')).toBe('bridge-perf-1');
  });

  test('returns formatted HTML for the selected response when available', () => {
    const before = snapshot(['old answer']);
    const current: ResponseSnapshot = {
      source: 'article',
      items: ['old answer', 'new answer'],
      htmlItems: ['old answer', '<b>new</b> answer'],
    };

    expect(selectNewResponse(before, current, 'hello')).toEqual({
      text: 'new answer',
      formattedText: '<b>new</b> answer',
      format: 'html',
    });
  });
});
