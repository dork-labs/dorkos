/**
 * The guard for DOR-4976: no `<dork-…>` markup a chat's stored title carries may
 * reach a visible title, a page heading or `document.title`.
 *
 * A chat named from a new agent's greeting kickoff before the fix still stores
 * `<dork-kickoff>` as its title. Every surface that names a chat reads it
 * through `sessionDisplayTitle`, so it shows "New chat", and the window title
 * follows the same "{Agent} · {title}" pattern as any other chat. The page
 * heading's case lives beside the page (`SessionPage.test.tsx`), with the
 * real title rule behind it.
 */
import { describe, expect, it } from 'vitest';
import { chatTabIdentity, windowTitle } from '@/layers/features/app-tabs';
import { sessionDisplayTitle, UNTITLED_SESSION_LABEL } from '@/layers/entities/session';

/** Any DorkOS fence tag, opening or closing, a later one included. */
const DORK_MARKUP = /<\/?dork-/i;

/** Titles a chat may have stored before DOR-4976, or that a later tag could bring. */
const STORED = ['<dork-kickoff>', '</dork-kickoff>', 'Hello <dork-some-future-tag>'];

describe.each(STORED)('a chat stored with the title %j', (stored) => {
  it('is named "New chat" wherever the app names a chat', () => {
    const shown = sessionDisplayTitle(stored);
    expect(shown).toBe(UNTITLED_SESSION_LABEL);
    expect(shown).not.toMatch(DORK_MARKUP);
  });

  it('gives the window the same "{Agent} · New chat" title as any other chat', () => {
    const title = windowTitle(
      chatTabIdentity({ agentName: 'Aurora', chatTitle: sessionDisplayTitle(stored) }),
      { hidden: false, unseenReply: false, badgeCount: 0 }
    );
    expect(title).toBe('Aurora · New chat — DorkOS');
    expect(title).not.toMatch(DORK_MARKUP);
  });
});
