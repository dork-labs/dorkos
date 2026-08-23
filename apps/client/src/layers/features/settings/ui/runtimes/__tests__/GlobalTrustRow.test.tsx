// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { GlobalTrustRow } from '../GlobalTrustRow';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** The runtimes the tab lists, in the order it lists them. */
const RUNTIMES = [
  { runtime: 'claude-code', label: 'Claude Code', stop: null },
  { runtime: 'codex', label: 'Codex', stop: null },
  { runtime: 'opencode', label: 'OpenCode', stop: null },
] as const;

function renderRow(props: Partial<Parameters<typeof GlobalTrustRow>[0]> = {}) {
  const onChange = vi.fn();
  const onChangeRuntime = vi.fn();
  render(
    <GlobalTrustRow
      stop={null}
      effectiveStop="ask"
      runtimes={RUNTIMES}
      onChange={onChange}
      onChangeRuntime={onChangeRuntime}
      {...props}
    />
  );
  return { onChange, onChangeRuntime };
}

describe('GlobalTrustRow', () => {
  it('asks the question once, in the design’s words, and says what it governs', () => {
    renderRow();
    // Not "Where agents stop for you": DOR-853 reserves the bare word "agent"
    // for a named fleet teammate, and this row governs new conversations.
    expect(screen.getByText('Where new conversations stop for you')).toBeInTheDocument();
    expect(
      screen.getByText('Every runtime follows this unless its card says otherwise.')
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Asks before acting' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Pauses at big steps' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Full autonomy' })).toBeInTheDocument();
  });

  it('draws the stop the runtimes would actually take when nothing is stored', () => {
    // `null` is "no preference", which a three-position control cannot draw. The
    // honest thing is where a new session would land today, not an empty control.
    renderRow({ stop: null, effectiveStop: 'act' });
    expect(screen.getByRole('radio', { name: 'Pauses at big steps' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Asks before acting' })).not.toBeChecked();
  });

  it('draws the stored stop over the effective one once somebody has chosen', () => {
    renderRow({ stop: 'ask', effectiveStop: 'act' });
    expect(screen.getByRole('radio', { name: 'Asks before acting' })).toBeChecked();
  });

  it('reports the stop that was picked', async () => {
    const { onChange } = renderRow();
    await userEvent.click(screen.getByRole('radio', { name: 'Pauses at big steps' }));
    expect(onChange).toHaveBeenCalledWith('act');
  });

  it('reports Full autonomy like any other stop and confirms nothing itself', async () => {
    // Consent is the container's job — it holds the one write hook and the one
    // dialog. A row that asked too would be a second consent contract.
    const { onChange } = renderRow();
    await userEvent.click(screen.getByRole('radio', { name: 'Full autonomy' }));
    expect(onChange).toHaveBeenCalledWith('autonomy');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('stays quiet while something is still asking', () => {
    renderRow({ stop: 'act' });
    expect(screen.queryByTestId('default-trust-stop-standing-note')).not.toBeInTheDocument();
  });

  it('says out loud that new sessions run at full power, and offers the way back', async () => {
    const { onChange, onChangeRuntime } = renderRow({ stop: 'autonomy' });
    const note = screen.getByTestId('default-trust-stop-standing-note');
    expect(note).toHaveTextContent('New sessions run at full power');

    await userEvent.click(screen.getByRole('button', { name: 'change' }));
    expect(onChange).toHaveBeenCalledWith('ask');
    expect(onChangeRuntime).not.toHaveBeenCalled();
  });

  it('names the runtimes running at full power when the shared setting is not the one at autonomy', async () => {
    // Fired on the EFFECTIVE resolution: a card can sit at autonomy while this
    // row reads Asks before acting, and the server gates that write identically.
    const { onChange, onChangeRuntime } = renderRow({
      stop: 'ask',
      runtimes: [
        { runtime: 'claude-code', label: 'Claude Code', stop: null },
        { runtime: 'codex', label: 'Codex', stop: 'autonomy' },
        { runtime: 'opencode', label: 'OpenCode', stop: 'act' },
      ],
    });
    const note = screen.getByTestId('default-trust-stop-standing-note');
    expect(note).toHaveTextContent('New sessions on Codex run at full power');

    // Undo exactly what is set: the override, never the shared choice.
    await userEvent.click(screen.getByRole('button', { name: 'change' }));
    expect(onChangeRuntime).toHaveBeenCalledExactlyOnceWith('codex', null);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('names every runtime running at full power, in a sentence', () => {
    renderRow({
      stop: 'ask',
      runtimes: [
        { runtime: 'claude-code', label: 'Claude Code', stop: 'autonomy' },
        { runtime: 'codex', label: 'Codex', stop: 'autonomy' },
        { runtime: 'opencode', label: 'OpenCode', stop: 'autonomy' },
      ],
    });
    expect(screen.getByTestId('default-trust-stop-standing-note')).toHaveTextContent(
      'New sessions on Claude Code, Codex and OpenCode run at full power'
    );
  });

  it('undoes the shared choice AND every override when both are at autonomy', async () => {
    const { onChange, onChangeRuntime } = renderRow({
      stop: 'autonomy',
      runtimes: [
        { runtime: 'claude-code', label: 'Claude Code', stop: null },
        { runtime: 'codex', label: 'Codex', stop: 'autonomy' },
      ],
    });
    await userEvent.click(screen.getByRole('button', { name: 'change' }));
    expect(onChange).toHaveBeenCalledWith('ask');
    expect(onChangeRuntime).toHaveBeenCalledExactlyOnceWith('codex', null);
  });

  it('reads from the effective stop, so an unset preference that lands on autonomy still says so', () => {
    renderRow({ stop: null, effectiveStop: 'autonomy' });
    expect(screen.getByTestId('default-trust-stop-standing-note')).toHaveTextContent(
      'New sessions run at full power'
    );
  });

  it('reads green, not red — the person got what they asked for', () => {
    renderRow({ stop: 'autonomy' });
    const note = screen.getByTestId('default-trust-stop-standing-note');
    expect(note.className).toContain('text-status-success');
    expect(note.className).not.toMatch(/red/);
  });

  it('stacks the control full width until the row itself is wide enough for both halves', () => {
    // A container query, not a viewport one: the three stop words are ~400px of
    // control and Settings is a 672px dialog minus a 180px sidebar, so a
    // viewport-keyed `sm:flex-row` set them side by side on a desktop where the
    // label column was left ~40px and broke to one word per line.
    renderRow();
    const row = screen.getByTestId('global-trust-row');
    expect(row).toHaveClass('@container/trust-row');

    const layout = row.firstElementChild;
    expect(layout).toHaveClass('flex-col', '@2xl/trust-row:flex-row');
    expect(layout).not.toHaveClass('sm:flex-row');

    expect(screen.getByRole('radiogroup')).toHaveClass(
      'w-full',
      '@2xl/trust-row:w-auto',
      '@2xl/trust-row:shrink-0'
    );
  });

  it('gives the label and hint the room the control does not need', () => {
    // The control keeps its natural width beside the label (`shrink-0`), so the
    // text column has to be the flexible one — without `flex-1` it is the half
    // that absorbs every pixel of shrink and crushes to one word per line.
    renderRow();
    const [text] = screen.getByTestId('global-trust-row').firstElementChild!.children;
    expect(text).toHaveClass('min-w-0', 'flex-1');
  });
});
