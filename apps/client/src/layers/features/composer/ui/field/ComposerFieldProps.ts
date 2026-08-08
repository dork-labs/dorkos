/**
 * The contract every composer field satisfies — the props it takes and the
 * handle it hands back.
 *
 * This is the FIELD's surface, not the composer's. `ComposerInput` keeps its
 * whole public prop list and its own `ComposerInputHandle`; it narrows that down
 * to what the thing actually holding the caret needs, and passes only this. A
 * field knows nothing about sessions, palettes as data, queues, attachments, or
 * what happens to a submitted message — it draws text, reports edits, and hands
 * back the surface the keyboard ladder talks to.
 *
 * @module features/composer/ui/field/ComposerFieldProps
 */
import type { EditingSurface } from '../editing-surface';

/** Everything a composer field needs from the composer around it. */
export interface ComposerFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Caret position, in the same units `value` is measured in. */
  onCursorChange?: (pos: number) => void;
  /** The keyboard ladder, already built by the composer. */
  onKeyDown: (e: React.KeyboardEvent) => void;
  onFocus: () => void;
  onBlur: () => void;
  placeholder: string;
  /**
   * Rendered in place of the native placeholder while the field is empty (chat's
   * animated hints).
   *
   * Deliberately the node itself and not a `hasPlaceholderOverlay` flag beside
   * it: the field decides whether to empty the native `placeholder` attribute
   * from exactly the value it renders, so the two can never disagree. Same
   * doctrine as the slice's barrel — composition is the declaration.
   */
  placeholderOverlay?: React.ReactNode;
  isPaletteOpen?: boolean;
  /** `id` of the listbox the open palette rendered, for `aria-controls`. */
  paletteListboxId?: string;
  /** `id` of the highlighted palette row, for `aria-activedescendant`. */
  activeDescendantId?: string;
  /**
   * Hand the field's {@link EditingSurface} up to the composer, which gives it to
   * the keyboard ladder without ever learning which field rendered.
   *
   * A callback rather than an out-param on the handle because a rich-text field
   * cannot produce its surface until its editor exists, which is after first
   * paint.
   */
  onSurfaceChange: (surface: EditingSurface) => void;
}

/**
 * The three imperative moves a composer field owes its host.
 *
 * Same method names, same meanings, and the same units as
 * `ComposerInputHandle`, which forwards straight to them — that handle is a
 * published contract two hosts already call.
 */
export interface ComposerFieldHandle {
  focus: () => void;
  /** Focus unless touch is the only pointer, where it pops the software keyboard. */
  focusUnlessTouch: () => void;
  /** Focus and put a collapsed caret at `pos`, measured in `value`'s units. */
  focusAt: (pos: number) => void;
}
