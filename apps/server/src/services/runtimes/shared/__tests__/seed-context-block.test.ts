/**
 * One seed, three runtimes, one block — and a person who can never see it.
 *
 * `seedContext` is background a caller attaches to a turn: the agent reads it,
 * the transcript does not show it. Two properties are what make that safe to
 * ship, and both are tested here rather than assumed.
 *
 * **It reads as prose on every runtime.** Codex and OpenCode render every other
 * context kind as a JSON dump, which turns a paragraph into one line with `\n`
 * written out in it. A seed is prose by construction — somebody wrote it for a
 * model to read — so it goes through the same shared-writer treatment
 * `room_context` gets, and this file fails if any adapter falls back to JSON.
 *
 * **It says what it is.** The block tells the reader the person cannot see it,
 * because an agent that mistakes injected background for the person's own words
 * will answer as if they said something they never said.
 */
import { describe, it, expect, vi } from 'vitest';

// The Claude context-builder pulls app-wide collaborators at module load.
vi.mock('../../../core/git-status.js', () => ({ getGitStatus: vi.fn() }));
vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn() }));
vi.mock('../../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    withTag: vi.fn().mockReturnThis(),
  },
}));
vi.mock('../../../../lib/version.js', () => ({ SERVER_VERSION: '1.2.3', IS_DEV_BUILD: false }));
vi.mock('../../../relay/relay-state.js', () => ({ isRelayEnabled: vi.fn(() => true) }));
vi.mock('../../../tasks/task-state.js', () => ({ isTasksEnabled: vi.fn(() => true) }));

import type { AdditionalContextEntry } from '@dorkos/shared/additional-context';
import { renderContextEntry } from '../../claude-code/messaging/context-builder.js';
import { buildCodexPrompt } from '../../codex/turn-input.js';
import { buildOpenCodeParts } from '../../opencode/turn-input.js';
import { formatSeedContext } from '../seed-context-block.js';

/** A seed with a paragraph break — the shape JSON rendering visibly ruins. */
const SEED_TEXT =
  'The person is looking at the Marketplace page.\n\nThey have three sources configured and none of them have synced today.';

const ENTRY: AdditionalContextEntry = {
  kind: 'seed_context',
  scope: 'per-turn',
  data: { text: SEED_TEXT },
};

const USER_TEXT = 'what should I do first?';

/** What every runtime's rendering of a seed has to carry. */
function expectSeedBlock(rendered: string): void {
  expect(rendered).toContain('<seed_context>');
  expect(rendered).toContain('</seed_context>');
  // The seed's own text, verbatim and unescaped — the JSON-dump regression
  // writes `\n` as two characters and would fail this line.
  expect(rendered).toContain(SEED_TEXT);
  expect(rendered).not.toContain('\\n');
  // The honesty line: the reader must know the person cannot see this.
  expect(rendered.toLowerCase()).toContain('cannot see');
}

describe('formatSeedContext', () => {
  it('carries the seed text verbatim', () => {
    expect(formatSeedContext({ text: SEED_TEXT })).toContain(SEED_TEXT);
  });

  it('tells the reader the block is invisible to the person', () => {
    expect(formatSeedContext({ text: 'x' }).toLowerCase()).toContain('cannot see');
  });
});

describe('every runtime renders a seed as prose', () => {
  it('claude-code', () => {
    expectSeedBlock(renderContextEntry(ENTRY));
  });

  it('codex', () => {
    const prompt = buildCodexPrompt(USER_TEXT, { additionalContext: [ENTRY] });
    expectSeedBlock(prompt);
    // The user's own words stay last and pristine.
    expect(prompt.endsWith(USER_TEXT)).toBe(true);
  });

  it('opencode', () => {
    const parts = buildOpenCodeParts(USER_TEXT, { additionalContext: [ENTRY] });
    const synthetic = parts.find((p) => p.synthetic);
    expect(synthetic).toBeDefined();
    expectSeedBlock(synthetic!.text);
    // The seed rides the SYNTHETIC part, which is what keeps it out of
    // OpenCode's rendered history; the person's words ride their own part.
    expect(parts.at(-1)).toEqual({ type: 'text', text: USER_TEXT });
  });
});
