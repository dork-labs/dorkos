/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createRef } from 'react';
import { Textarea } from '../textarea.js';
import { Checkbox } from '../checkbox.js';
import { Field, FieldDescription, FieldError, FieldLabel } from '../field.js';
import { Input } from '../input.js';
import { RadioGroup, RadioGroupItem } from '../radio-group.js';
import { Select, SelectTrigger, SelectValue } from '../select.js';

afterEach(cleanup);

describe('portable form controls', () => {
  // A labeled checkbox remains a real form control after the ownership move.
  it('toggles through its label, forwards its ref and change event, and keeps responsive sizing', () => {
    const changed = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    render(
      <>
        <Checkbox id="agree" name="agree" ref={ref} onCheckedChange={changed} />
        <label htmlFor="agree">Agree</label>
      </>
    );
    const box = screen.getByRole('checkbox');
    expect(ref.current).toBe(box);
    expect(box).toHaveClass('size-5', 'md:size-4');
    fireEvent.click(screen.getByText('Agree'));
    expect(box).toHaveAttribute('data-state', 'checked');
    expect(changed).toHaveBeenCalledWith(true);
  });

  // Disabled controls must neither change their value nor call the consumer.
  it('keeps a disabled checkbox inert', () => {
    const changed = vi.fn();
    render(<Checkbox aria-label="Locked" disabled onCheckedChange={changed} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('checkbox')).toHaveAttribute('data-state', 'unchecked');
    expect(changed).not.toHaveBeenCalled();
  });

  // Radio labels and Radix roving values are observable form behavior, not styling.
  it('selects a radio item by label and reports its value', () => {
    const changed = vi.fn();
    render(
      <RadioGroup name="choice" onValueChange={changed}>
        <RadioGroupItem id="first" value="first" />
        <label htmlFor="first">First</label>
        <RadioGroupItem id="second" value="second" />
        <label htmlFor="second">Second</label>
      </RadioGroup>
    );
    fireEvent.click(screen.getByText('Second'));
    expect(screen.getByRole('radio', { name: 'Second' })).toHaveAttribute('data-state', 'checked');
    expect(changed).toHaveBeenCalledWith('second');
  });

  // The native textarea must report live edits; a disabled-only fixture cannot prove this.
  it('forwards enabled textarea changes, ref and caller classes', () => {
    const changed = vi.fn();
    const ref = createRef<HTMLTextAreaElement>();
    render(<Textarea aria-label="Notes" ref={ref} className="custom" onChange={changed} />);
    const input = screen.getByRole('textbox');
    expect(ref.current).toBe(input);
    expect(input).toHaveAttribute('data-slot', 'textarea');
    expect(input).toHaveClass('custom', 'border-dui-control-edge');
    fireEvent.change(input, { target: { value: 'New note' } });
    expect(input).toHaveValue('New note');
    expect(changed).toHaveBeenCalledOnce();
  });

  it('keeps a disabled textarea inert', () => {
    const changed = vi.fn();
    render(<Textarea aria-label="Locked notes" disabled onChange={changed} />);
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(changed).not.toHaveBeenCalled();
  });

  // A disabled radio still forwards its ref but cannot change group value.
  it('keeps a disabled radio item inert and forwards its ref', () => {
    const changed = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    render(
      <RadioGroup defaultValue="first" onValueChange={changed}>
        <RadioGroupItem id="enabled" value="first" />
        <label htmlFor="enabled">First</label>
        <RadioGroupItem id="locked" value="locked" disabled ref={ref} />
        <label htmlFor="locked">Locked</label>
      </RadioGroup>
    );
    const locked = screen.getByRole('radio', { name: 'Locked' });
    expect(ref.current).toBe(locked);
    expect(locked).toBeDisabled();
    fireEvent.click(screen.getByText('Locked'));
    expect(locked).toHaveAttribute('data-state', 'unchecked');
    expect(screen.getByRole('radio', { name: 'First' })).toHaveAttribute('data-state', 'checked');
    expect(changed).not.toHaveBeenCalled();
  });

  // A small box still has to be hittable: 24 on a desktop, 44 on a phone.
  it('grows the hit area of a checkbox and a radio past the box they draw', () => {
    render(
      <>
        <Checkbox aria-label="Agree" />
        <RadioGroup aria-label="Runtime">
          <RadioGroupItem value="a" aria-label="A" />
        </RadioGroup>
      </>
    );
    for (const control of [screen.getByRole('checkbox'), screen.getByRole('radio')]) {
      expect(control).toHaveClass('relative', 'after:-inset-3', 'md:after:-inset-1');
    }
  });

  // Opacity would fade the value too; a disabled field stays readable.
  it('disables text fields with a muted fill rather than opacity', () => {
    render(
      <>
        <Input aria-label="Name" disabled />
        <Textarea aria-label="Notes" disabled />
      </>
    );
    for (const field of screen.getAllByRole('textbox')) {
      expect(field).toHaveClass('disabled:bg-dui-muted', 'disabled:text-dui-muted-foreground');
      expect(field.className).not.toMatch(/disabled:opacity|disabled:pointer-events-none/);
    }
  });

  // A caller's size has to replace the field's, not sit beside it in whichever order CSS picks.
  it('lets a caller override the field text size', () => {
    render(<Input aria-label="Name" className="text-xs" />);
    const input = screen.getByRole('textbox');
    expect(input).toHaveClass('text-xs');
    expect(input).not.toHaveClass('text-field');
  });

  it('sizes a compact select trigger at 32, 40 on a phone, with its hit area grown', () => {
    render(
      <Select>
        <SelectTrigger aria-label="Runtime" density="compact">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
      </Select>
    );
    expect(screen.getByRole('combobox')).toHaveClass(
      'h-10',
      'md:h-8',
      'after:-inset-y-0.5',
      'md:after:hidden'
    );
  });
});

describe('field layout', () => {
  it('shows an icon and a message for an error, and hides the help beside it', () => {
    const { container } = render(
      <Field>
        <FieldLabel htmlFor="site">Website</FieldLabel>
        <Input id="site" aria-invalid aria-describedby="site-error" />
        <FieldDescription>Shown on your profile.</FieldDescription>
        <FieldError id="site-error">Enter a full URL.</FieldError>
      </Field>
    );
    const error = screen.getByRole('alert');
    expect(error).toHaveAttribute('id', 'site-error');
    expect(error).toHaveTextContent('Enter a full URL.');
    expect(error.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(error).toHaveClass('text-dui-destructive-text');
    expect(container.querySelector('[data-slot="field"]')?.className).toContain(
      '[&:has([data-slot=field-error])_[data-slot=field-description]]:hidden'
    );
  });

  // A failed field used to turn red label and all, which reads as the label being wrong.
  it('keeps the label its own colour when the field is invalid', () => {
    const { container } = render(<Field data-invalid />);
    expect(container.querySelector('[data-slot="field"]')?.className).not.toContain(
      'text-dui-destructive'
    );
  });

  it('renders no error at all when there is none', () => {
    render(<FieldError errors={[]} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
