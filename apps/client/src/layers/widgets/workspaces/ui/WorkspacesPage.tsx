import { useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { GitBranch, Pin, FolderGit2 } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { Badge } from '@/layers/shared/ui';
import {
  useWorkspaces,
  derivePorts,
  type WorkspaceWithSessions,
  type WorkspaceStatus,
} from '@/layers/entities/workspace';
import { WorkspaceActions } from '@/layers/features/workspace-management';

const STATUS_DOT: Record<WorkspaceStatus, string> = {
  ready: 'bg-emerald-500',
  provisioning: 'bg-amber-500',
  failed: 'bg-destructive',
  removing: 'bg-muted-foreground',
};

/** One workspace card: identity, status, ports, pinned/dirty, and attached sessions. */
function WorkspaceCard({ workspace }: { workspace: WorkspaceWithSessions }) {
  const navigate = useNavigate();
  const ports = derivePorts(workspace.portBase);
  const changeCount =
    (workspace.dirty?.uncommitted.length ?? 0) +
    (workspace.dirty?.untracked.length ?? 0) +
    (workspace.dirty?.unpushed ?? 0);

  return (
    <div className="bg-card rounded-xl border p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <GitBranch className="text-muted-foreground size-4 shrink-0" />
            <span className="truncate font-medium">{workspace.key}</span>
            {workspace.pinned && <Pin className="text-muted-foreground size-3.5 shrink-0" />}
          </div>
          <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="inline-flex items-center gap-1">
              <span className={cn('size-1.5 rounded-full', STATUS_DOT[workspace.status])} />
              {workspace.status}
            </span>
            <span>· {workspace.provider}</span>
            <span
              title={`DORKOS ${ports.DORKOS_PORT} · VITE ${ports.VITE_PORT} · SITE ${ports.SITE_PORT}`}
            >
              · :{ports.DORKOS_PORT}
            </span>
            {workspace.dirty &&
              (workspace.dirty.dirty ? (
                <span className="text-amber-600">· ● {changeCount} changes</span>
              ) : (
                <span>· clean</span>
              ))}
          </div>
        </div>
        <WorkspaceActions workspace={workspace} />
      </div>

      <div className="mt-3 border-t border-dashed pt-3">
        {workspace.sessions.length === 0 ? (
          <p className="text-muted-foreground text-xs">No sessions</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {workspace.sessions.map((session) => (
              <li key={session.sessionId}>
                <button
                  type="button"
                  onClick={() =>
                    navigate({
                      to: '/session',
                      // Carry the workspace cwd so the session opens in its
                      // checkout (transcript + the workspace status-bar chip).
                      search: { session: session.sessionId, dir: workspace.path },
                    })
                  }
                  className="text-foreground/80 hover:text-foreground focus-visible:ring-ring inline-flex w-full items-center gap-2 truncate rounded text-left text-xs focus-visible:ring-2 focus-visible:outline-none"
                >
                  <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                  <span className="truncate">{session.title || session.sessionId}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The /workspaces page — server-managed workspaces grouped by project (DOR-84). */
export function WorkspacesPage() {
  const { workspaces, isLoading } = useWorkspaces();

  const byProject = useMemo(() => {
    const map = new Map<string, WorkspaceWithSessions[]>();
    for (const ws of workspaces) {
      const list = map.get(ws.projectKey) ?? [];
      list.push(ws);
      map.set(ws.projectKey, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [workspaces]);

  return (
    <div className="container-default mx-auto px-4 py-6">
      <header className="mb-6">
        <h1 className="text-xl font-semibold">Workspaces</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Isolated, server-managed checkouts — one per unit of work, bound to sessions via cwd.
        </p>
      </header>

      {isLoading ? (
        <p className="text-muted-foreground text-sm">Loading workspaces…</p>
      ) : byProject.length === 0 ? (
        <div className="bg-card rounded-xl border p-10 text-center">
          <FolderGit2 className="text-muted-foreground/60 mx-auto size-8" />
          <p className="mt-3 font-medium">No workspaces yet</p>
          <p className="text-muted-foreground mt-1 text-sm">
            A workspace is provisioned the first time an agent session is bound to a unit of work.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          {byProject.map(([projectKey, items]) => (
            <section key={projectKey}>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                {projectKey}
                <Badge variant="secondary">{items.length}</Badge>
              </h2>
              <div className="flex flex-col gap-2">
                {items.map((ws) => (
                  <WorkspaceCard key={ws.id} workspace={ws} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
