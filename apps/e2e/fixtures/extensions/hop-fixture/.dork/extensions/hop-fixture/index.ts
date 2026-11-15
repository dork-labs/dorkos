// hop-fixture: the browser-test stand-in for an app that opens another app's
// page (apps/e2e/tests/extensions/app-navigate-gesture.spec.ts, DOR-3293). It
// lists `hello-world` with `navigate: true` and has one page with two ways to
// open Hello World's page:
//
// - with no click: from PESTER_DELAY_MS after load, it keeps putting focus on
//   its own frame (`window.focus()`) and calling `api.navigate`. DorkOS must
//   answer `no-gesture` every time, whatever the person does in DorkOS itself.
// - from a button: a real click or Enter, which DorkOS honours. Pressing the
//   button stops the no-click tries, so only the button can open the page.
//
// It also adds a right-panel tab, "Hop B": a second view, so a second frame,
// with one button that does nothing but log. A click there must never let the
// page's frame open anything.
//
// Every result goes to the console as a `hop:` line. The spec reads them from
// there because a Playwright read of the page counts as a click in Chromium.
//
// No imports and no JSX on purpose: the host compiles this with esbuild at run
// time, and the e2e package typechecks it as plain TypeScript. React is the
// global the frame provides.

/** The slice of React this page uses, from the frame's global. */
declare const React: {
  createElement(
    type: unknown,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ): unknown;
  useEffect(effect: () => void, deps: unknown[]): void;
};

/** What `api.navigate` answers inside an app's frame. */
interface NavigateResult {
  ok: boolean;
  reason?: string;
}

/** The host calls this fixture makes. */
interface FixtureApi {
  registerPage(path: string, view: () => unknown, options: { title: string }): void;
  registerComponent(
    slot: 'right-panel',
    id: string,
    component: () => unknown,
    options: { label: string }
  ): void;
  navigate(path: string): Promise<NavigateResult>;
}

/** Hello World's home page. */
const TARGET = '/x/hello-world';
/**
 * How long after load the no-click tries start. Longer than Chromium's 5 s
 * activation window, so a spec can find what it clicks first and let the
 * activation that finding raised run out before any try.
 */
const PESTER_DELAY_MS = 16_000;
/** How often a no-click try runs, and how many. */
const PESTER_EVERY_MS = 250;
const PESTER_TRIES = 80;

/** How a result reads in the console. */
function said(result: NavigateResult): string {
  return result.ok ? 'opened' : `refused: ${result.reason ?? 'unknown'}`;
}

/** One line the spec reads. */
function report(line: string): void {
  console.log(`hop: ${line}`);
}

/** Set once the button is pressed: the no-click tries stop. */
let stopped = false;

/** The page: the no-click tries, and the button for a real click. */
function HopPage({ api }: { api: FixtureApi }): unknown {
  React.useEffect(() => {
    stopped = false;
    report('ready');
    let tries = 0;
    let every: ReturnType<typeof setInterval> | undefined;
    const start = setTimeout(() => {
      report('pester start');
      every = setInterval(() => {
        tries += 1;
        if (stopped || tries > PESTER_TRIES) return clearInterval(every);
        const n = tries;
        // The attack: focus our own frame, then open another app's page, no click.
        window.focus();
        void api.navigate(TARGET).then((result) => report(`try ${n} ${said(result)}`));
      }, PESTER_EVERY_MS);
    }, PESTER_DELAY_MS);
    return () => {
      clearTimeout(start);
      clearInterval(every);
    };
  }, []);
  // Logged on press, before the open: once the page moves, this frame is gone
  // and can log nothing more.
  const stop = () => {
    if (!stopped) report('button pressed');
    stopped = true;
  };
  return React.createElement(
    'button',
    {
      type: 'button',
      onPointerDown: stop,
      onKeyDown: stop,
      onClick: () => void api.navigate(TARGET).then((result) => report(`button ${said(result)}`)),
    },
    'Open Hello World'
  );
}

/** The right-panel view: a second frame whose button only says it was pressed. */
function HopPanel(): unknown {
  return React.createElement(
    'button',
    { type: 'button', onPointerDown: () => report('b pressed') },
    'Hop B button'
  );
}

/**
 * Register the page at `/x/hop-fixture` and the "Hop B" right-panel tab.
 *
 * @param api - The host API handed to every app.
 */
export function activate(api: FixtureApi): void {
  api.registerPage('', () => React.createElement(HopPage, { api }), { title: 'Hop' });
  api.registerComponent('right-panel', 'hop-b', () => React.createElement(HopPanel, null), {
    label: 'Hop B',
  });
}
