// @vitest-environment jsdom
/**
 * The one chip row this app has, with two callers that must not diverge: chat's
 * model-offered follow-ups and the home surface's day-one openers.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { PromptSuggestionChips } from '../PromptSuggestionChips';

afterEach(() => {
  cleanup();
});

describe('PromptSuggestionChips', () => {
  it('draws at most four, and drops the rest rather than wrapping forever', () => {
    render(
      <PromptSuggestionChips
        suggestions={['One', 'Two', 'Three', 'Four', 'Five']}
        onChipClick={() => {}}
      />
    );

    expect(screen.getAllByRole('button')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: 'Five' })).toBeNull();
  });

  it('names itself as chat follow-ups unless told otherwise', () => {
    render(<PromptSuggestionChips suggestions={['One']} onChipClick={() => {}} />);

    expect(screen.getByRole('group', { name: 'Suggested follow-ups' })).toBeInTheDocument();
  });

  it('takes the name its surface gives it', () => {
    render(
      <PromptSuggestionChips
        suggestions={['One']}
        onChipClick={() => {}}
        ariaLabel="Ways to start"
      />
    );

    expect(screen.getByRole('group', { name: 'Ways to start' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Suggested follow-ups' })).toBeNull();
  });

  it('keeps the whole line reachable by pointer as well as by screen reader', () => {
    const long = 'Can you refactor the authentication module to use JWT tokens instead?';
    render(<PromptSuggestionChips suggestions={[long]} onChipClick={() => {}} />);

    // Truncation is visual; `title` is what a mouse user gets, and the
    // accessible name is what a screen reader gets. Both carry the full string.
    expect(screen.getByRole('button', { name: long })).toHaveAttribute('title', long);
  });

  it('is a real target at the comfortable size, and compact by default', () => {
    const { rerender } = render(
      <PromptSuggestionChips suggestions={['One']} onChipClick={() => {}} />
    );
    expect(screen.getByRole('button', { name: 'One' }).className).not.toContain('min-h-9');

    rerender(
      <PromptSuggestionChips suggestions={['One']} onChipClick={() => {}} size="comfortable" />
    );
    expect(screen.getByRole('button', { name: 'One' }).className).toContain('min-h-9');
  });

  it('hands the pressed line back, and does nothing else with it', async () => {
    const onChipClick = vi.fn();
    render(<PromptSuggestionChips suggestions={['Run the tests']} onChipClick={onChipClick} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run the tests' }));

    expect(onChipClick).toHaveBeenCalledExactlyOnceWith('Run the tests');
  });
});
