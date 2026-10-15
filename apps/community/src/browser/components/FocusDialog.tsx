import { Notice } from '@dork-labs/ui';
import { useEffect, useId, useRef } from 'react';

/** Keep keyboard focus inside one destructive confirmation and restore it on close. */
export function FocusDialog({
  title,
  children,
  onClose,
  error,
}: {
  title: string;
  error?: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const root = panel.current;
    root?.querySelector<HTMLElement>('input, button, select, textarea')?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !root) return;
      const controls = Array.from(
        root.querySelectorAll<HTMLElement>('button, input, select, textarea')
      ).filter((control) => !control.hasAttribute('disabled'));
      if (controls.length === 0) return;
      const first = controls[0]!;
      const last = controls.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="admin-dialog-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={panel}
        className="admin-dialog panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h3 id={titleId}>{title}</h3>
        {error && (
          <Notice role="alert" tone="error">
            {error}
          </Notice>
        )}
        {children}
      </div>
    </div>
  );
}
