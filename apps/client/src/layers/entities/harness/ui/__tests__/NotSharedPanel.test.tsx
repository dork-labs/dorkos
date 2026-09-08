/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HARNESS_STATUS_READY } from '../../__fixtures__/harness-status';
import { NotSharedPanel } from '../NotSharedPanel';
import { ProjectLevelNoticesPanel } from '../ProjectLevelNoticesPanel';

const { rows, enabled, projectLevel } = HARNESS_STATUS_READY;

describe('NotSharedPanel', () => {
  beforeEach(cleanup);

  it('draws one collapsed panel per tool that is missing something, and none for a tool that is not', () => {
    render(<NotSharedPanel rows={rows} enabled={enabled} />);

    // Codex cannot see three of the seven rows; Cursor two; Claude Code none —
    // so Claude Code gets no heading rather than an empty one.
    const panels = screen.getAllByRole('button', { name: /^Not shared with/ });
    expect(panels).toHaveLength(2);
    // The trigger's name is matched loosely because the count beside it is a
    // separate element: a real browser blockifies it inside the header's flex
    // box and the accessibility tree gains a separator, while jsdom applies no
    // CSS and joins them. The counts are asserted below, on the entries
    // themselves, where they are a fact rather than a rendering artefact.
    expect(screen.getByRole('button', { name: /^Not shared with Codex/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.getByRole('button', { name: /^Not shared with Cursor/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Claude Code/ })).not.toBeInTheDocument();
  });

  it('repeats every reason verbatim, so the tooltip is never the only copy', async () => {
    // Purpose: the honesty gate. `dorkos harness sync` prints these exact
    // strings; a paraphrase here would leave two surfaces describing one fact in
    // two voices with no way to tell which is current.
    const user = userEvent.setup();
    render(<NotSharedPanel rows={rows} enabled={enabled} />);

    await user.click(screen.getByRole('button', { name: /^Not shared with Codex/ }));

    expect(
      screen.getByText(
        'Codex has no skills directory — its instructions file is the only place to put this'
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText('it lives in .claude/skills, which only Claude Code reads')
    ).toBeInTheDocument();
    expect(screen.getByText('Codex runs no hooks')).toBeInTheDocument();
  });

  it('names each entry by its kind and its name, hooks included', async () => {
    // Purpose: the panel is wider than the Skills list on purpose (D27) — the
    // list draws skills, the panel draws everything a tool cannot see.
    const user = userEvent.setup();
    render(<NotSharedPanel rows={rows} enabled={enabled} />);

    const trigger = screen.getByRole('button', { name: /^Not shared with Codex/ });
    await user.click(trigger);

    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('skill browser-testing')).toBeInTheDocument();
    expect(screen.getByText('skill chat-self-test')).toBeInTheDocument();
    expect(screen.getByText('hook hooks')).toBeInTheDocument();
  });

  it('draws nothing at all when every tool can see everything', () => {
    const shared = rows.filter((row) => row.name === 'release');
    const { container } = render(<NotSharedPanel rows={shared} enabled={enabled} />);

    expect(container).toBeEmptyDOMElement();
  });
});

describe('ProjectLevelNoticesPanel', () => {
  beforeEach(cleanup);

  it('draws all four kinds under one heading, with each reason verbatim', async () => {
    const user = userEvent.setup();
    render(<ProjectLevelNoticesPanel entries={projectLevel} />);

    const trigger = screen.getByRole('button', { name: /^Project-level notices/ });
    await user.click(trigger);

    // Plain words, not the API's own `kind` values: a person reading their own
    // screen should not have to learn four terms of art first. The sentence
    // under each heading is still the engine's, verbatim.
    expect(
      screen.getAllByRole('listitem').map((entry) => entry.firstElementChild?.textContent)
    ).toEqual([
      'Not shared · plugin @dork-labs/relay-kit',
      'Could not read · mcp .mcp.json',
      'Will be written · skill .agents/skills',
      'Notice · manifest hookPolicy.gemini',
    ]);

    for (const entry of projectLevel) {
      expect(screen.getByText(entry.reason)).toBeInTheDocument();
    }
  });

  it('files nothing under an agent tool, so a Codex-only project is never shown a Claude Code problem', async () => {
    // Purpose: the whole reason this panel exists beside the per-tool ones.
    const user = userEvent.setup();
    const { container } = render(<ProjectLevelNoticesPanel entries={projectLevel} />);

    await user.click(screen.getByRole('button', { name: /^Project-level notices/ }));

    const text = within(container).getByRole('list').textContent ?? '';
    expect(text).not.toMatch(/Claude Code|Cursor|Gemini CLI|Copilot|OpenCode/);
  });

  it('draws nothing when the project has nothing to say', () => {
    const { container } = render(<ProjectLevelNoticesPanel entries={[]} />);

    expect(container).toBeEmptyDOMElement();
  });
});
