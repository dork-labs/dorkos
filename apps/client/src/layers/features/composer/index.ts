/**
 * Composer feature — the one message box every surface composes.
 *
 * Chat, rooms, and the dashboard hero render the SAME parts; a surface differs
 * only by which parts it composes and which props it passes. There is no
 * capability config object, and there deliberately never will be: a parallel
 * declaration could disagree with what is actually on screen.
 *
 * **Composition IS the capability declaration.** A surface has attach because
 * it renders `Composer.Attachments` and passes `onAttach` / `onFilesDropped`,
 * never because a flag said so.
 *
 * `Composer.Root` is the card every surface sits in. It owns the chrome and the
 * whole of the attach plumbing — dropzone, hidden file input, and the "Drop
 * files to attach" overlay — and mounts none of it unless the caller passes
 * `onFilesDropped`. What only one surface needs arrives as a CHILD instead:
 * chat's `ScanLine` streaming edge and the `chat-input-container` class that
 * carries the notched-device safe-area inset are both chat's to pass, never
 * Root's to know about.
 *
 * `Composer.OverlayLane` is the single strip above the card where the palettes
 * and `Composer.ClearArmedHint` float. **Stacking order is child order** — the
 * lane holds no z-index logic, so hosts put palettes first and the armed-clear
 * hint last, which keeps the hint below an open palette instead of across it.
 * The lane exists rather than anchoring that hint inside the text field because
 * the alternative was measured: in-field, the hint lands squarely across the
 * bottom queue row's Send-now and Remove buttons — the one way out of a queue
 * the flush pump cannot drain. Floating above the card costs the resting
 * composer no pixels and moves nothing when it appears.
 *
 * | Capability                     | Chat | Room             | Dashboard    |
 * | ------------------------------ | ---- | ---------------- | ------------ |
 * | Attach (chip bar, drag, paste) | yes  | yes              | follows chat |
 * | Slash commands                 | yes  | reserved         | follows chat |
 * | `@` mentions                   | no   | yes              | no           |
 * | Queue-while-busy               | yes  | no (session)     | yes          |
 * | Prompt suggestions             | yes  | no (session)     | yes          |
 * | Interactive input panel        | yes  | no (session)     | yes          |
 *
 * "reserved" means the slot exists and is intentionally unwired: room slash
 * commands are deferred to a follow-up — a room has no single cwd, session, or
 * runtime, so `transport.getCommands` has nothing to key on.
 *
 * Only components and types leave this slice. `InputActionButton`,
 * `useInputKeyboard`, `useTextareaResize`, and `useDragAndPaste` stay internal:
 * keeping every hook inside the slice is what keeps the cross-feature
 * model-import rule (`.claude/rules/fsd-layers.md`) satisfied. A consumer that
 * needs one of them is a design error, not a reason to widen this barrel.
 *
 * @module features/composer
 */
import { ComposerRoot } from './ui/ComposerRoot';
import { ComposerInput } from './ui/ComposerInput';
import { ComposerOverlayLane } from './ui/ComposerOverlayLane';
import { ComposerAttachments } from './ui/ComposerAttachments';
import { ClearArmedHint } from './ui/ClearArmedHint';

/**
 * The composer's parts, and the slice's only public surface.
 *
 * Compose these; do not reach past them. Which parts a surface renders is that
 * surface's capability declaration — see this module's documentation for the
 * matrix and the doctrine behind it.
 */
export const Composer = {
  Root: ComposerRoot,
  Input: ComposerInput,
  OverlayLane: ComposerOverlayLane,
  Attachments: ComposerAttachments,
  ClearArmedHint,
};

export type { ComposerInputHandle } from './ui/ComposerInput';
export type { PendingFile } from './model/pending-file';
