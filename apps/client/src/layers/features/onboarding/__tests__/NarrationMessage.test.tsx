/**
 * @vitest-environment jsdom
 *
 * The scripted narration is drawn by the SHARED message row, not by a bespoke
 * bubble of onboarding's own.
 *
 * This is the whole point of the row's composition (Known Issue 29,
 * `specs/unified-conversation/04-implementation.md`): onboarding used to borrow
 * `SessionMessage`, which pinned that row — and its body renderer — inside
 * `features/chat` for as long as a feature was rendering it. Composing
 * `Message.*` here is what freed both to move up to `widgets/session`, and it
 * only stays freed while the narration keeps going through the compound. Every
 * assertion below turns red if a narrated line is drawn with anything else.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReactElement } from 'react';
import type { MessageAuthor } from '@/layers/shared/model';
import { Conversation } from '@/layers/features/conversation';
import { buildScriptMessage } from '../model/onboarding-script';
import { NARRATION_CAPABILITIES } from '../model/narration-capabilities';
import { NarrationMessage } from '../ui/NarrationMessage';

// Streamdown pulls in a full markdown pipeline this suite has no use for. The
// wrapper around it is what is under test, so the text still has to arrive.
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => (
    <div data-testid="streamdown">{children}</div>
  ),
}));

afterEach(cleanup);

const DORKBOT: MessageAuthor = {
  kind: 'agent',
  id: '01J8ZQ0000000000000000000',
  displayName: 'DorkBot',
  emoji: '🤖',
  color: '#4f46e5',
};

/** Render a narrated line inside the conversation onboarding declares for it. */
function renderNarration(ui: ReactElement) {
  return render(
    <Conversation.Root surface="session" capabilities={NARRATION_CAPABILITIES}>
      {ui}
    </Conversation.Root>
  );
}

describe('NarrationMessage', () => {
  it('draws the shared row: every Message.* slot is on screen', () => {
    renderNarration(
      <NarrationMessage
        message={buildScriptMessage('ob-line-0', 'assistant', 'Hey — I’m DorkBot.')}
        grouping={{ position: 'only' }}
        author={DORKBOT}
      />
    );

    // The seam itself. A plain `<div>` bubble would render the text and none of
    // these, which is exactly the regression this file exists to catch.
    const row = screen.getByTestId('message-item');
    expect(row).toHaveAttribute('data-slot', 'message-root');
    expect(row).toHaveAttribute('role', 'article');
    expect(row.querySelector('[data-slot="message-gutter"]')).not.toBeNull();
    expect(row.querySelector('[data-slot="message-body"]')).not.toBeNull();
    expect(row.querySelector('[data-slot="message-author"]')).not.toBeNull();
    expect(row.querySelector('[data-slot="message-content"]')).not.toBeNull();
  });

  it('renders the line as assistant-styled markdown inside the content slot', () => {
    renderNarration(
      <NarrationMessage
        message={buildScriptMessage('ob-line-0', 'assistant', 'Hey — I’m DorkBot.')}
        grouping={{ position: 'only' }}
        author={DORKBOT}
      />
    );

    const content = screen
      .getByTestId('message-item')
      .querySelector('[data-slot="message-content"]');
    // `msg-assistant` is the class the session's body renderer wraps a text
    // part in, and the only thing that makes a story line and a real reply
    // read identically. Dropping it is invisible in jsdom except right here.
    const styled = content?.querySelector('.msg-assistant');
    expect(styled).not.toBeNull();
    expect(styled?.textContent).toBe('Hey — I’m DorkBot.');
  });

  it('names a group start by the author line already on screen', () => {
    renderNarration(
      <NarrationMessage
        message={buildScriptMessage('ob-line-0', 'assistant', 'First line.')}
        grouping={{ position: 'first' }}
        author={DORKBOT}
      />
    );

    const row = screen.getByTestId('message-item');
    const authorLine = row.querySelector('[data-slot="message-author"]');
    expect(authorLine?.textContent).toContain('DorkBot');
    // Pointed at, never restated — the row's name IS the line a reader can see.
    expect(row.getAttribute('aria-labelledby')).toBe(authorLine?.getAttribute('id'));
    expect(row).not.toHaveAttribute('aria-label');
  });

  it('names a continuation directly, because its author line is deliberately dropped', () => {
    renderNarration(
      <NarrationMessage
        message={buildScriptMessage('ob-line-1', 'assistant', 'Second line.')}
        grouping={{ position: 'middle' }}
        author={DORKBOT}
      />
    );

    const row = screen.getByTestId('message-item');
    expect(row.querySelector('[data-slot="message-author"]')).toBeNull();
    expect(row).toHaveAttribute('aria-label', 'DorkBot');
    expect(row).not.toHaveAttribute('aria-labelledby');
  });

  it('shows no clock reading, so a story line never reads as something just typed', () => {
    renderNarration(
      <NarrationMessage
        message={buildScriptMessage('ob-line-0', 'assistant', 'A line with a timestamp on it.')}
        grouping={{ position: 'only' }}
        author={DORKBOT}
      />
    );

    // `buildScriptMessage` stamps every line with `new Date()`; the row is what
    // withholds it. A `<time>` anywhere in the row means the stamp got through.
    expect(screen.getByTestId('message-item').querySelector('time')).toBeNull();
  });
});
