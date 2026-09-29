/**
 * An icon somebody else's code supplied — an extension's tab or page icon —
 * drawn so that a bad one can never take the surface around it down.
 *
 * @module shared/ui/contributed-icon
 */
import type { ComponentType } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { Puzzle } from 'lucide-react';

/**
 * Whether React can render `raw` as a component.
 *
 * A bare `typeof raw === 'function'` is too narrow: every `lucide-react` icon is
 * a `forwardRef` result, which is an OBJECT. React renders it happily, but a
 * function-only check rejects it. So this accepts a function or a React element
 * type (identified by its `$$typeof` symbol), which still rejects the garbage
 * the guard exists for: a string, a number, a plain object.
 *
 * @param raw - A registered `icon` value, from typed or untyped code.
 */
export function isRenderableIcon(raw: unknown): raw is ComponentType<{ className?: string }> {
  if (typeof raw === 'function') return true;
  return (
    typeof raw === 'object' &&
    raw !== null &&
    typeof (raw as { $$typeof?: unknown }).$$typeof === 'symbol'
  );
}

/** Props for {@link ContributedIcon}. */
export interface ContributedIconProps {
  /** The registered icon, whatever it turned out to be. */
  icon: unknown;
  /** Sizing and colour, handed to the icon. */
  className?: string;
}

/**
 * Draw a contributed icon, or the puzzle piece when there is none, when it is
 * not something React can render (an untyped extension's `icon: 'flow'`), or
 * when it throws while drawing. Every surface that shows an extension's icon —
 * a tab, a page bar, a palette row, the phone menu — draws it through here, so
 * one bad icon costs a glyph, never the row, the bar or the app.
 *
 * @param props - The raw icon and a className.
 */
export function ContributedIcon({ icon, className }: ContributedIconProps) {
  const fallback = <Puzzle className={className} />;
  if (!isRenderableIcon(icon)) return fallback;
  const Icon = icon;
  return (
    <ErrorBoundary fallback={fallback}>
      <Icon className={className} />
    </ErrorBoundary>
  );
}
