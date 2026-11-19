/**
 * A room agent is told the Agent browser works only in a direct chat (DOR-4733).
 *
 * The prompts used to say a room agent could drive it "once the person shares
 * one from a direct chat with you". A room seat is its own chat, so it never
 * holds a browser the person opened elsewhere: it got `not_opened` or
 * `shared_elsewhere` and waited for a share that could never arrive.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { _UI_TOOLS_CONTEXT } from '../context-builder.js';
import { buildCodexAgentContext } from '../../../codex/agent-context.js';

/** The prompt text with its line breaks folded, so a sentence reads whole. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ');
}

describe('the Agent browser in a room (DOR-4733)', () => {
  it('tells a Claude Code agent it works only in a direct chat, and what to say in a room', () => {
    const text = flat(_UI_TOOLS_CONTEXT);

    expect(text).toContain('It works only in a one-on-one chat');
    expect(text).toContain(
      'in a room, tell the person the Agent browser works only in a direct chat, and ask them to continue there with you.'
    );
  });

  it('tells a Codex agent the same', async () => {
    const text = await buildCodexAgentContext('', true, undefined);

    expect(text).toContain(
      'It works only in a direct chat; in a room, ask the person to continue in a direct chat with you.'
    );
  });
});
