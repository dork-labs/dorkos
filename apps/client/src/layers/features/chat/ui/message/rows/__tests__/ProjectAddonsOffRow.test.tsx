/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProjectAddonsOffRow, addonCounts } from '../ProjectAddonsOffRow';
import { noticePart } from '../../../../model/stream/notice-folds';

describe('ProjectAddonsOffRow (DOR-4404)', () => {
  it('says what is off and why, with no button', () => {
    render(<ProjectAddonsOffRow plugins={2} tools={0} mcpServers={1} />);
    const row = screen.getByTestId('project-addons-off-row');

    expect(row).toHaveTextContent(
      'This project’s own OpenCode add-ons are off: 2 plugins, 1 MCP server.'
    );
    expect(row).toHaveTextContent('DorkOS doesn’t run a project’s code without your yes.');
    expect(row.querySelector('button')).toBeNull();
    expect(row.querySelector('svg')).toHaveClass('text-muted-foreground', 'size-4');
    expect(row).not.toHaveClass('border');
  });

  it.each([
    [{ plugins: 1, tools: 0, mcpServers: 0 }, '1 plugin'],
    [{ plugins: 0, tools: 3, mcpServers: 0 }, '3 tools'],
    [{ plugins: 1, tools: 1, mcpServers: 2 }, '1 plugin, 1 tool, 2 MCP servers'],
  ])('names only the kinds that are off: %o', (counts, text) => {
    expect(addonCounts(counts)).toBe(text);
  });

  it('becomes a message part from the session event', () => {
    expect(
      noticePart({ type: 'project_addons_off', seq: 4, plugins: 2, tools: 0, mcpServers: 1 })
    ).toEqual({ type: 'project_addons_off', plugins: 2, tools: 0, mcpServers: 1 });
  });
});
