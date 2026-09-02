import { useMemo } from 'react';
import { FolderGit2, GitBranch } from 'lucide-react';
import { formatRelativeTime, shortenHomePath } from '@/layers/shared/lib';
import {
  Badge,
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
 */
function syncLabel(worktree: WorktreeScanEntry): string {
  const { ahead, behind } = worktree;
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

      <TableCell className={hasChanges ? 'text-amber-600' : 'text-muted-foreground'}>
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
  const { root, worktrees, isLoading } = useWorktreeScan();

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
      <p className="text-muted-foreground mb-6 text-sm">
        Every separate copy of your code found in your workspaces folder. Agents work in these so
        they never edit the same files at once. This page only reads them.
      </p>

      {isLoading ? (
        <p className="text-muted-foreground text-sm">Looking for your worktrees…</p>
      ) : byProject.length === 0 ? (
        <div className="bg-card rounded-xl border p-10 text-center">
          <FolderGit2 className="text-muted-foreground/60 mx-auto size-8" />
          <p className="mt-3 font-medium">No worktrees yet</p>
          <p className="text-muted-foreground mt-1 text-sm">
            A worktree is a second copy of your project, on its own branch, so one agent&rsquo;s
            edits can&rsquo;t collide with another&rsquo;s. They show up here once they exist
            {root ? ` in ${shortenHomePath(root)}` : ''}.
          </p>
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
