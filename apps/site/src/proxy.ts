import { NextResponse, type NextRequest } from 'next/server';
import { isMarkdownPreferred, rewritePath } from 'fumadocs-core/negotiation';
import { env } from '@/env';
import {
  decideCloudAccountsForward,
  parseCloudAccountsOrigin,
  proxiedRequestHeaders,
} from '@/lib/cloud-accounts/forward';
import { classifyRegion, REGION_COOKIE } from '@/lib/region';

/**
 * User agents that get the raw install script from `/install`. An allowlist,
 * not an Accept-header denylist, because link-unfurl crawlers (Slack,
 * Discord, Facebook) also send `Accept: * / *` and must see the page's
 * OpenGraph tags, while an unknown CLI piping HTML into bash would break
 * loudly either way. The documented install paths only ever use curl.
 */
const CLI_USER_AGENTS = /^(curl|wget|libcurl|httpie|python-requests|go-http-client|powershell)/i;

/**
 * Rewrites a canonical docs path (`/docs/getting-started/quickstart`) to the
 * raw-markdown route (`/llms.mdx/docs/getting-started/quickstart`) that
 * `getLLMText` renders. Fumadocs' first-party helper; the same target the
 * `.md`/`.mdx` suffix rewrites in `next.config.ts` point at.
 */
const rewriteDocsToMarkdown = rewritePath('/docs/*path', '/llms.mdx/docs/*path');

/**
 * The markdown route target for a canonical docs path, or `null` when the path
 * is not a docs page. The wildcard pattern only matches `/docs/<something>`;
 * the bare `/docs` index has no capture group, so it is mapped explicitly.
 *
 * @param pathname - The request pathname (no query string, no file extension —
 *   dotted paths like `/docs/foo.md` bypass the proxy via the matcher below).
 */
function docsMarkdownTarget(pathname: string): string | null {
  if (pathname === '/docs') return '/llms.mdx/docs';
  const rewritten = rewriteDocsToMarkdown.rewrite(pathname);
  return rewritten === false ? null : rewritten;
}

/** True for a canonical docs page path (extension-less; see the matcher). */
function isDocsPath(pathname: string): boolean {
  return pathname === '/docs' || pathname.startsWith('/docs/');
}

/**
 * Edge proxy (Next.js 16's successor to `middleware`) with four jobs:
 *
 * 0. **Handing accounts to the accounts service**, only when
 *    `DORKOS_CLOUD_ACCOUNTS_ORIGIN` is set (`lib/cloud-accounts/forward.ts`). Unset,
 *    this step does nothing and every path below behaves as before. It runs
 *    first and returns early, so a forwarded request gets no region cookie and
 *    no negotiation: it is not this site's response.
 *
 * 1. **`/install` content negotiation.** One URL serves two audiences: the
 *    documented one-liner (`curl -fsSL https://dorkos.ai/install | bash`) and
 *    people clicking a link. CLI clients (matched by user agent) are
 *    rewritten to the raw script at `/install.sh`; everyone else — browsers,
 *    RSC/prefetch navigations, link-unfurl bots — gets the install page.
 *    Response caching stays correct on Vercel because the proxy runs before
 *    the edge cache and each rewrite target caches under its own path; a
 *    non-Vercel cache in front would need `Vary: User-Agent` on `/install`.
 *
 * 2. **`/docs` markdown content negotiation.** A canonical docs URL serves
 *    HTML to browsers and raw markdown to agents that ask for it. When the
 *    `Accept` header prefers markdown (`text/markdown`/`text/plain`/
 *    `text/x-markdown`, via Fumadocs' `isMarkdownPreferred`), the request is
 *    rewritten to the existing `llms.mdx` route. Browser navigations send
 *    `Accept: text/html,...` and RSC/prefetch requests send `text/x-component`
 *    or `* / *`, none of which prefer markdown, so they keep getting HTML. The
 *    reverse is advertised on the HTML response: every docs page carries a
 *    `Link: <…page.md>; rel="alternate"; type="text/markdown"` header so an
 *    agent that only reads headers discovers the markdown alternate. That
 *    header lives here, not in `next.config.ts` headers() (which does support
 *    param-in-value substitution), because this proxy's matcher already
 *    excludes the dotted `.md`/`.mdx` paths — a `headers()` rule on
 *    `/docs/:path*` would also match those and emit a broken double-suffix
 *    `Link`. Keeping it beside the negotiation logic keeps the two halves in
 *    one place.
 *
 * 3. **Consent-region cookie.** Classifies each visitor's consent region from
 *    Vercel's geo header and hands it to the client through a
 *    strictly-necessary `dorkos_region` cookie. The site's analytics UX
 *    (opt-in banner vs on-by-default) is chosen client-side, but the geo
 *    signal is only available on the edge. This writes the classification
 *    into a first-party cookie the client reads on mount (see
 *    `lib/consent.ts`). The cookie is not `httpOnly` (the client must read
 *    it) and carries no personal data — only `open` or `gated` — so it needs
 *    no consent. `x-vercel-ip-country` is absent off Vercel (local dev,
 *    previews on other hosts), which `classifyRegion` fails closed to
 *    `gated`.
 *
 * @param request - The incoming request, carrying the Vercel geo header.
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  const forward = decideCloudAccountsForward(
    request,
    parseCloudAccountsOrigin(env.DORKOS_CLOUD_ACCOUNTS_ORIGIN)
  );
  if (forward?.kind === 'redirect') {
    const response = NextResponse.redirect(forward.url, 307);
    // Never cached anywhere, so turning the variable off takes effect at once.
    response.headers.set('cache-control', 'private, no-store');
    return response;
  }
  if (forward?.kind === 'proxy') {
    // Who the caller is, for the service's per-address limits (DOR-2443): only
    // with the shared secret, only on Vercel, and never a caller's own copy.
    const headers = proxiedRequestHeaders(request.headers, {
      secret: env.DORKOS_CLOUD_ACCOUNTS_PROXY_SECRET,
      // `VERCEL_ENV` alone can come from a pulled `.env.local`; the platform
      // itself sets `VERCEL=1` at runtime.
      onVercel:
        env.VERCEL === '1' && (env.VERCEL_ENV === 'production' || env.VERCEL_ENV === 'preview'),
    });
    return headers
      ? NextResponse.rewrite(forward.url, { request: { headers } })
      : NextResponse.rewrite(forward.url);
  }

  // The account API paths are in the matcher only so they can be forwarded.
  // Served locally, they get exactly what they got before the matcher named
  // them: no region cookie, no negotiation.
  if (pathname.startsWith('/api/')) return NextResponse.next();

  if (pathname === '/install') {
    const userAgent = request.headers.get('user-agent') ?? '';
    if (CLI_USER_AGENTS.test(userAgent)) {
      // CLI fetch: serve the script. No region cookie — curl has no consent UX.
      return NextResponse.rewrite(new URL('/install.sh', request.url));
    }
  }

  if (isDocsPath(pathname) && isMarkdownPreferred(request)) {
    const target = docsMarkdownTarget(pathname);
    if (target) {
      // Markdown alternate: a raw payload with no consent UX, like the
      // install.sh branch above — so no region cookie.
      return NextResponse.rewrite(new URL(target, request.url));
    }
  }

  const country = request.headers.get('x-vercel-ip-country');
  const region = classifyRegion(country);

  const response = NextResponse.next();
  response.cookies.set(REGION_COOKIE, region, {
    path: '/',
    sameSite: 'lax',
    secure: true,
    // Strictly-necessary and non-identifying; readable by the client script.
    httpOnly: false,
    // Refresh daily so a traveling visitor's region stays current.
    maxAge: 60 * 60 * 24,
  });

  if (isDocsPath(pathname)) {
    // Advertise the markdown alternate to agents that only inspect headers.
    // Relative URL so it resolves against the request host (works on prod,
    // previews, and local dev alike).
    response.headers.set('Link', `<${pathname}.md>; rel="alternate"; type="text/markdown"`);
  }

  return response;
}

/**
 * Run on page navigations, plus the account API paths the accounts hand-over
 * may forward. The first entry skips Next internals, the analytics ingest proxy
 * (`/hub`), API routes, and any path with a file extension (static assets, and
 * the `.md`/`.mdx` markdown routes which `next.config.ts` rewrites directly) —
 * none of which need the region cookie or markdown negotiation. The rest name
 * the account API (`CLOUD_ACCOUNT_API_*` in `lib/cloud-accounts/forward.ts`; a test
 * keeps the two lists in step). Matchers must be literals, so they are written
 * out rather than built from those constants.
 */
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|hub|api|favicon.ico|.*\\..*).*)',
    '/api/auth/:path*',
    '/api/account/:path*',
    '/api/instances',
    '/api/instances/heartbeat',
    '/api/instances/pending',
    '/api/instances/revoke',
  ],
};
