/**
 * What the agent will actually read — the whole point of writing these files
 * (spec `profile-unification` §0, "every capability survives").
 *
 * Instructions, Boundaries and Memory are three parts of one thing the agent
 * sees as a single block, and no one editor can show you the others. This is
 * where they meet: the identity the server prepends, SOUL.md with its trait
 * block regenerated from the personality you have picked, NOPE.md, and the
 * agent's own MEMORY.md inside the fence a turn puts it in — assembled the same
 * way and in the same order `services/runtimes/shared/agent-context.ts`
 * assembles them for a real turn.
 *
 * **It previews the DRAFT, not the file on disk.** A preview that only moved
 * once you saved would answer the question after you no longer had it.
 *
 * Three things the server adds are deliberately absent: its DorkOS-knowledge
 * block, the `<session_model>` statement that rides every turn unchanged, and
 * the legacy `persona` fallback. None of them is anything an operator writes
 * here, and a preview padded with boilerplate is a preview nobody opens twice.
 * The memory file is the opposite case and so it is shown: it is the operator's
 * to read and edit, and it is the one block whose contents move on their own.
 *
 * @module features/profile/ui/InjectionPreview
 */
import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Conventions, Traits } from '@dorkos/shared/mesh-schemas';
import {
  MEMORY_FENCE_LABEL,
  MEMORY_FENCE_PREAMBLE,
  MEMORY_MAX_CHARS,
  MEMORY_OVERSIZE_WARNING,
  MEMORY_STALENESS_LINE,
  MEMORY_TRUST_FRAMING,
  TRAIT_SECTION_START,
  extractCustomProse,
} from '@dorkos/shared/convention-files';
import { CONTEXT_TAG } from '@dorkos/shared/additional-context';
import { AGENT_CONTEXT_BLOCK_TAGS, defuseSystemTags } from '@dorkos/shared/untrusted-text';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { soulFile } from '../lib/soul-file';

/** The agent facts the preview reads, which is every field the server's block carries. */
export interface InjectionPreviewProps {
  /**
   * The manifest's `name` — the slug fixed at creation, and the ONE the server
   * writes into `<agent_identity>` (`agent-context.ts`, `Name: ${manifest.name}`).
   *
   * Deliberately not the display name, which is what a rename actually changes
   * (`displayName`, the only one the About page can write). Showing that here
   * would put a string in the preview that no turn ever receives — on every
   * agent anyone has renamed, which is most of them.
   */
  name: string;
  /** What a person calls the agent — the word in the disclosure's own label. */
  displayName: string;
  /** The manifest ULID, which the identity block names. */
  id: string;
  /** Its description, when it has one. */
  description?: string | undefined;
  /** Its capability tags, when it has any. */
  capabilities?: readonly string[] | undefined;
  /** The personality currently picked, for regenerating SOUL.md's trait block. */
  traits: Partial<Traits> | undefined;
  /** Which files are switched on — an off file is not injected, so it is not shown. */
  conventions: Conventions;
  /** SOUL.md as it stands right now, drafts included. */
  soulContent: string;
  /** NOPE.md as it stands right now, drafts included. */
  nopeContent: string;
  /** MEMORY.md as it stands right now, drafts included. */
  memoryContent: string;
}

/**
 * What stands in for the fence's nonce here, and why it is not a number.
 *
 * The server mints a fresh random code per turn, and unpredictability is the
 * whole point of it: a note that types out a closing marker cannot end the
 * block early, because whoever wrote the note could not know the code
 * (`services/runtimes/shared/untrusted-fence.ts`). Printing a plausible-looking
 * hex string here would show a value that is never the one a turn carries, and
 * would read as though the code were fixed. A placeholder that says what it is
 * shows the same shape and claims nothing false.
 */
const PREVIEW_NONCE = '[new code each turn]';

/**
 * The tag set the server's fence defuses, composed the same way it composes
 * it. A preview that rendered the raw draft would show forged structural tags
 * the agent never sees — the one place this screen would overstate what a
 * poisoned note can do.
 */
const PREVIEW_DEFUSED_TAGS = [
  ...new Set([...Object.values(CONTEXT_TAG), ...AGENT_CONTEXT_BLOCK_TAGS, 'system-reminder']),
];

/**
 * The three DorkOS-authored lines around the memory file, verbatim from the
 * server (`agent-context.ts`).
 *
 * Copied rather than imported: they live in `apps/server`, which is not a
 * dependency of this app, so the only thing keeping the two in step is that
 * somebody checks — the same standing arrangement this whole preview already
 * runs on.
 *
 * The framing sits OUTSIDE the fence and the preamble sits inside, exactly as
 * the server places them, because that placement is the point: a fence cannot
 * mark text untrusted and grant it standing in the same breath. A preview that
 * tidied the two into one line would show an operator a safer prompt than the
 * one their agent gets.
 */
/**
 * Assemble `<agent_memory>` the way the server assembles it.
 *
 * **Including the cap, which is the half a preview is most tempted to skip.**
 * The server injects at most {@link MEMORY_MAX_CHARS} characters and adds a
 * visible warning when it had to trim; a preview that showed the whole draft
 * would tell an operator their agent reads text it will never see — and it
 * would do so precisely when they are over the limit and most need to know.
 * Both the slice and the warning come from the same constants the server uses.
 *
 * @param content - MEMORY.md as it stands, drafts included.
 */
function memoryBlock(content: string): string {
  const truncated = content.length > MEMORY_MAX_CHARS;
  const sliced = truncated ? content.slice(0, MEMORY_MAX_CHARS) : content;
  // The server defuses runtime tags in everything the fence wraps; the slice
  // happens before defusing there too, so the order here mirrors it.
  const shown = defuseSystemTags(sliced, PREVIEW_DEFUSED_TAGS);
  return [
    '<agent_memory>',
    MEMORY_TRUST_FRAMING,
    MEMORY_STALENESS_LINE,
    `--- BEGIN ${MEMORY_FENCE_LABEL} ${PREVIEW_NONCE} ---`,
    MEMORY_FENCE_PREAMBLE,
    ...(truncated ? [MEMORY_OVERSIZE_WARNING] : []),
    shown,
    `--- END ${MEMORY_FENCE_LABEL} ${PREVIEW_NONCE} ---`,
    '</agent_memory>',
  ].join('\n');
}

/**
 * Assemble the blocks a turn would receive.
 *
 * Exported so `__tests__/InjectionPreview.test.tsx` can pin it against the
 * server's own constants without rendering the component — the two surfaces
 * live in different packages, and every string they share now comes from
 * `@dorkos/shared/convention-files` so that "keeping them honest" is the
 * compiler's job rather than a reviewer's.
 *
 * @param props - The agent, its personality, and the two files as they stand.
 * @returns The blocks, joined exactly as the server joins them.
 */
export function injectedPrompt(props: InjectionPreviewProps): string {
  const identityLines = [
    `Name: ${props.name}`,
    `ID: ${props.id}`,
    props.description ? `Description: ${props.description}` : null,
    props.capabilities?.length ? `Capabilities: ${props.capabilities.join(', ')}` : null,
  ].filter((line): line is string => line !== null);

  const blocks = [`<agent_identity>\n${identityLines.join('\n')}\n</agent_identity>`];

  if (props.conventions.soul) {
    // The trait block is regenerated from the CURRENT personality, exactly as
    // `buildAgentBlock` does — and only when the markers are already there. A
    // hand-written SOUL.md with no markers is injected verbatim, and pretending
    // otherwise here would show a block the agent will never see.
    const soul = props.soulContent.includes(TRAIT_SECTION_START)
      ? soulFile(props.traits, extractCustomProse(props.soulContent))
      : props.soulContent;
    if (soul.trim()) blocks.push(`<agent_persona>\n${soul}\n</agent_persona>`);
  }

  if (props.conventions.nope && props.nopeContent.trim()) {
    blocks.push(`<agent_safety_boundaries>\n${props.nopeContent}\n</agent_safety_boundaries>`);
  }

  // After the boundaries, which is where a turn puts it — the server renders
  // `<agent_memory>` between `<agent_safety_boundaries>` and `<dorkos_context>`
  // (`agent-context.ts` `buildAgentBlock`), and position is most of what this
  // preview claims.
  //
  // An empty file draws nothing, exactly as an absent one does on the server —
  // and NOT a "no notes yet" line, in either place. A sentence like that after a
  // file the server could not read is an invitation to write over memory
  // somebody still has.
  if (props.conventions.memory && props.memoryContent.trim()) {
    blocks.push(memoryBlock(props.memoryContent));
  }

  return blocks.join('\n\n');
}

/**
 * A closed disclosure under the editor, holding the assembled prompt.
 *
 * Closed by default and shallow by design: the page's subject is the file you
 * are writing, and a preview that opens itself would push that file off screen
 * every time you arrived.
 *
 * @param props - See {@link InjectionPreviewProps}.
 */
export function InjectionPreview(props: InjectionPreviewProps) {
  const [open, setOpen] = useState(false);
  const preview = useMemo(() => injectedPrompt(props), [props]);

  return (
    <Collapsible open={open} onOpenChange={setOpen} data-slot="profile-injection-preview">
      <CollapsibleTrigger className="focus-ring text-muted-foreground hover:text-foreground flex items-center gap-1 rounded-md py-1 text-xs transition-colors">
        <ChevronRight
          aria-hidden
          className={cn('size-3.5 transition-transform', open && 'rotate-90')}
        />
        Preview what {props.displayName} will see
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre
          data-testid="injected-prompt"
          data-slot="profile-injection-preview-text"
          className="bg-muted text-muted-foreground mt-1 max-h-56 overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap"
        >
          <code>{preview}</code>
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
