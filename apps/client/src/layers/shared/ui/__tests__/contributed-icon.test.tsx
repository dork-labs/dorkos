/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { forwardRef } from 'react';
import { ContributedIcon, isRenderableIcon } from '../contributed-icon';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const Good = ({ className }: { className?: string }) => (
  <svg data-testid="good" className={className} />
);

describe('ContributedIcon', () => {
  it('draws an icon React can render, function or forwardRef object', () => {
    const Ref = forwardRef<SVGSVGElement, { className?: string }>((props, ref) => (
      <svg ref={ref} data-testid="ref" {...props} />
    ));
    const { getByTestId } = render(
      <>
        <ContributedIcon icon={Good} className="size-4" />
        <ContributedIcon icon={Ref} />
      </>
    );
    expect(getByTestId('good').getAttribute('class')).toBe('size-4');
    expect(getByTestId('ref')).toBeTruthy();
    expect(isRenderableIcon(Ref)).toBe(true);
  });

  it.each([
    ['a string', 'flow'],
    ['a plain object', { name: 'flow' }],
    ['a number', 3],
    ['nothing', undefined],
  ])('falls back to the puzzle piece for %s', (_label, icon) => {
    const { container } = render(<ContributedIcon icon={icon} className="size-4" />);
    expect(container.querySelector('svg.lucide-puzzle')).not.toBeNull();
  });

  it('falls back when the icon throws while drawing, and keeps its surroundings', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Broken = () => {
      throw new Error('boom');
    };
    const { container, getByText } = render(
      <div>
        <ContributedIcon icon={Broken} />
        <span>still here</span>
      </div>
    );
    expect(container.querySelector('svg.lucide-puzzle')).not.toBeNull();
    expect(getByText('still here')).toBeTruthy();
  });
});
