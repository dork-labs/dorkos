/**
 * @vitest-environment jsdom
 *
 * The primitive used to be a bare pass-through, so 55 collapsibles across
 * Settings, Connections, onboarding and agent creation snapped open with a hard
 * layout jump (DOR-1751). jsdom cannot run the keyframes, but it can hold the
 * primitive to wearing them — which is the half that regressed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../collapsible';

afterEach(cleanup);

describe('CollapsibleContent', () => {
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
