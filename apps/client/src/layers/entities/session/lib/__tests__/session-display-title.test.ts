import { describe, it, expect } from 'vitest';
import { sessionDisplayTitle, UNTITLED_SESSION_LABEL } from '../session-display-title';

describe('sessionDisplayTitle', () => {
  it('keeps a real title', () => {
    expect(sessionDisplayTitle('Fix the login bug')).toBe('Fix the login bug');
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['null', null],
    // A row written from a settings reply before the chat exists has no title
    // at all; the window title crashed on it (DOR-2820).
    ['missing', undefined],
  ])('names a %s title "New chat"', (_, title) => {
    expect(sessionDisplayTitle(title)).toBe(UNTITLED_SESSION_LABEL);
  });
});
