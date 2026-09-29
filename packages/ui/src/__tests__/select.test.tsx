/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createRef, useState } from 'react';
import { UiProvider } from '../ui-provider.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select.js';

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
});
afterEach(cleanup);

function Choice({ onValueChange }: { onValueChange?: (value: string) => void }) {
  return (
    <Select defaultValue="alpha" onValueChange={onValueChange}>
      <SelectTrigger aria-label="Choice">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="alpha">Alpha</SelectItem>
        <SelectItem value="beta">Beta</SelectItem>
        <SelectItem value="disabled" disabled>
          Disabled
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

describe('Select portable contract', () => {
  it('keeps a controlled value, refs and responsive sizing', () => {
    const ref = createRef<HTMLButtonElement>();
    const onValueChange = vi.fn();
    function Controlled() {
      const [value, setValue] = useState('alpha');
      return (
        <Select
          value={value}
          onValueChange={(next) => {
            onValueChange(next);
            setValue(next);
          }}
        >
          <SelectTrigger ref={ref} aria-label="Controlled" responsive={false}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="alpha">Alpha</SelectItem>
            <SelectItem value="beta">Beta</SelectItem>
          </SelectContent>
        </Select>
      );
    }
    render(<Controlled />);
    const trigger = screen.getByRole('combobox', { name: 'Controlled' });
    expect(ref.current).toBe(trigger);
    expect(trigger.className).toContain('h-9');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: 'Beta' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'Beta' }));
    expect(onValueChange).toHaveBeenCalledWith('beta');
    expect(trigger).toHaveTextContent('Beta');
  });

  it('selects by keyboard and does not choose a disabled item', () => {
    const onValueChange = vi.fn();
    render(<Choice onValueChange={onValueChange} />);
    const trigger = screen.getByRole('combobox', { name: 'Choice' });
    expect(trigger.className).toContain('h-11 md:h-9');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const disabled = screen.getByRole('option', { name: 'Disabled' });
    expect(disabled).toHaveAttribute('data-disabled');
    const beta = screen.getByRole('option', { name: 'Beta' });
    beta.focus();
    fireEvent.keyDown(beta, { key: 'Enter' });
    expect(onValueChange).toHaveBeenCalledWith('beta');
  });

  it('routes its implicit portal to the nearest provider and defaults to body', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const first = render(
      <UiProvider portalContainer={host}>
        <Choice />
      </UiProvider>
    );
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    expect(host).toContainElement(screen.getByRole('listbox'));
    first.unmount();
    host.remove();
    render(<Choice />);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    expect(
      screen.getByRole('listbox').closest('[data-radix-popper-content-wrapper]')?.parentElement
    ).toBe(document.body);
  });
});
