/**
 * The row action: one button on an adoptable skill, a confirm that names both
 * paths, and the sentence a refusal comes back with (spec `harness-sync-adopt`
 * §7, case 31).
 *
 * Rendered through the real `useHarnessAdopt`, against a mock Transport, because
 * the claim under test is about what the button DOES: the confirm names the two
 * paths before anything moves, cancelling calls nothing at all, and a refusal is
 * drawn rather than thrown. A stubbed hook would let the row and the test agree
 * with each other while the mutation did something else.
 *
 * Every sentence here is asserted as a LITERAL rather than against the function
 * that produced it — a copy change has to red something.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HarnessRow } from '@dorkos/shared/harness-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { HARNESS_STATUS_READY } from '../../__fixtures__/harness-status';
import { SkillHarnessRow } from '../SkillHarnessRow';

/** The project every case here is about. */
const PROJECT = '/Users/kai/code/dorkos';

/** The adoptable row the fixture carries — a skill only Claude Code can see. */
const ADOPTABLE = HARNESS_STATUS_READY.rows.find((row) => row.adoptable) as HarnessRow;

/** A row every enabled tool already has, which must offer nothing. */
const SHARED = HARNESS_STATUS_READY.rows.find((row) => !row.adoptable) as HarnessRow;

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

/** Draw one row, with the tools this project has turned on. */
function renderRow(
  row: HarnessRow,
  enabled: readonly ('claude-code' | 'codex' | 'cursor')[],
  adoptHarness = vi.fn()
) {
  const transport = createMockTransport({ adoptHarness });
  render(<SkillHarnessRow row={row} enabled={enabled} projectPath={PROJECT} showEveryHarness />, {
    wrapper: createWrapper(transport),
  });
  return { adoptHarness };
}

describe('SkillHarnessRow — Share with every agent', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('SRC-07: offers the button on an adoptable row and on no other', () => {
    // Seeded defect: draw the button unconditionally. Every healthy row then
    // offers to move a file that is already where every agent reads it.
    renderRow(ADOPTABLE, ['claude-code', 'codex', 'cursor']);
    expect(screen.getByRole('button', { name: 'Share with every agent' })).toBeInTheDocument();

    cleanup();
    renderRow(SHARED, ['claude-code', 'codex', 'cursor']);
    expect(screen.queryByRole('button', { name: 'Share with every agent' })).toBeNull();
  });

  it('SRC-07: S14 — the confirm names both paths and the link Claude Code keeps', async () => {
    // Seeded defect: paraphrase the sentence, or name only the target. A person
    // then presses a button that moves a file without having been told which
    // file, or is promised a link that is not planned.
    renderRow(ADOPTABLE, ['claude-code', 'codex', 'cursor']);

    await userEvent.click(screen.getByRole('button', { name: 'Share with every agent' }));

    expect(
      await screen.findByText(`Move ${ADOPTABLE.name} so every agent can read it?`)
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        `It moves from ${ADOPTABLE.source} to .agents/skills/${ADOPTABLE.name}, and DorkOS leaves a link behind so Claude Code still finds it.`
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move it' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('SRC-07: S14b — a project that does not run Claude Code is promised no link', async () => {
    // Seeded defect: key the variant off the source FOLDER rather than off the
    // reader. This project has no Claude Code, so the link is not planned, and
    // promising one sends a person hunting for a path nothing wrote
    // (Deviation 17).
    renderRow(ADOPTABLE, ['codex', 'cursor']);

    await userEvent.click(screen.getByRole('button', { name: 'Share with every agent' }));

    expect(
      await screen.findByText(
        `It moves from ${ADOPTABLE.source} to .agents/skills/${ADOPTABLE.name}, where every agent reads it.`
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/leaves a link behind/)).toBeNull();
  });

  it('SRC-07: cancelling moves nothing — the mutation is never called', async () => {
    // Seeded defect: wire the button straight to the mutation and open the
    // dialog beside it. The file moves and the confirm is decoration. Asserted
    // on the CALL rather than on the dialog closing, because a closed dialog is
    // not the same fact as a file that stayed put.
    const { adoptHarness } = renderRow(ADOPTABLE, ['claude-code', 'codex', 'cursor']);

    await userEvent.click(screen.getByRole('button', { name: 'Share with every agent' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByText(/so every agent can read it\?$/)).toBeNull());
    expect(adoptHarness).not.toHaveBeenCalled();
  });

  it('SRC-07: confirming asks the transport for this skill, in this project', async () => {
    const adoptHarness = vi.fn().mockResolvedValue({
      moved: [
        { name: ADOPTABLE.name, from: ADOPTABLE.source, to: `.agents/skills/${ADOPTABLE.name}` },
      ],
      declared: [],
      refusals: [],
      status: HARNESS_STATUS_READY,
    });
    renderRow(ADOPTABLE, ['claude-code', 'codex', 'cursor'], adoptHarness);

    await userEvent.click(screen.getByRole('button', { name: 'Share with every agent' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Move it' }));

    await waitFor(() => expect(adoptHarness).toHaveBeenCalledWith(PROJECT, ADOPTABLE.name));
  });

  it('SK-16: announces the outcome — the line that changes is a polite live region', async () => {
    // The button changes a sentence somewhere else on the row and nothing else
    // moves, so a screen reader is told nothing at all unless that line is a
    // live region. Seeded defect: drop the `aria-live` and the only feedback a
    // person who cannot see the row gets is silence. `polite` rather than
    // `assertive`: this is the answer to something they asked for, not an alarm.
    renderRow(ADOPTABLE, ['claude-code', 'codex', 'cursor']);

    const advice = screen.getByText(
      'Lives in .claude/skills. Move it to .agents/skills so every agent can read it.'
    );
    expect(advice).toHaveAttribute('aria-live', 'polite');
    expect(advice).toHaveAttribute('role', 'status');
  });

  it('SK-16: falls back to the advice when a refusal arrives with no sentence in it', async () => {
    // A refusal with an empty `reason` is a bug somewhere upstream, and the row
    // must not answer it with a blank line where its advice used to be — an
    // empty paragraph reads as "this row has nothing to say about a skill only
    // one of your tools can see". Seeded defect: branch on `refusal ===
    // undefined` instead of on the sentence and the row goes silent.
    const adoptHarness = vi.fn().mockResolvedValue({
      moved: [],
      declared: [],
      refusals: [
        { name: ADOPTABLE.name, source: ADOPTABLE.source, reason: '', rule: 'not-adoptable' },
      ],
      status: HARNESS_STATUS_READY,
    });
    renderRow(ADOPTABLE, ['claude-code', 'codex', 'cursor'], adoptHarness);

    await userEvent.click(screen.getByRole('button', { name: 'Share with every agent' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Move it' }));

    await waitFor(() => expect(adoptHarness).toHaveBeenCalled());
    expect(
      screen.getByText(
        'Lives in .claude/skills. Move it to .agents/skills so every agent can read it.'
      )
    ).toBeInTheDocument();
  });

  it('SK-16: draws the refusal where the advice line was, and keeps the button', async () => {
    // A refusal is an answer with its own way out, so the row prints the
    // sentence the engine wrote instead of the advice it no longer describes.
    // Seeded defect: treat a `200` carrying refusals as a success and the row
    // says nothing at all about why the file did not move.
    const reason =
      '"chat-self-test" uses hooks in its settings, which only Claude Code understands, so ' +
      'moving it would hand it to agents that can’t run it properly.';
    const adoptHarness = vi.fn().mockResolvedValue({
      moved: [],
      declared: [],
      refusals: [
        { name: ADOPTABLE.name, source: ADOPTABLE.source, reason, rule: 'not-on-allowlist' },
      ],
      status: HARNESS_STATUS_READY,
    });
    renderRow(ADOPTABLE, ['claude-code', 'codex', 'cursor'], adoptHarness);

    await userEvent.click(screen.getByRole('button', { name: 'Share with every agent' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Move it' }));

    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(
      screen.queryByText(
        `Lives in .claude/skills. Move it to .agents/skills so every agent can read it.`
      )
    ).toBeNull();
  });
});
