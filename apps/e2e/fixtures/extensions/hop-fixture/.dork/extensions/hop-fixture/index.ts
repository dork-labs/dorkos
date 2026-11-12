// hop-fixture: the browser-test stand-in for an app that opens another app's
// page (apps/e2e/tests/extensions/app-navigate-gesture.spec.ts, DOR-3293). It
// lists `hello-world` with `navigate: true` and has one page with two ways to
// open Hello World's page:
//
// - on load, with no click: it puts focus on its own frame (`window.focus()`)
//   and calls `api.navigate`. DorkOS must refuse that as `no-gesture`.
// - from a button: a real click, which DorkOS honours.
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
  useState<T>(initial: T): [T, (next: T) => void];
};

/** What `api.navigate` answers inside an app's frame. */
interface NavigateResult {
  ok: boolean;
  reason?: string;
}

/** The host calls this fixture makes. */
interface FixtureApi {
  registerPage(path: string, view: () => unknown, options: { title: string }): void;
  navigate(path: string): Promise<NavigateResult>;
}

/** Hello World's home page. */
const TARGET = '/x/hello-world';

/** How a result reads on the page. */
function said(result: NavigateResult): string {
  return result.ok ? 'opened' : `refused: ${result.reason ?? 'unknown'}`;
}

/** The page: one line for the no-click try, and the button for a real click. */
function HopPage({ api }: { api: FixtureApi }): unknown {
  const [onLoad, setOnLoad] = React.useState('waiting');
  React.useEffect(() => {
    // The attack: focus our own frame, then open another app's page, no click.
    window.focus();
    void api.navigate(TARGET).then((result) => setOnLoad(said(result)));
  }, []);
  return React.createElement(
    'div',
    null,
    React.createElement('p', { 'data-testid': 'hop-on-load' }, onLoad),
    React.createElement(
      'button',
      { type: 'button', onClick: () => void api.navigate(TARGET) },
      'Open Hello World'
    )
  );
}

/**
 * Register the page at `/x/hop-fixture`.
 *
 * @param api - The host API handed to every app.
 */
export function activate(api: FixtureApi): void {
  api.registerPage('', () => React.createElement(HopPage, { api }), { title: 'Hop' });
}
