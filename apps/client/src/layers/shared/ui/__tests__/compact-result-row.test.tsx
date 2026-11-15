// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { CompactResultRow } from '../compact-result-row';

afterEach(() => {
  cleanup();
});

describe('CompactResultRow', () => {
  it('renders trailing content when provided', () => {
    render(
      <CompactResultRow
        icon={<span>V</span>}
        label={<span>Tool</span>}
        trailing={<span>Badge</span>}
      />
    );
    expect(screen.getByText('Badge')).toBeDefined();
  });

  it('passes data attributes through', () => {
    render(
      <CompactResultRow
        icon={<span>V</span>}
        label={<span>Tool</span>}
        data-testid="result-row"
        data-decision="approved"
      />
    );
    const row = screen.getByTestId('result-row');
    expect(row.getAttribute('data-decision')).toBe('approved');
  });

  it('does not render trailing when not provided', () => {
    const { container } = render(
      <CompactResultRow icon={<span>V</span>} label={<span>Tool</span>} />
    );
    const flexRow = container.querySelector('.flex.items-center.gap-2');
    // Should have exactly 2 children: icon and label
    expect(flexRow?.children.length).toBe(2);
  });
});
