/**
 * The file explorer, over a source with no server behind it.
 *
 * The pane's whole shape is decided by its {@link FileExplorerSource} — what it
 * lists, whether it can be written to, whether it can say who last touched a
 * file — so the seam used here is the source itself. The component under review
 * is the real one, unmodified, running its real hooks and its real store; the
 * only thing replaced is where the entries come from.
 *
 * **One explorer, deliberately.** The pane's expansion, selection and scroll
 * live in a single feature store, and the app only ever mounts one at a time
 * (the right panel shows one tab). Two on this page would fight over the same
 * fields, so this page shows the room-shaped source — the one with provenance
 * and pinning to look at — and says so rather than pretending otherwise.
 *
 * @module dev/showcases/FileExplorerShowcases
 */
import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import {
  FileExplorer,
  HiddenEntriesToggle,
  type ExplorerEntry,
  type ExplorerFile,
  type FileExplorerSource,
} from '@/layers/features/file-explorer';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { createPlaygroundTransport } from '../playground-transport';

/** A commit, the way a room's files carry one. */
function commit(author: string, hoursAgo: number, subject: string) {
  return {
    sha: `${author.toLowerCase()}00${hoursAgo}`,
    author,
    at: new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString(),
    subject,
  };
}

function file(name: string, lastCommit: ExplorerEntry['lastCommit']): ExplorerEntry {
  return { name, path: name, type: 'file', size: 240, lastCommit };
}

/** What the fixture room's `main` holds, by directory. */
const ROOM_TREE: Record<string, ExplorerEntry[]> = {
  '': [
    {
      name: 'notes',
      path: 'notes',
      type: 'dir',
      size: 0,
      lastCommit: commit('Priya', 30, 'Move the research in'),
    },
    { name: '.claude', path: '.claude', type: 'dir', size: 0, lastCommit: null },
    file('README.md', commit('Dorian', 72, 'Explain the layout')),
    file('ROOM.md', commit('Kai', 2, 'Narrow the brief to one week')),
    file('decisions.md', null),
    file('logo.png', commit('Ikechi', 5, 'Add the mark')),
    {
      name: 'shared-tree',
      path: 'shared-tree',
      type: 'file',
      size: 24,
      isSymlink: true,
      lastCommit: null,
    },
  ],
  notes: [
    file('interviews.md', commit('Priya', 30, 'Move the research in')),
    file('sizing.md', commit('Kai', 9, 'First pass at the numbers')),
  ],
};

/** What the fixture room answers when a file is opened. */
const ROOM_FILES: Record<string, ExplorerFile['body']> = {
  'ROOM.md': {
    kind: 'text',
    text: '# One week, one question\n\nWe are answering **who this is for** before we build anything else.\n\n- Kai runs the interviews\n- Priya writes them up in `notes/`\n',
  },
  'README.md': {
    kind: 'text',
    text: '# Layout\n\n`notes/` holds the research. Everything else is scratch.\n',
  },
  'decisions.md': { kind: 'text', text: 'Nothing decided yet.\n' },
  'logo.png': { kind: 'binary' },
  'shared-tree': { kind: 'not-readable', reason: "This isn't a file that can be shown here." },
  'notes/interviews.md': {
    kind: 'text',
    text: '## Six calls\n\nAll six asked the same first question.\n',
  },
  'notes/sizing.md': { kind: 'text', text: 'Rough, and probably wrong.\n' },
};

/**
 * The one file whose save always loses the race.
 *
 * The conflict path is the half of §3.10 nobody can reach on their own — it
 * needs a second person editing the same file at the same moment — so one
 * fixture file answers `FILE_CHANGED` every time, and the copy on the section
 * says which. Without it the reload / keep-mine choice would be reviewable only
 * by reading the source.
 */
const ALWAYS_CONFLICTS = 'notes/sizing.md';

/** A room's own files, served from the fixture above instead of from git. */
function createFixtureRoomSource(): FileExplorerSource {
  return {
    scopeKey: 'playground:room-files',
    cwd: null,
    writable: false,
    provenance: true,
    filtersHidden: false,
    preview: 'inline',
    editable: true,
    list: (path) => Promise.resolve({ entries: ROOM_TREE[path] ?? [] }),
    read: (path) =>
      Promise.resolve({
        path,
        size: 240,
        lastCommit: ROOM_TREE[''].find((e) => e.path === path)?.lastCommit ?? null,
        commit: 'fixture0',
        body: ROOM_FILES[path] ?? { kind: 'too-large', maxBytes: 5 * 1024 * 1024 },
      }),
    save: ({ path, text }) => {
      if (path === ALWAYS_CONFLICTS) {
        return Promise.resolve({
          status: 'conflict',
          commit: 'fixture1',
          lastCommit: commit('Ana', 1, 'sharpen the sizing note'),
        });
      }
      ROOM_FILES[path] = { kind: 'text', text };
      return Promise.resolve({
        status: 'saved',
        commit: 'fixture1',
        lastCommit: commit('You', 0, `edit ${path}`),
        committed: true,
      });
    },
  };
}

/** The file explorer over a room's own files. */
export function FileExplorerShowcases() {
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    []
  );
  const transport = useMemo(() => createPlaygroundTransport(), []);
  const source = useMemo(() => createFixtureRoomSource(), []);

  return (
    <PlaygroundSection
      title="Room Files"
      description="One explorer, two sources. This is the room-shaped one: the tree is read-only, because what it lists is the commit main points at rather than files on a disk, while the markdown files in it can be opened and changed; provenance, because a commit knows who last touched a path and a filesystem does not; ROOM.md and README.md floated to the top; and the plumbing hidden until the eye is pressed. Clicking a file previews it in place — try the image and the symlink for the empty states, and Edit on a markdown file to save one. Saving notes/sizing.md always loses the race, which is how the reload / keep-mine choice is reachable here at all. The session pane is the same component with a different source, and it is on /session rather than here: the two share one store, so only one may be mounted at a time."
    >
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <ShowcaseLabel>Read-only, with provenance and pinning</ShowcaseLabel>
          <ShowcaseDemo responsive>
            <div className="border-border/60 flex h-80 w-full flex-col overflow-hidden rounded-lg border">
              <header className="border-border/60 flex items-center gap-2 border-b px-3 py-1.5">
                <h4 className="text-muted-foreground flex-1 text-xs font-medium tracking-wide uppercase">
                  Files
                </h4>
                <HiddenEntriesToggle />
              </header>
              <div className="min-h-0 flex-1">
                <FileExplorer source={source} />
              </div>
            </div>
          </ShowcaseDemo>
        </TransportProvider>
      </QueryClientProvider>
    </PlaygroundSection>
  );
}
