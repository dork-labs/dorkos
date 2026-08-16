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
  extractCustomProse,
} from '@dorkos/shared/convention-files';
import { Button, Skeleton } from '@/layers/shared/ui';
import { ConventionFileEditor } from '@/layers/features/agent-settings';
import { soulFile } from '../../lib/soul-file';
import { useProfileLeaveGuard } from '../../model/profile-leave-guard';
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
  return soulFile(agent.traits, draft);
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

/** What the status line says, and whether Save is allowed to do anything. */
function status(over: number, overhead: number, dirty: boolean, savedAt: number | null): string {
  if (over > 0) {
    // The number a person needs is how much to cut, and — on SOUL.md — why the
    // budget is smaller than the editor looks. The prose field is the whole page;
    // the trait block spending the same budget is not on screen at all.
    const because =
      overhead > 0 ? ` — the personality block takes ${overhead.toLocaleString()} of them` : '';
    return `Too long by ${over.toLocaleString()} character${over === 1 ? '' : 's'}${because}`;
  }
  if (dirty) return 'Unsaved changes';
  return savedAt !== null ? savedWords(savedAt) : '';
}

/** One convention file, full height, with a Save you have to mean. */
function ConventionPage({ member, file }: ProfilePageContentProps & { file: ConventionFile }) {
  const { agent, isPending, isSaving, update } = useProfileAgent(member);
  const stored = agent ? file.read(agent) : '';

  const [draft, setDraft] = useState(stored);
  // The text we know is safe: what the file said when we last synced with it,
  // or what a save actually stored. `draft` differing from it is the whole
  // definition of "unsaved", and it is deliberately NOT the same thing as
  // differing from `stored`.
  const [savedText, setSavedText] = useState(stored);
  // What the server last told us this file says. A change means somebody else —
  // another window, our own optimistic write, the agent itself — moved it.
  // Adjusting state during render rather than in an effect, so a fresh file
  // never renders for one frame under the old draft.
  const [seen, setSeen] = useState(stored);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const isDirty = draft !== savedText;

  if (seen !== stored) {
    setSeen(stored);
    // Adopt the server's version only when there is nothing unsaved to lose.
    // A save that FAILS moves `stored` twice — `useUpdateAgent` writes the
    // patch into the cache optimistically and rolls it back — and following it
    // replaced what the operator had typed with the text the server had just
    // refused to change. Verified in a browser, where the round trip renders
    // in between; an immediately-rejected mutation batches both moves into one
    // render and hides it.
    if (!isDirty) {
      setDraft(stored);
      setSavedText(stored);
    }
  }

  // Registered even while the manifest is still loading: an unmounted guard is
  // the honest default, and the hook has to be called before any early return.
  useProfileLeaveGuard(isDirty);

  if (isPending) return <Skeleton className="h-40 w-full" />;
  if (!agent) return <p className="text-muted-foreground text-sm">Couldn’t read this file.</p>;

  const conventions: Conventions = agent.conventions ?? {
    soul: true,
    nope: true,
    dorkosKnowledge: true,
  };

  // What the server measures is the WHOLE file. On SOUL.md that is the trait
  // block plus the prose, and the editor only bounds the prose — so a legal-
  // looking 3,900 characters of instructions was refused, and said "Saved"
  // anyway (DOR-1253). Save is inert while the file is over, with the reason
  // beside it, rather than offering a click that cannot work.
  const count = file.count(agent, draft);
  const over = count - file.maxChars;
  const overhead = count - draft.length;

  function save() {
    if (!agent || over > 0) return;
    const attempted = draft;
    update(file.write(agent, attempted), {
      // Only on a stored save. This used to run unconditionally, next to a
      // fire-and-forget mutation, so "Saved just now" appeared over a file the
      // server had thrown away.
      onSuccess: () => {
        setSavedText(attempted);
        setSavedAt(Date.now());
        toast.success('Saved');
      },
      // The draft stays exactly as typed and stays dirty — a refusal is a
      // reason to try again, not a reason to lose the text.
      onError: (error) => toast.error(error.message),
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-slot="profile-convention">
      <ConventionFileEditor
        fill
        title={file.title}
        content={draft}
        enabled={conventions[file.key]}
        maxChars={file.maxChars}
        charCount={count}
        disclaimer={file.disclaimer}
        onChange={setDraft}
        onToggle={(enabled) => update({ conventions: { ...conventions, [file.key]: enabled } })}
      />
      <div className="flex shrink-0 items-center gap-2">
        <span
          data-slot="profile-convention-status"
          className={over > 0 ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}
        >
          {status(over, overhead, isDirty, savedAt)}
        </span>
        <Button
          size="sm"
          className="ml-auto"
          disabled={!isDirty || over > 0 || isSaving}
          onClick={save}
        >
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
