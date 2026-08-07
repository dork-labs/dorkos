import { ComposerInput } from './ui/ComposerInput';
import { ComposerAttachments } from './ui/ComposerAttachments';
import { ClearArmedHint } from './ui/ClearArmedHint';

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
 * | Capability                     | Chat | Room             | Dashboard    |
 * | ------------------------------ | ---- | ---------------- | ------------ |
 * | Attach (chip bar, drag, paste) | yes  | reserved         | follows chat |
 * | Slash commands                 | yes  | reserved         | follows chat |
 * | `@` mentions                   | no   | yes              | no           |
 * | Queue-while-busy               | yes  | no (session)     | yes          |
 * | Prompt suggestions             | yes  | no (session)     | yes          |
 * | Interactive input panel        | yes  | no (session)     | yes          |
 *
 * "reserved" means the slot exists and is intentionally unwired: room attach
 * lands in DOR-947, and room slash commands are deferred to a follow-up — a
 * room has no single cwd, session, or runtime, so `transport.getCommands` has
 * nothing to key on.
 *
 * Only components and types leave this slice. `InputActionButton`,
 * `useInputKeyboard`, `useTextareaResize`, and `useDragAndPaste` stay internal:
 * keeping every hook inside the slice is what keeps the cross-feature
 * model-import rule (`.claude/rules/fsd-layers.md`) satisfied. A consumer that
 * needs one of them is a design error, not a reason to widen this barrel.
 *
 * @module features/composer
 */
export const Composer = {
  Input: ComposerInput,
  Attachments: ComposerAttachments,
  ClearArmedHint,
};

export type { ComposerInputHandle } from './ui/ComposerInput';
export type { PendingFile } from './model/pending-file';
