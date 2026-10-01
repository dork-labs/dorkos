/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReactElement } from 'react';
import { Button } from '../button.js';
import { Checkbox } from '../checkbox.js';
import { Input } from '../input.js';
import { RadioGroup, RadioGroupItem } from '../radio-group.js';
import { ScrollArea } from '../scroll-area.js';
import { Select, SelectTrigger, SelectValue } from '../select.js';
import { Slider } from '../slider.js';
import { Textarea } from '../textarea.js';

// Purpose (DOR-2609): every shared control's keyboard focus ring is the ring colour at full
// strength. At half strength it measured under the 3:1 a focus indicator needs, on both themes;
// the browser proof is apps/design-system/tests/focus-rings.spec.ts, which measures it painted.

beforeEach(() => {
  // Radix measures slider thumbs and scrollbars; jsdom has no ResizeObserver.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Each control, and how to find the element that takes focus once it is rendered. */
const controls: { name: string; ui: ReactElement; selector: string }[] = [
  { name: 'Input', ui: <Input aria-label="Name" />, selector: '[data-slot="input"]' },
  { name: 'Textarea', ui: <Textarea aria-label="Notes" />, selector: '[data-slot="textarea"]' },
  { name: 'Checkbox', ui: <Checkbox aria-label="Agree" />, selector: '[data-slot="checkbox"]' },
  {
    name: 'RadioGroupItem',
    ui: (
      <RadioGroup aria-label="Runtime">
        <RadioGroupItem value="a" aria-label="A" />
      </RadioGroup>
    ),
    selector: '[data-slot="radio-group-item"]',
  },
  {
    name: 'Slider thumb',
    ui: <Slider aria-label="Level" defaultValue={[40]} />,
    selector: '[data-slot="slider-thumb"]',
  },
  {
    name: 'ScrollArea viewport',
    ui: (
      <ScrollArea>
        <p>Content</p>
      </ScrollArea>
    ),
    selector: '[data-slot="scroll-area-viewport"]',
  },
];

function classesOf(ui: ReactElement, selector: string): string[] {
  const { container } = render(ui);
  const element = container.querySelector(selector);
  if (!element) throw new Error(`nothing matched ${selector}`);
  return element.className.split(/\s+/);
}

describe('keyboard focus rings', () => {
  it.each(controls)('$name draws the solid 3px ring on keyboard focus', ({ ui, selector }) => {
    const classes = classesOf(ui, selector);
    expect(classes).toEqual(
      expect.arrayContaining([
        'focus-visible:ring-dui-ring',
        'focus-visible:ring-[3px]',
        'focus-visible:border-dui-ring',
      ])
    );
    // No part-strength ring on focus, and no dark-theme override that could bring one back.
    expect(classes.filter((name) => /^focus-visible:ring-.*\//.test(name))).toEqual([]);
    expect(
      classes.filter((name) => /^dui-dark:(focus-visible|aria-invalid):ring-/.test(name))
    ).toEqual([]);
    // `focus:` would paint the ring on a mouse click as well; only `focus-visible:` may draw it.
    expect(classes.filter((name) => /^focus:/.test(name))).toEqual([]);
  });

  // The destructive ring is the only ring an invalid control shows with focus, so it is held to
  // the same bar. Button and Select trigger share the rule even though their widths differ.
  it.each([
    ...controls.filter(({ name }) =>
      ['Input', 'Textarea', 'Checkbox', 'RadioGroupItem'].includes(name)
    ),
    { name: 'Button', ui: <Button>Save</Button>, selector: '[data-slot="button"]' },
    {
      name: 'SelectTrigger',
      ui: (
        <Select>
          <SelectTrigger aria-label="Runtime">
            <SelectValue placeholder="Pick one" />
          </SelectTrigger>
        </Select>
      ),
      selector: '[data-slot="select-trigger"]',
    },
  ])('$name marks an invalid value with a solid destructive ring', ({ ui, selector }) => {
    const classes = classesOf(ui, selector);
    expect(classes).toEqual(
      expect.arrayContaining([
        'aria-invalid:ring-dui-destructive',
        'aria-invalid:border-dui-destructive',
      ])
    );
    expect(classes.filter((name) => /aria-invalid:ring-.*\//.test(name))).toEqual([]);
  });

  // The thumb's hover glow stays faint: at full strength a hovered thumb would look focused.
  it('keeps the slider thumb hover glow at half strength, apart from the focus ring', () => {
    const classes = classesOf(
      <Slider aria-label="Level" defaultValue={[40]} />,
      '[data-slot="slider-thumb"]'
    );
    expect(classes).toEqual(expect.arrayContaining(['hover:ring-dui-ring/50', 'hover:ring-4']));
    expect(classes).not.toContain('ring-dui-ring/50');
  });
});
