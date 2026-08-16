/**
 * What the agent will actually read — the whole point of writing these files
 * (spec `profile-unification` §0, "every capability survives").
 *
 * Instructions and Boundaries are two halves of one thing the agent sees as a
 * single block, and neither editor can show you the other half. This is where
 * the two meet: the identity the server prepends, SOUL.md with its trait block
 * regenerated from the personality you have picked, and NOPE.md — assembled the
 * same way and in the same order `services/runtimes/shared/agent-context.ts`
 * assembles them for a real turn.
 *
 * **It previews the DRAFT, not the file on disk.** A preview that only moved
 * once you saved would answer the question after you no longer had it.
 *
 * Two blocks the server adds are deliberately absent: its DorkOS-knowledge block
 * and the legacy `persona` fallback. Neither is anything an operator writes here,
 * and a preview padded with boilerplate is a preview nobody opens twice.
 *
 * @module features/profile/ui/InjectionPreview
 */
import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Conventions, Traits } from '@dorkos/shared/mesh-schemas';
import { TRAIT_SECTION_START, extractCustomProse } from '@dorkos/shared/convention-files';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { soulFile } from '../lib/soul-file';

/** The agent facts the preview reads, which is every field the server's block carries. */
export interface InjectionPreviewProps {
  /** What the agent is called — also the word in the disclosure's label. */
  name: string;
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
}

/**
 * Assemble the blocks a turn would receive.
 *
 * Exported for the test that pins it against the server's own assembly: the two
 * live in different packages and the only thing keeping them honest is that
 * somebody checks.
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
        Preview what {props.name} will see
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
