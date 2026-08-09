/**
 * Promoting a typed `@handle` into the identity pill that draws it.
 *
 * **One node, two ways in, one appearance.** A picked mention and a hand-typed
 * one go through the SAME transform: the picker writes back a new `value`
 * containing `@handle`, hydration turns that into plain text, and the transform
 * below promotes it. So `@ana` looks the same however it got there, and there is
 * no second code path to keep in step.
 *
 * **The editor never becomes the resolver.** It draws what the host already told
 * it. A handle absent from `mentionSubjects` stays plain text, and the SERVER
 * still decides who a mention addresses at write time — nothing in
 * `services/rooms/mentions.ts` changes, and the span doctrine is untouched.
 *
 * @module features/composer/ui/field/use-mention-nodes
 */
import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot, $isTextNode, TextNode } from 'lexical';
import { $createMentionNode, $isMentionNode, type MentionKind } from './lexical-nodes';

/** One handle this composer may draw as a pill. */
export interface MentionSubject {
  handle: string;
  identityColor: string | null;
  kind: MentionKind;
}

/**
 * A complete `@handle` somewhere in a run of text.
 *
 * DRIFT NOTE, resolved here rather than repeated: the spec calls this "the same
 * shape as `MENTION_TRIGGER`", and it is not. `MENTION_TRIGGER`
 * (`use-mention-autocomplete.ts`) is `/(^|\s)@([A-Za-z0-9_.-]*)$/` — a `*` and a
 * `$` anchor — because it matches a PARTIALLY typed handle at the caret, which
 * is what a picker needs. Promotion wants the opposite: a `+` for a complete
 * handle, and no anchor, so it can find one anywhere in the run.
 */
const COMPLETE_MENTION = /(^|\s)@([A-Za-z0-9_.-]+)/;

/**
 * Promote typed handles into {@link MentionNode}s.
 *
 * Registered as a node transform, so it runs after every update that touched a
 * text node and converges before the DOM is reconciled.
 *
 * @param subjects - Handles this composer may draw as pills. Omitted means no
 *   pills anywhere, which is what every surface without a roster gets.
 */
export function useMentionNodes(subjects: readonly MentionSubject[] | undefined): void {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (subjects === undefined || subjects.length === 0) return;

    const byHandle = new Map(subjects.map((subject) => [subject.handle, subject]));

    const unregister = editor.registerNodeTransform(TextNode, (node) => {
      // A mention is already a TextNode subclass; re-entering it would loop.
      if ($isMentionNode(node)) return;
      if (!$isTextNode(node) || !node.isSimpleText()) return;

      const match = COMPLETE_MENTION.exec(node.getTextContent());
      if (match === null) return;

      const subject = byHandle.get(match[2]);
      if (subject === undefined) return;

      const start = match.index + match[1].length;
      const end = start + match[2].length + 1;

      // Split the handle out of its run, then replace just that piece.
      let target = node;
      if (start > 0) target = target.splitText(start)[1];
      if (target.getTextContentSize() > end - start) target.splitText(end - start);

      target.replace($createMentionNode(subject.handle, subject.kind, subject.identityColor));
    });

    // Sweep what is already in the document. A node transform only visits DIRTY
    // nodes, and the value hook hydrates before this registration exists — so
    // without this, a restored draft full of handles would show none of them as
    // pills until the next keystroke touched each run.
    editor.update(() => {
      for (const node of $getRoot().getAllTextNodes()) node.markDirty();
    });

    return unregister;
  }, [editor, subjects]);
}
