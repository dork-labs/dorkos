'use client';

import { useCallback, useEffect, useId, useRef } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { MoreHorizontal } from 'lucide-react';
import type { NavLink } from '@/layers/features/marketing';

interface OverflowMenuProps {
  /** Where the menu can take you. */
  links: readonly NavLink[];
  /** Whether the menu is showing. Owned by the pill, which stays put while it is. */
  open: boolean;
  /** Ask the pill to open or close the menu. */
  onOpenChange: (open: boolean) => void;
}

/** Move focus to the menu item at `index`, wrapping at both ends. */
function focusItem(items: HTMLAnchorElement[], index: number): void {
  if (items.length === 0) return;
  const wrapped = ((index % items.length) + items.length) % items.length;
  items[wrapped]?.focus();
}

/**
 * The rest of the site, one button deep.
 *
 * The pill's job on this page changed: it steers the page's own sections now,
 * and five in-page stops plus five site destinations is ten things in a strip
 * of text 40px tall, which is a menu bar pretending to be a signpost. So the
 * destinations that leave the page fold behind one glyph, and the strip stays
 * a signpost.
 *
 * Everything a menu owes a keyboard is here, because a menu that is only
 * clickable is a menu half the reason for the button. Arrow keys and Home/End
 * move between items, Tab cycles inside rather than escaping (the pill behind
 * it is inert while this is open, so leaving by Tab would drop focus into a
 * page the visitor cannot see), Escape closes and hands focus back to the
 * button that opened it, and a press anywhere else closes it too. Reduced
 * motion gets the same menu without the rise.
 */
export function OverflowMenu({ links, open, onOpenChange }: OverflowMenuProps) {
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  const close = useCallback(
    (restoreFocus: boolean) => {
      onOpenChange(false);
      if (restoreFocus) buttonRef.current?.focus();
    },
    [onOpenChange]
  );

  // Opening with the keyboard has to land somewhere, and the first item is the
  // only somewhere that does not make the visitor guess.
  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLAnchorElement>('a[role="menuitem"]');
    first?.focus();
  }, [open]);

  // A press outside is a dismissal. `pointerdown` rather than `click` so the
  // menu is gone before the thing underneath reacts to the same press.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLAnchorElement>('a[role="menuitem"]') ?? []
    );
    const at = items.indexOf(document.activeElement as HTMLAnchorElement);

    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        close(true);
        break;
      case 'ArrowDown':
        event.preventDefault();
        focusItem(items, at + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusItem(items, at - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusItem(items, 0);
        break;
      case 'End':
        event.preventDefault();
        focusItem(items, items.length - 1);
        break;
      case 'Tab':
        // Trapped on purpose, which is a deliberate departure from the ARIA
        // menu-button pattern's "Tab closes and moves on". This pill floats
        // over a page that yields it out of the tab order as you scroll, so
        // the element after it is whatever the page happened to leave
        // reachable — a stop with no visible focus ring anywhere near the
        // menu you just opened. Escape is the way out, and it puts focus back
        // on the button, which is where the visitor left it.
        event.preventDefault();
        focusItem(items, at + (event.shiftKey ? -1 : 1));
        break;
      default:
        break;
    }
  };

  return (
    <div className="relative flex items-center">
      <button
        ref={buttonRef}
        type="button"
        aria-label="More of the site"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => onOpenChange(!open)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          onOpenChange(true);
        }}
        className={`hover:text-brand-orange transition-smooth flex cursor-pointer items-center justify-center ${
          open ? 'text-brand-orange' : 'text-warm-gray'
        }`}
      >
        <MoreHorizontal size={16} strokeWidth={2.5} aria-hidden="true" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label="More of the site"
            onKeyDown={onMenuKeyDown}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.96 }}
            transition={{ duration: reduced ? 0.12 : 0.18, ease: [0.4, 0, 0.2, 1] }}
            style={{ transformOrigin: 'bottom right' }}
            className="bg-cream-white border-cream-secondary absolute right-0 bottom-full mb-3 min-w-40 rounded-2xl border p-1.5 shadow-lg/10"
          >
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                role="menuitem"
                onClick={() => close(false)}
                className="text-2xs text-warm-gray hover:bg-cream-primary hover:text-charcoal focus-visible:bg-cream-primary focus-visible:text-charcoal block rounded-xl px-3 py-2 font-mono font-medium tracking-[0.04em] lowercase transition-colors focus-visible:outline-none"
              >
                {link.label}
              </Link>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
