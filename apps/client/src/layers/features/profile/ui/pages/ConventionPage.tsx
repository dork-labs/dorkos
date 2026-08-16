/**
 * Instructions (SOUL.md) and Boundaries (NOPE.md) — the two files an operator
 * writes an agent's behaviour into (spec `profile-unification` §1.5).
 *
 * One component, two pages, because they differ only in which file they are
 * about. Both take the whole height and both save on a button rather than on a
 * timer: these are the files a person writes prose into, and prose is edited in
 * passes — a debounce that fires mid-thought writes half a sentence to disk and
 * gives no moment where you can see that your work is safe.
 *
 * @module features/profile/ui/pages/ConventionPage
 */
import { useState } from 'react';
import { toast } from 'sonner';
import type { Conventions } from '@dorkos/shared/mesh-schemas';
import {
  NOPE_MAX_CHARS,
  SOUL_MAX_CHARS,
  buildSoulContent,
  extractCustomProse,
} from '@dorkos/shared/convention-files';
import { DEFAULT_TRAITS, renderTraits } from '@dorkos/shared/trait-renderer';
import { Button, Skeleton } from '@/layers/shared/ui';
import { ConventionFileEditor } from '@/layers/features/agent-settings';
import { useProfileAgent, type ProfileAgentManifest } from '../../model/use-profile-agent';
import type { ProfilePageContentProps } from './types';

/** Advisory that has to stay wherever NOPE.md is edited: these are instructions, not walls. */
const NOPE_DISCLAIMER =
  'These boundaries guide agent behavior but are not enforced at the tool level. They serve as strong instructions, not hard blocks.';

/** Which file a page is about, and everything that differs because of it. */
interface ConventionFile {
  /** The card's heading. */
  title: string;
  /** Which injection toggle it owns. */
  key: 'soul' | 'nope';
  /** The character budget the server enforces. */
  maxChars: number;
  /** The advisory under the heading, when the file needs one. */
  disclaimer?: string;
  /** What the operator actually edits, out of what is on disk. */
  read: (agent: ProfileAgentManifest) => string;
  /** What to write back, given what they typed. */
  write: (
    agent: ProfileAgentManifest,
    draft: string
  ) => { soulContent?: string; nopeContent?: string };
  /** What the character counter should say, which is not always the draft's length. */
  count: (agent: ProfileAgentManifest, draft: string) => number;
}

/**
 * SOUL.md's editable half.
 *
 * The file starts with a generated trait block; only the prose after
 * `<!-- TRAITS:END -->` is a person's to write. Editing the whole file here
 * would let a save clobber the block the personality picker owns, so the page
 * reads the prose out and writes the file back around the CURRENT traits.
 */
function soulProse(agent: ProfileAgentManifest, draft: string): string {
  const traitBlock = renderTraits({ ...DEFAULT_TRAITS, ...agent.traits });
  return buildSoulContent(traitBlock, draft);
}

const FILES: Record<'instructions' | 'boundaries', ConventionFile> = {
  instructions: {
    title: 'Custom Instructions (SOUL.md)',
    key: 'soul',
    maxChars: SOUL_MAX_CHARS,
    read: (agent) => extractCustomProse(agent.soulContent ?? ''),
    write: (agent, draft) => ({ soulContent: soulProse(agent, draft) }),
    // The budget is the whole file's, so the counter has to be too — the trait
    // block above the prose is spending it.
    count: (agent, draft) => soulProse(agent, draft).length,
  },
  boundaries: {
    title: 'Safety Boundaries (NOPE.md)',
    key: 'nope',
    maxChars: NOPE_MAX_CHARS,
    disclaimer: NOPE_DISCLAIMER,
    read: (agent) => agent.nopeContent ?? '',
    write: (_agent, draft) => ({ nopeContent: draft }),
    count: (_agent, draft) => draft.length,
  },
};

/** How long ago the last save happened, in the fewest words that stay true. */
function savedWords(at: number): string {
  const elapsed = Math.max(0, Date.now() - at);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'Saved just now';
  if (minutes < 60) return `Saved ${minutes} min ago`;
  return `Saved ${Math.floor(minutes / 60)} h ago`;
}

/** One convention file, full height, with a Save you have to mean. */
function ConventionPage({ member, file }: ProfilePageContentProps & { file: ConventionFile }) {
  const { agent, isPending, update } = useProfileAgent(member);
  const stored = agent ? file.read(agent) : '';

  const [draft, setDraft] = useState(stored);
  // What the server last told us this file says. A change here means somebody
  // else — a save of ours, or the agent itself — moved the file, and the editor
  // re-seeds from it. Adjusting state during render rather than in an effect, so
  // a fresh file never renders for one frame under the old draft.
  const [seen, setSeen] = useState(stored);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  if (seen !== stored) {
    setSeen(stored);
    setDraft(stored);
  }

  if (isPending) return <Skeleton className="h-40 w-full" />;
  if (!agent) return <p className="text-muted-foreground text-sm">Couldn’t read this file.</p>;

  const conventions: Conventions = agent.conventions ?? {
    soul: true,
    nope: true,
    dorkosKnowledge: true,
  };
  const isDirty = draft !== stored;

  function save() {
    if (!agent) return;
    update(file.write(agent, draft));
    setSavedAt(Date.now());
    toast.success('Saved');
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-slot="profile-convention">
      <ConventionFileEditor
        fill
        title={file.title}
        content={draft}
        enabled={conventions[file.key]}
        maxChars={file.maxChars}
        charCount={file.count(agent, draft)}
        disclaimer={file.disclaimer}
        onChange={setDraft}
        onToggle={(enabled) => update({ conventions: { ...conventions, [file.key]: enabled } })}
      />
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-muted-foreground text-xs">
          {isDirty ? 'Unsaved changes' : savedAt !== null ? savedWords(savedAt) : ''}
        </span>
        <Button size="sm" className="ml-auto" disabled={!isDirty} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}

/** SOUL.md — what this agent should always keep in mind. */
export function InstructionsPage(props: ProfilePageContentProps) {
  return <ConventionPage {...props} file={FILES.instructions} />;
}

/** NOPE.md — what this agent should never do. */
export function BoundariesPage(props: ProfilePageContentProps) {
  return <ConventionPage {...props} file={FILES.boundaries} />;
}
