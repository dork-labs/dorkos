// mini-app-reader-fixture's server half (DOR-3547). It runs in its own
// process, which is what lets it ask to read an app at all, and serves one
// service worker script so the test can prove DorkOS refuses to install it.
// No imports on purpose: the host compiles this with esbuild at run time.

/** The slice of a router this fixture uses. */
interface FixtureRouter {
  get(path: string, handler: (req: unknown, res: FixtureResponse) => void): void;
}

/** The slice of a response this fixture uses. */
interface FixtureResponse {
  type(value: string): FixtureResponse;
  send(body: string): void;
}

/**
 * Serve a worker script that would read every page it controls.
 *
 * @param router - The extension's router, mounted at /api/ext/mini-app-reader-fixture.
 */
export default function register(router: FixtureRouter): void {
  router.get('/sw.js', (_req, res) => {
    res.type('text/javascript').send("self.addEventListener('fetch', () => {});");
  });
}
