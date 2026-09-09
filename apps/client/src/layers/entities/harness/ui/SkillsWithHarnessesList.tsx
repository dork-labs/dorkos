/**
 * Every skill in one project, and what each agent tool does with it.
 *
 * @module entities/harness/ui/SkillsWithHarnessesList
 */
import { useId, useState } from 'react';
import { Package } from 'lucide-react';
import type { HarnessStatusResponse } from '@dorkos/shared/harness-schemas';
import { useSafeNavigate } from '@/layers/shared/model';
import {
  Button,
  ExternalLinkAnchor,
  InlineCode,
  Label,
  Skeleton,
  Switch,
} from '@/layers/shared/ui';
import { harnessRowKey } from '../lib/harness-status';
import { useHarnessStatus } from '../model/use-harness-status';
import { SkillHarnessRow } from './SkillHarnessRow';

/** Where "how do I set this up" is answered in full. */
const HARNESS_DOCS_URL = 'https://dorkos.ai/docs/guides/cli-usage#agent-files';

/** What a {@link SkillsWithHarnessesList} is about. */
export interface SkillsWithHarnessesListProps {
  /** The agent's project directory — what "shared here" is scoped to. */
  projectPath: string;
  /**
   * Whether the zero-skills state draws its own "Browse skill-packs" link.
   *
   * False when the surface around this list already keeps one — the profile's
   * Skills page has it at the foot, and two links to one place on one screen is
   * one more than a person needs. Defaults to true, because a list mounted on
   * its own still has to answer "so where do I get some".
   */
  showBrowseLink?: boolean;
}

/**
 * Three placeholder rows and no spinner: the page's own shape, arriving.
 *
 * The blocks are `aria-hidden` — there is nothing in them to read — and the one
 * sentence that says what is happening is `sr-only`, so a screen reader is told
 * and the design keeps its spinner-free surface. Silence would have been the
 * alternative, and "nothing announced" is not the same fact as "three grey
 * rectangles".
 */
function LoadingRows() {
  return (
    <>
      <span role="status" className="sr-only">
        Loading skills…
      </span>
      <div aria-hidden className="flex flex-col gap-3 py-1">
        {[0, 1, 2].map((n) => (
          <div key={n} className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-48" />
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * A path in, a list out — with one chip per agent tool on every row.
 *
 * Entity UI, for the reason the skill-pack list it replaced gave: it takes a
 * project directory and draws what is in it, and no surface owns the shape of a
 * row, which is what keeps a second one from drifting. The profile's Skills page
 * composes it.
 *
 * **It owns the page's six states**, because they are answers about this one
 * read and splitting them across a page and a list would leave two places to
 * keep honest. Loading draws three placeholder rows rather than a spinner: the
 * shape of what is coming is more use than the fact that something is. Every
 * other state says what is true and what to do about it, and the states that are
 * not `ready` say it instead of drawing an empty list — an empty list would tell
 * a person they have no skills, which is the failure this whole page exists to
 * end.
 */
export function SkillsWithHarnessesList({
  projectPath,
  showBrowseLink = true,
}: SkillsWithHarnessesListProps) {
  const { data: status, isPending, error, refetch } = useHarnessStatus(projectPath);
  const [showEveryHarness, setShowEveryHarness] = useState(false);
  const toggleId = useId();
  const navigate = useSafeNavigate();

  if (isPending) return <LoadingRows />;

  if (error) {
    return (
      <div className="flex items-center gap-2 py-2">
        <p className="text-destructive text-xs">Couldn’t load skills.</p>
        <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => void refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  if (status.state !== 'ready') return <NotReady status={status} />;

  const skills = status.rows.filter((row) => row.artifact === 'skill');

  if (skills.length === 0) {
    return (
      <div className="flex flex-col items-start gap-1 py-2">
        <p className="text-muted-foreground text-xs">No skills here yet.</p>
        {showBrowseLink && navigate && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground h-6 px-1 text-xs"
            onClick={() => void navigate({ to: '/marketplace', search: { type: 'skill-pack' } })}
          >
            <Package aria-hidden className="mr-1.5 size-3.5" />
            Browse skill-packs
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 pb-1">
        <Label htmlFor={toggleId} className="text-muted-foreground text-3xs">
          Show every agent tool
        </Label>
        <Switch
          id={toggleId}
          size="sm"
          checked={showEveryHarness}
          onCheckedChange={setShowEveryHarness}
        />
      </div>
      <div className="divide-border divide-y">
        {skills.map((row) => (
          <SkillHarnessRow
            key={harnessRowKey(row)}
            row={row}
            enabled={status.enabled}
            // The path the ROUTE resolved, not the one this component was
            // handed: it is the absolute root a pasted command has to carry,
            // and the status is where it has already been through
            // `validateBoundaryOrDorkHome`.
            projectPath={status.projectPath}
            showEveryHarness={showEveryHarness}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The three states where there is nothing to list, each saying what is true and
 * what would change it.
 *
 * `not-set-up` is the one with an action, and the action is a command rather
 * than a button: `--fix` writes a committed file, so the person runs it where
 * `git diff` is one keystroke away (D24).
 */
function NotReady({ status }: { status: HarnessStatusResponse }) {
  if (status.state === 'not-set-up') {
    return (
      <div className="flex flex-col gap-1 py-2">
        <p className="text-muted-foreground text-xs">
          DorkOS isn’t sharing agent files for this folder yet.
        </p>
        <p className="text-muted-foreground text-3xs">
          Run <InlineCode>dorkos harness sync --fix</InlineCode> in this folder to set it up.
        </p>
        <ExternalLinkAnchor
          href={HARNESS_DOCS_URL}
          className="text-3xs text-muted-foreground hover:text-foreground underline underline-offset-2"
        >
          How agent file sharing works
        </ExternalLinkAnchor>
      </div>
    );
  }

  if (status.state === 'unreadable') {
    return (
      <div className="flex flex-col gap-1 py-2">
        <p className="text-muted-foreground text-xs">
          DorkOS can’t read this folder’s agent file settings.
        </p>
        {status.detail !== undefined && (
          <p className="text-muted-foreground text-3xs">{status.detail}</p>
        )}
      </div>
    );
  }

  return (
    <p className="text-muted-foreground py-2 text-xs">Agent file sharing runs in the DorkOS app.</p>
  );
}
