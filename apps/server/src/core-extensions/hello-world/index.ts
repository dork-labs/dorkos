import type { ExtensionAPI, ExtensionPageProps, StatusBarSlotContext } from '@dorkos/extension-api';

// React is provided by the host as a global — do not import it.

/**
 * Hello World extension — demonstrates the extension API.
 *
 * It adds one of everything an extension can add to the app:
 *
 * - a section on the Activity tab,
 * - a command palette item that says hello, and one that marks its tab,
 * - a page at `/x/hello-world`, listed in the command palette and the phone's
 *   "Add-ons" menu, with a "Start a chat" button that starts work in a new
 *   chat and leaves the current one alone,
 * - an item in the chat status bar, shown only when the chat has a folder,
 * - a tab in the right panel, which its command marks with a dot.
 *
 * It ships turned off. To try it, open Settings > Extensions and turn on
 * "Hello World".
 */
export function activate(api: ExtensionAPI): () => void {
  // Register a dashboard section
  const unregisterSection = api.registerComponent(
    'dashboard.sections',
    'hello-greeting',
    HelloSection,
    { priority: 90 } // After built-in sections
  );

  // Register a command palette item
  const unregisterCommand = api.registerCommand(
    'greet',
    'Hello World: Show Greeting',
    () => {
      api.notify('Hello from the Hello World extension!', { type: 'success' });
    },
    { icon: 'hand-metal' }
  );

  // A full page at /x/hello-world. The empty path is the extension's home. The
  // page needs `api` for its button, so it is bound here.
  const Page = (props: ExtensionPageProps) => <HelloPage {...props} api={api} />;
  const unregisterPage = api.registerPage('', Page, { title: 'Hello' });

  // An item in the chat status bar. `when` reads only its `ctx` argument: it
  // runs while the status bar decides what fits, so it must never fetch or
  // read anything else.
  const unregisterStatusItem = api.registerStatusBarItem('greeting', HelloStatusItem, {
    label: 'Hello World',
    when: (ctx) => ctx.cwd !== null,
  });

  // A tab in the right panel, and a command that marks it. Core draws the dot
  // and adds "something needs you" to the tab's name; the extension only says
  // whether it is marked.
  const unregisterPanel = api.registerComponent('right-panel', 'hello-panel', HelloPanel, {
    label: 'Hello',
  });
  let marked = false;
  const unregisterMarkCommand = api.registerCommand(
    'toggle-dot',
    'Hello World: Toggle Tab Dot',
    () => {
      marked = !marked;
      api.setTabMarker('hello-panel', marked ? 'attention' : null);
    }
  );

  // Subscribe to state changes
  const unsubscribe = api.subscribe(
    (state) => state.currentProject?.name ?? null,
    (projectName) => {
      console.log(`[hello-world] Project changed: ${projectName ?? 'none'}`);
    }
  );

  // Demonstrate persistent storage
  api.loadData<{ visits: number }>().then((data) => {
    const visits = (data?.visits ?? 0) + 1;
    api.saveData({ visits });
    console.log(`[hello-world] Visit count: ${visits}`);
  });

  // Return cleanup function (called on deactivation). Everything registered
  // above is also removed automatically; this shows the explicit form.
  return () => {
    console.log('[hello-world] Deactivating...');
    unregisterSection();
    unregisterCommand();
    unregisterPage();
    unregisterStatusItem();
    unregisterPanel();
    unregisterMarkCommand();
    unsubscribe();
  };
}

// React components. React is provided by the host — do NOT import it in the
// extension bundle. The JSX transform handles createElement calls automatically.

const MUTED = 'var(--muted-foreground)';

function HelloSection() {
  return (
    <div style={{ padding: '16px', border: '1px solid var(--border)', borderRadius: '16px' }}>
      <h3 style={{ margin: '0 0 12px', fontSize: '12px', fontWeight: 500, textTransform: 'uppercase' as const, letterSpacing: '0.1em', color: MUTED }}>Hello World Extension</h3>
      <p style={{ margin: 0, fontSize: '13px', color: MUTED }}>
        This section was added by the hello-world sample extension.
      </p>
    </div>
  );
}

/** The extension's page. Core gives it the whole content area and scrolls it. */
function HelloPage({ search, setSearch, api }: ExtensionPageProps & { api: ExtensionAPI }) {
  const name = search.name ?? 'there';
  return (
    <div style={{ maxWidth: '40rem', margin: '0 auto', padding: '24px 16px' }}>
      <h1 style={{ margin: '0 0 8px', fontSize: '20px', fontWeight: 600 }}>Hello, {name}</h1>
      <p style={{ margin: '0 0 16px', fontSize: '14px', color: MUTED }}>
        This page was added by the hello-world sample extension. Its address is /x/hello-world,
        and what you type below is kept in the address, so you can bookmark it.
      </p>
      <label style={{ display: 'block', fontSize: '13px', color: MUTED }}>
        Your name
        <input
          value={search.name ?? ''}
          onChange={(event) => setSearch({ name: event.target.value || null })}
          style={{ display: 'block', marginTop: '4px', width: '100%', maxWidth: '20rem', padding: '6px 8px', border: '1px solid var(--border)', borderRadius: '8px', background: 'transparent', color: 'inherit', fontSize: '14px' }}
        />
      </label>
      <StartChat api={api} />
    </div>
  );
}

/**
 * An outcome button (spec `flow-multiproject` V7): one click starts the work in
 * a NEW chat in the current project, and the button turns into "Saying hello… ·
 * Watch". Nothing navigates, and the chat you were in keeps what you typed.
 */
function StartChat({ api }: { api: ExtensionAPI }) {
  const [started, setStarted] = React.useState<string | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  // The project of the folder the app is in, kept current: it is null while
  // the folder is still being resolved.
  const [project, setProject] = React.useState(() => api.getState().currentProject);
  React.useEffect(
    () => api.subscribe((state) => state.currentProject, (next) => setProject(next)),
    []
  );

  const start = async () => {
    if (!project) return;
    setBusy(true);
    setProblem(null);
    try {
      const { sessionId } = await api.startWork({
        project: project.root,
        prompt: 'Say hello, in one short sentence, then stop.',
        title: `Saying hello in ${project.name}`,
        reason: 'You asked for a hello from the Hello page',
      });
      setStarted(sessionId);
    } catch (err) {
      // `err.code` says which rule refused it; the message is already plain words.
      setProblem(err instanceof Error ? err.message : 'The chat could not be started.');
    } finally {
      setBusy(false);
    }
  };

  const button = { padding: '6px 12px', border: '1px solid var(--border)', borderRadius: '8px', background: 'transparent', color: 'inherit', fontSize: '13px', cursor: 'pointer' };
  return (
    <section style={{ marginTop: '24px' }}>
      {started ? (
        <p style={{ margin: 0, fontSize: '13px' }}>
          Saying hello…{' · '}
          <button type="button" style={{ ...button, padding: '2px 8px' }} onClick={() => api.navigate(`/session?session=${encodeURIComponent(started)}`)}>
            Watch
          </button>
        </p>
      ) : (
        <button type="button" style={button} disabled={!project || busy} onClick={() => void start()}>
          Start a chat
        </button>
      )}
      <p style={{ margin: '8px 0 0', fontSize: '12px', color: MUTED }}>
        {problem ?? (project ? `A new chat in ${project.name} says hello. This page stays as it is.` : 'Open a chat in one of your projects first, then come back.')}
      </p>
    </section>
  );
}

/** The status-bar item: short on a phone, with the project's name when there is room. */
function HelloStatusItem({ project, compact }: StatusBarSlotContext) {
  return (
    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
      {compact || !project ? 'Hello' : `Hello, ${project.name}`}
    </span>
  );
}

/** The right-panel tab's content. */
function HelloPanel() {
  return (
    <div style={{ padding: '16px', fontSize: '13px', color: MUTED }}>
      Run "Hello World: Toggle Tab Dot" from the command palette to mark this tab.
    </div>
  );
}
