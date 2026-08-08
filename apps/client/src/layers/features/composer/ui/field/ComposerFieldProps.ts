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
import type { MentionSubject } from './use-mention-nodes';

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
  /**
   * Whether the open palette has rows to pick from.
   *
   * A rich-text field needs it to place the two list rows of the Enter table:
   * a `/` palette open inside a list item is still a palette, so Enter picks
   * the row rather than continuing the list. The plain field ignores it — the
   * ladder already reads the same fact from its own props.
   */
  paletteHasResults?: boolean;
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
  /**
   * Handles this composer may draw as identity pills, and the colours to draw
   * them in.
   *
   * Purely presentational: the SERVER still resolves who a mention addresses at
   * write time. A handle absent from this list stays plain text. Omitted by
   * surfaces with no roster — chat, the dashboard, onboarding.
   */
  mentionSubjects?: readonly MentionSubject[];
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
