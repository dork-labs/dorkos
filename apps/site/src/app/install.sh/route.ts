import { NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const script = readFileSync(join(process.cwd(), 'scripts', 'install.sh'), 'utf-8');

/**
 * Serves the DorkOS install script for `curl -fsSL | bash`.
 *
 * Reachable directly at `/install.sh`, and via `/install` for CLI clients:
 * `src/proxy.ts` rewrites non-browser requests for `/install` here, so the
 * documented one-liner (`curl -fsSL https://dorkos.ai/install | bash`) keeps
 * working while browsers see the install page at the same URL.
 */
export function GET() {
  return new NextResponse(script, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=3600',
    },
  });
}
