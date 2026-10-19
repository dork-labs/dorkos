/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Button } from '../index.js';

afterEach(cleanup);

describe('class merging', () => {
  // The app's reaction buttons pass `text-control`, plus `text-foreground` when
  // the reaction is yours. Read as a colour, the size lost to the colour and
  // the reaction fell back to the button's own 14px.
  it("lets a consumer's text-control replace the Button's size and sit beside a colour", () => {
    const { getByRole } = render(
      <Button size="icon-xs" className="text-control text-foreground" aria-label="React" />
    );
    const tokens = getByRole('button', { name: 'React' }).className.split(/\s+/);
    expect(tokens).toContain('text-control');
    expect(tokens).toContain('text-foreground');
    expect(tokens).not.toContain('text-sm');
  });
});
