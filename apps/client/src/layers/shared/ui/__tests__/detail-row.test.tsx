/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { DetailRow } from '../detail-row';

afterEach(cleanup);

/** The value cell of the only row rendered. */
function valueCell(): HTMLElement {
  const row = document.querySelector('[data-slot="detail-row"]');
  if (!row) throw new Error('no detail row rendered');
  // label, then value — the swatch, when present, comes before both.
  const spans = row.querySelectorAll(':scope > span');
  return spans[spans.length - 1] as HTMLElement;
}

describe('DetailRow', () => {
  it('shows the label and the value', () => {
    render(<DetailRow label="Runtime">Claude Code</DetailRow>);
    expect(screen.getByText('Runtime')).toBeInTheDocument();
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
  });

  // The default is the readout shape: values line up on the right and a long
  // one truncates rather than pushing the row wider than its panel.
  it('right-aligns and truncates by default', () => {
    render(<DetailRow label="Turn">streaming</DetailRow>);
    const value = valueCell();
    expect(value).toHaveClass('text-right');
    expect(value).toHaveClass('truncate');
  });

  it('gives the label a fixed column when the values are sentences', () => {
    render(
      <DetailRow label="Source" align="start">
        Comes with the flow plugin
      </DetailRow>
    );
    expect(screen.getByText('Source')).toHaveClass('w-20');
    expect(valueCell()).not.toHaveClass('text-right');
  });

  // Long unbroken strings — paths, ids, branch names — must break inside the
  // row rather than escape it (charter, overflow containment).
  it('breaks a long value instead of truncating it when asked', () => {
    render(
      <DetailRow label="Directory" wrap>
        /Users/someone/very/long/path
      </DetailRow>
    );
    const value = valueCell();
    expect(value).toHaveClass('break-words');
    expect(value).not.toHaveClass('truncate');
  });

  it('names the copy button after the row it copies', () => {
    render(
      <DetailRow label="Session ID" copyValue="abc-123">
        abc-123
      </DetailRow>
    );
    expect(screen.getByRole('button', { name: 'Copy Session ID' })).toBeInTheDocument();
  });

  it('shows no copy button without a value to copy', () => {
    render(<DetailRow label="Session ID">abc-123</DetailRow>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('draws a category swatch when given one', () => {
    const { container } = render(
      <DetailRow label="Tools" swatch="#6366f1">
        12.4k
      </DetailRow>
    );
    const swatch = container.querySelector('[aria-hidden]');
    expect(swatch).toHaveStyle({ backgroundColor: '#6366f1' });
  });
});
