/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createRef } from 'react';
import { Textarea } from '../textarea.js';
import { Checkbox } from '../checkbox.js';
import { RadioGroup, RadioGroupItem } from '../radio-group.js';

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
    expect(input).toHaveClass('custom', 'border-dui-input');
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
});
