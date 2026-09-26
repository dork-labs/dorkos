/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createRef } from 'react';
import { UiProvider } from '../ui-provider.js';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '../dropdown-menu.js';

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
});
afterEach(cleanup);

function Menu({ onPick = () => {} }: { onPick?: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={onPick}>Open</DropdownMenuItem>
        <DropdownMenuItem disabled onSelect={onPick}>
          Disabled
        </DropdownMenuItem>
        <DropdownMenuCheckboxItem checked>Checked</DropdownMenuCheckboxItem>
        <DropdownMenuRadioGroup value="first">
          <DropdownMenuRadioItem value="first">First</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onSelect={onPick}>Nested</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

describe('DropdownMenu portable contract', () => {
  it('selects an item once, closes immediately, restores focus and reopens on the next press', async () => {
    const onPick = vi.fn();
    render(<Menu onPick={onPick} />);
    const trigger = screen.getByRole('button', { name: 'Actions' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const item = screen.getByRole('menuitem', { name: 'Open' });
    fireEvent.click(item);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse', ctrlKey: false });
    expect(screen.getByRole('menuitem', { name: 'Open' })).toBeInTheDocument();
  });

  it('keeps checked/radio/disabled semantics and keyboard submenu access', () => {
    const onPick = vi.fn();
    render(<Menu onPick={onPick} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Actions' }), { key: 'ArrowDown' });
    expect(screen.getByRole('menuitemcheckbox', { name: 'Checked' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('menuitemradio', { name: 'First' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Disabled' }));
    expect(onPick).not.toHaveBeenCalled();
    const more = screen.getByRole('menuitem', { name: 'More' });
    more.focus();
    fireEvent.keyDown(more, { key: 'ArrowRight' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Nested' }));
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('forwards checkbox and radio changes through the Radix item callbacks', () => {
    const onCheckedChange = vi.fn();
    const onValueChange = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Choices</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuCheckboxItem checked={false} onCheckedChange={onCheckedChange}>
            Toggle
          </DropdownMenuCheckboxItem>
          <DropdownMenuRadioGroup value="first" onValueChange={onValueChange}>
            <DropdownMenuRadioItem value="first">First</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="second">Second</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    const trigger = screen.getByRole('button', { name: 'Choices' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Toggle' }));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse', ctrlKey: false });
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Second' }));
    expect(onValueChange).toHaveBeenCalledWith('second');
  });

  it('routes root and submenu portals into the provider host and retains refs', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const ref = createRef<HTMLButtonElement>();
    render(
      <UiProvider portalContainer={host}>
        <DropdownMenu>
          <DropdownMenuTrigger ref={ref}>Actions</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem>Nested</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      </UiProvider>
    );
    const trigger = screen.getByRole('button', { name: 'Actions' });
    expect(ref.current).toBe(trigger);
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(host).toContainElement(screen.getByRole('menu'));
    const more = screen.getByRole('menuitem', { name: 'More' });
    more.focus();
    fireEvent.keyDown(more, { key: 'ArrowRight' });
    expect(host).toContainElement(screen.getByRole('menuitem', { name: 'Nested' }));
    host.remove();
  });

  it('keeps sibling and nested provider destinations independent', () => {
    const outer = document.createElement('div');
    const nested = document.createElement('div');
    const sibling = document.createElement('div');
    document.body.append(outer, nested, sibling);
    const openMenu = (name: string) => (
      <DropdownMenu open>
        <DropdownMenuTrigger>{name}</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>{name} item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    render(
      <>
        <UiProvider portalContainer={outer}>
          {openMenu('Outer')}
          <UiProvider portalContainer={nested}>{openMenu('Nested')}</UiProvider>
        </UiProvider>
        <UiProvider portalContainer={sibling}>{openMenu('Sibling')}</UiProvider>
      </>
    );
    expect(outer).toContainElement(screen.getByText('Outer item'));
    expect(nested).toContainElement(screen.getByText('Nested item'));
    expect(sibling).toContainElement(screen.getByText('Sibling item'));
    expect(outer).not.toContainElement(screen.getByText('Nested item'));
    outer.remove();
    nested.remove();
    sibling.remove();
  });
});
