import { NextResponse, type NextRequest } from 'next/server';
import { classifyRegion, REGION_COOKIE } from '@/lib/region';

/**
 * Edge proxy (Next.js 16's successor to `middleware`) that classifies each
 * visitor's consent region from Vercel's geo header and hands it to the client
 * through a strictly-necessary `dorkos_region` cookie.
 *
 * The site's analytics UX (opt-in banner vs on-by-default) is chosen
 * client-side, but the geo signal is only available on the edge. This writes
 * the classification into a first-party cookie the client reads on mount (see
 * `lib/consent.ts`). The cookie is not `httpOnly` (the client must read it) and
 * carries no personal data — only `open` or `gated` — so it needs no consent.
 *
 * `x-vercel-ip-country` is absent off Vercel (local dev, previews on other
 * hosts), which `classifyRegion` fails closed to `gated`.
 *
 * @param request - The incoming request, carrying the Vercel geo header.
 */
export function proxy(request: NextRequest): NextResponse {
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
  return response;
}

/**
 * Run on page navigations only. Skips Next internals, the analytics ingest
 * proxy (`/hub`), API routes, and any path with a file extension (static
 * assets) — none of which need the region cookie.
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|hub|api|favicon.ico|.*\\..*).*)'],
};
