import type { KeyboardEvent, ReactNode } from 'react';

/**
 * Arrow-key movement for a sheet's plain `menu`: Up and Down step through its
 * items (wrapping), Home and End jump to the ends, as the menu pattern promises.
 */
function moveWithinMenu(event: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(
      '[role^="menuitem"]:not(:disabled):not([aria-disabled="true"])'
    ),
  ];
  if (items.length === 0) return;
  event.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const last = items.length - 1;
  let next: number;
  if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = last;
  else if (event.key === 'ArrowDown') next = at < 0 || at === last ? 0 : at + 1;
  else next = at <= 0 ? last : at - 1;
  items[next]!.focus();
}

/**
 * The switcher's action rows, as a real menu on the phone sheet.
 *
 * On a phone the rows are plain buttons with `menuitem` roles, and a menu item
 * is only one inside a menu (axe `aria-required-parent`), so the sheet wraps
 * them in a `menu` and supplies the arrow keys a menu promises. The desktop
 * dropdown gets both from Radix, so there this renders its children unwrapped.
 *
 * @param sheet - Whether the rows render in the phone sheet.
 * @param children - The action rows.
 */
export function SheetActionsMenu({ sheet, children }: { sheet: boolean; children: ReactNode }) {
  if (!sheet) return <>{children}</>;
  return (
    <div role="menu" aria-label="Actions" tabIndex={-1} onKeyDown={moveWithinMenu}>
      {children}
    </div>
  );
}
