import { expect } from 'vitest';

/** Any DorkOS fence tag, opening or closing, a later one included. */
const DORK_MARKUP = /<\/?dork-/i;

/**
 * The one check every runtime's tests share (DOR-4976): a chat's title and
 * preview, as stored and as shown, never carry DorkOS markup. A new fence tag
 * fails here the same way `<dork-kickoff>` would.
 *
 * @param session - The chat a runtime hands out, as it would reach a person.
 */
export function expectNoDorkMarkup(
  session: { title?: string; lastMessagePreview?: string } | null | undefined
): void {
  expect(session, 'the runtime handed out no chat').toBeTruthy();
  expect(session!.title ?? '').not.toMatch(DORK_MARKUP);
  expect(session!.lastMessagePreview ?? '').not.toMatch(DORK_MARKUP);
}
