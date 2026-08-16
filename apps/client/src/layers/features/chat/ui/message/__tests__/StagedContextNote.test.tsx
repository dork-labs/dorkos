// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { StagedContextNote } from '../StagedContextNote';

afterEach(() => cleanup());

describe('StagedContextNote — a quiet transcript entry, not a turn', () => {
  it('shows what was added, under a plain "added context" label', () => {
    render(<StagedContextNote content="keep the public API stable" />);
    expect(screen.getByText('Added context for the next reply')).toBeTruthy();
    expect(screen.getByText('keep the public API stable')).toBeTruthy();
  });

  it('renders as the staged-note row, not a message bubble', () => {
    render(<StagedContextNote content="anything" />);
    // Its own test id, so a reviewer (and the DOM) can tell it apart from a
    // user/assistant bubble.
    expect(screen.getByTestId('staged-context-note')).toBeTruthy();
    expect(screen.queryByTestId('message-item')).toBeNull();
  });
});
