/**
 * One spinning loader in the app, and only one file that draws it.
 *
 * `Loader2 + animate-spin` was hand-written at 44 call sites before
 * `shared/ui/spinner.tsx` existed, at six sizes for the same "inline loading"
 * job, with the decorative ones read aloud by a screen reader in about half of
 * them (DOR-1763 finding 17.9). Batch 17 promoted the convention to a
 * component and converted the representative sites; DOR-1811 converted the
 * remaining 34 files.
 *
 * Nothing stopped the next call site from importing the raw icon again — the
 * lucide import is legal everywhere and a hand-rolled spinner looks identical
 * in a diff to a `Spinner`. This is the guard: the icon may be imported in the
 * one file whose job is to wrap it, and nowhere else.
 *
 * @module __tests__/one-spinner
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it, expect } from 'vitest';

const SRC = join(__dirname, '..');

/** The one file allowed to import the raw icon — `Spinner` wraps it. */
const SPINNER_IMPLEMENTATION = join('layers', 'shared', 'ui', 'spinner.tsx');

/** Every `.ts`/`.tsx` file under `apps/client/src`, keyed by its path from `src/`. */
function clientSource(): Map<string, string> {
  const walk = (dir: string): [string, string][] =>
    readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) return [];
      return [[relative(SRC, full), readFileSync(full, 'utf8')] as [string, string]];
    });
  return new Map(walk(SRC));
}

const CLIENT_SOURCE = clientSource();

describe('one spinner (DOR-1811)', () => {
  it('walks a real, populated tree', () => {
    // A walk that silently found nothing would pass every assertion below.
    expect(CLIENT_SOURCE.size).toBeGreaterThan(500);
    expect(CLIENT_SOURCE.has(SPINNER_IMPLEMENTATION)).toBe(true);
  });

  it('imports the raw lucide loader icon only in the Spinner implementation', () => {
    // Both spellings lucide exports for the same glyph. `Loader2Icon` reached
    // the toaster's loading state before this sweep, so matching only the bare
    // name would have missed a live call site.
    const importsRawLoader = (text: string): boolean =>
      /^import\s[^;]*\bLoader2(?:Icon)?\b[^;]*from\s+['"]lucide-react['"]/m.test(text);

    const offenders = [...CLIENT_SOURCE]
      .filter(([file, text]) => file !== SPINNER_IMPLEMENTATION && importsRawLoader(text))
      .map(([file]) => file.split(sep).join('/'))
      .sort();

    expect(offenders).toEqual([]);
  });

  it('leaves the sites that stop for reduced motion able to stop', () => {
    // The component spins unconditionally, so the five call sites that
    // deliberately hold still for someone who asked for less motion have to
    // turn it OFF rather than leave it on. `animate-none` (and its
    // `motion-reduce:` variant) is the only spelling that displaces the
    // component's own `animate-spin` through `cn`; re-adding `animate-spin` at
    // the call site would silently re-animate all five.
    expect(CLIENT_SOURCE.get(SPINNER_IMPLEMENTATION)).toContain("cva('animate-spin'");

    const stopsForReducedMotion = [
      'layers/entities/runtime/ui/RuntimeSetupDialog.tsx',
      'layers/features/conversation/ui/rows/PendingRow.tsx',
      'layers/features/runtime-connect/ui/OllamaLocalPath.tsx',
      'layers/features/runtime-connect/ui/connect-feedback.tsx',
      'layers/features/settings/ui/runtimes/RuntimeCard.tsx',
    ];
    for (const file of stopsForReducedMotion) {
      const text = CLIENT_SOURCE.get(file.split('/').join(sep));
      expect(text, `${file} is missing`).toBeDefined();
      expect(text, `${file} no longer turns the spin off`).toMatch(
        /(?:motion-reduce:)?animate-none/
      );
    }
  });
});
