/**
 * Every runtime reads the same context in the same words (DOR-3604).
 *
 * Git status, the environment, a relay message's envelope and the note that a
 * message was queued during the last turn were formatted only by the Claude
 * adapter. Codex, OpenCode and Doe fell through to a JSON dump, so a person's
 * queued message reached those agents as `{"composedDuringPrevTurn": true}`.
 * Each kind is now written once, and this test renders it through all four
 * real adapters and holds them to the Claude block, byte for byte.
 */
import { describe, it, expect } from 'vitest';
import type { AdditionalContextEntry } from '@dorkos/shared/additional-context';
import { renderContextEntry } from '../../claude-code/messaging/context-builder.js';
import { buildSteerText } from '../../codex/turn-input.js';
import { buildOpenCodeParts } from '../../opencode/messaging/turn-input.js';
import { renderDoeContextEntry } from '../../doe/context.js';

const USER_TEXT = 'is the build green?';

const ENTRIES: Record<string, AdditionalContextEntry> = {
  git_status: {
    kind: 'git_status',
    scope: 'per-turn',
    data: { isRepo: true, branch: 'feat/x', ahead: 2, clean: false, modified: 3, untracked: 1 },
  },
  env: {
    kind: 'env',
    scope: 'per-session',
    data: {
      workingDirectory: '/home/sam/project',
      product: 'DorkOS',
      version: '1.2.3',
      port: 4242,
      platform: 'linux',
      osVersion: '6.1.0',
      nodeVersion: 'v24.0.0',
      hostname: 'sams-box',
    },
  },
  relay_context: {
    kind: 'relay_context',
    scope: 'per-turn',
    data: {
      agentId: 'agent-1',
      sessionId: 'session-1',
      from: 'relay.agent.agent-2',
      messageId: 'msg-1',
      subject: 'relay.agent.agent-1',
      sent: '2026-07-28T14:01:00.000Z',
      hopsUsed: 1,
      hopsMax: 5,
      ttlSecondsRemaining: 120,
      replyTo: 'relay.agent.agent-2.reply',
    },
  },
  queue_note: {
    kind: 'queue_note',
    scope: 'per-turn',
    data: { composedDuringPrevTurn: true },
  },
};

/** Each adapter's rendering of one entry, the user's text removed. */
function renderedBy(entry: AdditionalContextEntry): Record<string, string> {
  const codex = buildSteerText(USER_TEXT, [entry]);
  const openCodeParts = buildOpenCodeParts(USER_TEXT, { additionalContext: [entry] });
  return {
    'claude-code': renderContextEntry(entry),
    codex: codex.slice(0, -`\n\n${USER_TEXT}`.length),
    opencode: openCodeParts
      .slice(0, -1)
      .map((part) => part.text)
      .join('\n\n'),
    doe: renderDoeContextEntry(entry),
  };
}

describe.each(Object.keys(ENTRIES))('%s reads the same on every runtime', (kind) => {
  const entry = ENTRIES[kind];
  const rendered = renderedBy(entry);

  it('claude-code writes prose, not JSON', () => {
    expect(rendered['claude-code']).toContain(`<${kind}>`);
    expect(rendered['claude-code']).not.toMatch(/^\s*\{/m);
    expect(rendered['claude-code']).not.toContain('":');
  });

  it.each(['codex', 'opencode', 'doe'])('%s matches claude-code', (runtime) => {
    expect(rendered[runtime]).toBe(rendered['claude-code']);
  });
});
