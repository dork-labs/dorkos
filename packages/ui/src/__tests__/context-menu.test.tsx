/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createRef } from 'react';
import { UiProvider } from '../ui-provider.js';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuCheckboxItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
} from '../context-menu.js';

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
});
afterEach(cleanup);

function Menu({ onPick = () => {} }: { onPick?: () => void }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger>Target</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onPick}>Open</ContextMenuItem>
        <ContextMenuItem disabled onSelect={onPick}>
          Disabled
        </ContextMenuItem>
        <ContextMenuCheckboxItem checked>Checked</ContextMenuCheckboxItem>
        <ContextMenuRadioGroup value="first">
          <ContextMenuRadioItem value="first">First</ContextMenuRadioItem>
        </ContextMenuRadioGroup>
        <ContextMenuSub>
          <ContextMenuSubTrigger>More</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem onSelect={onPick}>Nested</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>
  );
}

describe('ContextMenu portable contract', () => {
  it('selects via right click, protects disabled items and opens a keyboard submenu', () => {
    const onPick = vi.fn();
    render(<Menu onPick={onPick} />);
    fireEvent.contextMenu(screen.getByText('Target'));
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

  it('uses a provider for implicit content and preserves an explicit portal container', () => {
    const provided = document.createElement('div');
    const explicit = document.createElement('div');
    document.body.append(provided, explicit);
    render(
      <UiProvider portalContainer={provided}>
        <ContextMenu>
          <ContextMenuTrigger>Target</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem>Open</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <ContextMenu>
          <ContextMenuTrigger>Explicit Target</ContextMenuTrigger>
          <ContextMenuPortal container={explicit} forceMount>
            <span data-testid="explicit">Explicit</span>
          </ContextMenuPortal>
        </ContextMenu>
        <ContextMenu>
          <ContextMenuTrigger>Body Target</ContextMenuTrigger>
          <ContextMenuPortal container={null} forceMount>
            <span data-testid="body-default">Body</span>
          </ContextMenuPortal>
        </ContextMenu>
      </UiProvider>
    );
    fireEvent.contextMenu(screen.getByText('Target'));
    expect(provided).toContainElement(screen.getByRole('menu'));
    expect(explicit).toContainElement(screen.getByTestId('explicit'));
    expect(screen.getByTestId('body-default').parentElement).toBe(document.body);
    provided.remove();
    explicit.remove();
  });

  it('retains a trigger ref, selection and close/reopen behavior', () => {
    const onPick = vi.fn();
    const ref = createRef<HTMLSpanElement>();
    render(
      <ContextMenu>
        <ContextMenuTrigger ref={ref}>Target</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={onPick}>Open</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
    const trigger = screen.getByText('Target');
    expect(ref.current).toBe(trigger);
    fireEvent.contextMenu(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open' }));
    expect(onPick).toHaveBeenCalledTimes(1);
    fireEvent.contextMenu(trigger);
    expect(screen.getByRole('menuitem', { name: 'Open' })).toBeInTheDocument();
  });
});
