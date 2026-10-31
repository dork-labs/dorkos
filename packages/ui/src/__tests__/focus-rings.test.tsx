/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactElement } from 'react';
import { Button } from '../button.js';
import { Checkbox } from '../checkbox.js';
import { Input } from '../input.js';
import { RadioGroup, RadioGroupItem } from '../radio-group.js';
import { ScrollArea } from '../scroll-area.js';
import { Select, SelectTrigger, SelectValue } from '../select.js';
import { Slider } from '../slider.js';
import { Switch } from '../switch.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../tabs.js';
import { Textarea } from '../textarea.js';

// Purpose (DOR-2609, UI overhaul Phase 2): every shared control draws one focus ring, the
// `focus-ring` utility, so a primitive and a hand-written class cannot differ. The browser proof
// is apps/design-system/tests/focus-rings.spec.ts, which measures it painted. `Button` is left out
// until the Button spec's PR moves it: the paint is the same either way.

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
  { name: 'Switch', ui: <Switch aria-label="On" />, selector: '[data-slot="switch"]' },
  {
    name: 'Slider thumb',
    ui: <Slider aria-label="Level" defaultValue={[40]} />,
    selector: '[data-slot="slider-thumb"]',
  },
  {
    name: 'TabsTrigger',
    ui: (
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">A</TabsTrigger>
        </TabsList>
      </Tabs>
    ),
    selector: '[data-slot="tabs-trigger"]',
  },
  {
    name: 'TabsContent',
    ui: (
      <Tabs defaultValue="a">
        <TabsContent value="a">Panel</TabsContent>
      </Tabs>
    ),
    selector: '[data-slot="tabs-content"]',
  },
];

function classesOf(ui: ReactElement, selector: string): string[] {
  const { container } = render(ui);
  const element = container.querySelector(selector);
  if (!element) throw new Error(`nothing matched ${selector}`);
  return element.className.split(/\s+/);
}

/** Any class that would draw a second ring, or switch the utility's outline back off. */
function strayRingClasses(classes: string[]): string[] {
  return classes.filter((name) =>
    /^(focus-visible|focus|aria-invalid|dui-dark:focus-visible):(ring|outline|border-dui-ring)/.test(
      name
    )
  );
}

describe('keyboard focus rings', () => {
  it.each(controls)('$name draws the one focus ring and no other', ({ ui, selector }) => {
    const classes = classesOf(ui, selector);
    expect(classes).toContain('focus-ring');
    expect(strayRingClasses(classes)).toEqual([]);
    // A plain `outline-none` loses to the utility, but it says the opposite of what happens.
    expect(classes).not.toContain('outline-none');
    // `focus:` would paint on a mouse click as well; only `:focus-visible` may draw it.
    expect(classes.filter((name) => /^focus:/.test(name))).toEqual([]);
  });

  it('insets the ScrollArea viewport, whose parent clips it', () => {
    const classes = classesOf(
      <ScrollArea>
        <p>Content</p>
      </ScrollArea>,
      '[data-slot="scroll-area-viewport"]'
    );
    expect(classes).toContain('focus-ring-inset');
    expect(classes).not.toContain('focus-ring');
    expect(strayRingClasses(classes)).toEqual([]);
  });

  // The ring turns red through `aria-invalid` in the utility, so the class only owes the edge.
  it.each(
    controls.filter(({ name }) =>
      ['Input', 'Textarea', 'Checkbox', 'RadioGroupItem', 'SelectTrigger'].includes(name)
    )
  )('$name marks an invalid value with a destructive edge', ({ ui, selector }) => {
    expect(classesOf(ui, selector)).toContain('aria-invalid:border-dui-destructive');
  });

  // Button draws its ring as an outline, so an invalid one turns the outline red.
  it('Button marks an invalid value with a solid destructive outline', () => {
    const classes = classesOf(<Button>Save</Button>, '[data-slot="button"]');
    expect(classes).toContain('aria-invalid:outline-dui-destructive');
    expect(classes.filter((name) => /aria-invalid:outline-.*\//.test(name))).toEqual([]);
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

describe('the focus-ring utility', () => {
  const css = readFileSync(resolve(__dirname, '../../tailwind.css'), 'utf8');

  // An outline survives forced colours and its gap is see-through; a box-shadow does neither.
  it('is an outline 2px wide and 2px off, turning destructive when invalid', () => {
    const utility = css.slice(css.indexOf('@utility focus-ring {'));
    expect(utility).toContain('outline: 2px solid var(--focus-ring-color, hsl(var(--dui-ring)))');
    expect(utility).toContain('outline-offset: 2px');
    expect(utility).toContain("&[aria-invalid='true']");
    expect(utility).toContain('--focus-ring-color: hsl(var(--dui-destructive))');
    expect(css).not.toContain('box-shadow:');
  });
});
