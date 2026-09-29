/**
 * @vitest-environment jsdom
 *
 * The primitive used to be a bare pass-through, so 55 collapsibles across
 * Settings, Connections, onboarding and agent creation snapped open with a hard
 * layout jump (DOR-1751). jsdom cannot run the keyframes, but it can hold the
 * primitive to wearing them — which is the half that regressed.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createRef } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../collapsible.js';

afterEach(cleanup);

describe('CollapsibleContent', () => {
  // Caller focus and event hooks must survive the extracted wrappers.
  it('forwards trigger/content refs and click events', () => {
    const triggerRef = createRef<HTMLButtonElement>();
    const contentRef = createRef<HTMLDivElement>();
    const clicked = vi.fn();
    render(
      <Collapsible>
        <CollapsibleTrigger ref={triggerRef} onClick={clicked}>
          Details
        </CollapsibleTrigger>
        <CollapsibleContent ref={contentRef}>Body</CollapsibleContent>
      </Collapsible>
    );
    const trigger = screen.getByRole('button', { name: 'Details' });
    expect(triggerRef.current).toBe(trigger);
    fireEvent.click(trigger);
    expect(clicked).toHaveBeenCalledOnce();
    expect(contentRef.current).toBe(screen.getByText('Body'));
  });

  // The trigger must toggle real Radix state, not merely wear animation classes.
  it('opens and closes its content through the trigger', () => {
    render(
      <Collapsible>
        <CollapsibleTrigger>Details</CollapsibleTrigger>
        <CollapsibleContent>Body</CollapsibleContent>
      </Collapsible>
    );
    expect(screen.queryByText('Body')).toBeNull();
    fireEvent.click(screen.getByText('Details'));
    expect(screen.getByText('Body')).toBeVisible();
    fireEvent.click(screen.getByText('Details'));
    expect(screen.getByText('Details')).toHaveAttribute('data-state', 'closed');
  });

  it('animates open and closed instead of teleporting', () => {
    const { container } = render(
      <Collapsible open>
        <CollapsibleTrigger>Details</CollapsibleTrigger>
        <CollapsibleContent>Body</CollapsibleContent>
      </Collapsible>
    );

    const content = container.querySelector('[data-slot="collapsible-content"]');
    expect(content?.className).toContain('data-[state=open]:animate-collapsible-down');
    expect(content?.className).toContain('data-[state=closed]:animate-collapsible-up');
    // A state-qualified animation outranks a plain reduced-motion utility unless important.
    expect(content?.className).toContain('motion-reduce:animate-none!');
    // Without this the body is fully drawn at its final size while the box
    // around it is still growing, and the reveal reads as a flicker.
    // `overflow-clip` rather than `overflow-hidden` (DOR-1751): the app's
    // focus ring is a box-shadow, which `overflow-hidden` clips flush against
    // the content box. `overflow-clip-margin` only takes effect on
    // `overflow: clip`, so both classes travel together.
    expect(content?.className).toContain('overflow-clip');
    expect(content?.className).toContain('[overflow-clip-margin:8px]');
  });

  it('still lets a call site add its own classes', () => {
    const { container } = render(
      <Collapsible open>
        <CollapsibleTrigger>Details</CollapsibleTrigger>
        <CollapsibleContent className="mt-3 space-y-3">Body</CollapsibleContent>
      </Collapsible>
    );

    const content = container.querySelector('[data-slot="collapsible-content"]');
    expect(content?.className).toContain('mt-3');
    expect(content?.className).toContain('data-[state=open]:animate-collapsible-down');
  });
});
