import { useMemo } from 'react';
import { FolderGit2, GitBranch, TriangleAlert } from 'lucide-react';
import { formatRelativeTime, shortenHomePath } from '@/layers/shared/lib';
import {
  Badge,
  InlineCode,
  PageContainer,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/layers/shared/ui';
import { useWorktreeScan, type WorktreeScanEntry } from '@/layers/entities/workspace';

/** Placeholder for a fact this checkout cannot supply. */
const UNKNOWN = '—';

/** What the Changes column says: how much unsaved work sits in this copy. */
function changesLabel(worktree: WorktreeScanEntry): string {
  if (worktree.changedFiles === null) return UNKNOWN;
  if (worktree.changedFiles === 0) return 'Clean';
  return `${worktree.changedFiles} changed`;
}

/**
 * What the Sync column says. A branch with no upstream reports neither number,
 * and "in sync" would be a claim about a comparison that was never made.
 *
 * A deleted upstream gets its own words rather than the same dash: it almost
 * always means the pull request merged and the branch was cleaned up, which
 * makes it the clearest "you can let this one go" signal on the page.
 */
function syncLabel(worktree: WorktreeScanEntry): string {
  const { ahead, behind, upstreamGone } = worktree;
  if (upstreamGone) return 'Branch merged or deleted';
  if (ahead === null || behind === null) return UNKNOWN;
  if (ahead === 0 && behind === 0) return 'In sync';
  return [ahead > 0 && `${ahead} ahead`, behind > 0 && `${behind} behind`]
    .filter(Boolean)
    .join(' · ');
}

/** One scanned checkout: identity, branch, unsaved work, and how recently it moved. */
function WorktreeRow({ worktree }: { worktree: WorktreeScanEntry }) {
  const hasChanges = (worktree.changedFiles ?? 0) > 0;

  return (
    <TableRow>
      <TableCell className="max-w-0">
        <div className="truncate font-medium">{worktree.name}</div>
        <div className="text-muted-foreground truncate text-xs" title={worktree.path}>
          {shortenHomePath(worktree.path)}
        </div>
      </TableCell>

      <TableCell className="max-w-0">
        {!worktree.readable ? (
          <Badge variant="outline" title="DorkOS could not read this folder with git.">
            Can&apos;t read
          </Badge>
        ) : worktree.branch ? (
          <span className="flex items-center gap-1.5">
            <GitBranch className="text-muted-foreground size-3.5 shrink-0" />
            <span className="truncate text-xs">{worktree.branch}</span>
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">No branch</span>
        )}
      </TableCell>

      <TableCell
        className={hasChanges ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}
      >
        <span className="text-xs whitespace-nowrap">{changesLabel(worktree)}</span>
      </TableCell>

      <TableCell className="text-muted-foreground hidden md:table-cell">
        <span className="text-xs whitespace-nowrap">{syncLabel(worktree)}</span>
      </TableCell>

      <TableCell className="text-muted-foreground hidden sm:table-cell">
        <span className="text-xs whitespace-nowrap">
          {worktree.lastCommitAt ? formatRelativeTime(worktree.lastCommitAt) : UNKNOWN}
        </span>
      </TableCell>
    </TableRow>
  );
}

/** One project folder's worth of checkouts. */
function ProjectSection({
  project,
  worktrees,
}: {
  project: string;
  worktrees: WorktreeScanEntry[];
}) {
  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        {project}
        <Badge variant="secondary">{worktrees.length}</Badge>
      </h2>
      <div className="bg-card rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Folder</TableHead>
              <TableHead>Branch</TableHead>
              <TableHead>Changes</TableHead>
              <TableHead className="hidden md:table-cell">Compared to remote</TableHead>
              <TableHead className="hidden sm:table-cell">Last commit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {worktrees.map((worktree) => (
              <WorktreeRow key={worktree.path} worktree={worktree} />
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

/**
 * The /workspaces page (DOR-1056) — every copy of your code that really exists
 * on disk, read straight from the workspaces folder.
 *
 * It used to list only checkouts DorkOS had provisioned itself, and it had never
 * provisioned one, so it was always empty while dozens of real worktrees sat in
 * the very same folder. The page now reads the folder instead of the record of
 * it. Deliberately read-only: it shows what is there and changes nothing.
 */
export function WorkspacesPage() {
  const { root, worktrees, warnings, isLoading, isError } = useWorktreeScan();

  const byProject = useMemo(() => {
    const map = new Map<string, WorktreeScanEntry[]>();
    for (const worktree of worktrees) {
      const list = map.get(worktree.project) ?? [];
      list.push(worktree);
      map.set(worktree.project, list);
    }
    return [...map.entries()];
  }, [worktrees]);

  return (
    // The route panel clips its overflow, so the page needs its own scroller —
    // PageContainer owns it.
    <PageContainer width="wide">
      {/* The heading is still here, just not drawn (design decision E1). Seeing
          the page's name twice — once in the bar, once as the first line of the
          page — spent a row saying a word already on screen. But a page with no
          `h1` at all has no top of its outline, so a screen-reader user
          navigating by heading finds the page's sections hanging under nothing.
          The bar's title is a `nav` landmark, not a heading, and cannot stand in
          for one. */}
      <h1 className="sr-only">Workspaces</h1>
      {/* A gist, not an explanation. The empty state below says what a worktree
          is and why one exists; saying it twice on one screen — once here in
          the intro, once in the card underneath it — was the same idea in two
          phrasings with nothing in between (DOR-1757). */}
      <p className="text-muted-foreground mb-6 text-sm">Copies of your code, per agent.</p>

      {warnings.length > 0 && (
        <div className="mb-6 rounded-lg border border-amber-600/40 bg-amber-500/10 p-4">
          <p className="text-sm font-medium">Some folders couldn&rsquo;t be read</p>
          <p className="text-muted-foreground mt-1 text-sm">
            Anything inside them is missing from this list, so it may be incomplete. The same
            happens when a shortcut points at something that&rsquo;s gone.
          </p>
          <ul className="text-muted-foreground mt-2 space-y-0.5 text-xs">
            {warnings.map((warning) => (
              <li key={warning.path} className="truncate" title={warning.path}>
                {shortenHomePath(warning.path)} ({warning.reason})
              </li>
            ))}
          </ul>
        </div>
      )}

      {isLoading ? (
        <p className="text-muted-foreground text-sm">Looking for your worktrees…</p>
      ) : isError ? (
        // Never the empty state on failure. "No worktrees yet" would be a
        // confident claim about a folder we did not manage to read at all.
        <div className="bg-card rounded-xl border p-10 text-center">
          <TriangleAlert className="text-muted-foreground/60 mx-auto size-8" />
          <p className="mt-3 font-medium">Couldn&rsquo;t check your worktrees</p>
          <p className="text-muted-foreground mt-1 text-sm">
            The scan didn&rsquo;t finish, so this list would be wrong. This usually means the DorkOS
            server isn&rsquo;t reachable. It will try again on its own.
          </p>
        </div>
      ) : byProject.length === 0 ? (
        <div className="bg-card rounded-xl border p-10 text-center">
          <FolderGit2 className="text-muted-foreground/60 mx-auto size-8" />
          <p className="mt-3 font-medium">No worktrees yet</p>
          <p className="text-muted-foreground mt-1 text-sm">
            A worktree is a second copy of your project, on its own branch, so one agent&rsquo;s
            edits can&rsquo;t collide with another&rsquo;s. They show up here once they exist.
          </p>
          {/* The folder, on its own line and styled as code, never spliced into
              the sentence. A path has no spaces, so the browser has no wrap
              opportunity: inline in prose it ran past the card and off the phone
              screen (DOR-1747). On its own line it truncates to an ellipsis, and
              the full value is one hover or long-press away. */}
          {root && (
            <p
              className="text-muted-foreground mt-3 truncate text-xs"
              title={root}
              data-slot="workspaces-root-path"
            >
              Looking in <InlineCode>{shortenHomePath(root)}</InlineCode>
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          {byProject.map(([project, items]) => (
            <ProjectSection key={project} project={project} worktrees={items} />
          ))}
        </div>
      )}
    </PageContainer>
  );
}
