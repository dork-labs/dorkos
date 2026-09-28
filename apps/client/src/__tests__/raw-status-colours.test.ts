// @vitest-environment node
/**
 * Status text and status icons wear the design-system tokens, not raw
 * Tailwind palette colours.
 *
 * A raw `text-amber-600` is 3.19:1 on a white card and a raw `text-amber-500`
 * icon is 2.15:1: under the 4.5:1 bar text needs and the 3:1 bar an icon
 * needs. The tokens (`text-status-warning-fg`, `text-status-warning-dot`,
 * `text-status-success`, `text-destructive`) are tuned per theme and their
 * contrast is pinned by `status-warning-contrast.test.ts`,
 * `status-success-contrast.test.ts` and `destructive-contrast.test.ts`. This
 * guard is what keeps call sites on them: it scans the client source for a raw
 * status colour and fails on any file not listed below.
 *
 * Every file still allowed a raw colour is listed with its EXACT count and
 * the reason: a ratchet, so a fix must lower its entry in the same change and
 * the list can never hold room for a raw colour to creep back. Comments are
 * stripped before counting, since a comment naming the class a fix replaced
 * paints nothing. A colour that is not a status (diff counts, syntax highlighting, a
 * legend, a promo tint) stays raw on purpose; a tinted callout or chip that
 * needs its whole surface moved, not just its text, is tracked work.
 *
 * @module __tests__/raw-status-colours
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve } from 'node:path';

const SRC = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** A raw Tailwind status-hue colour used as text, fill or stroke, any variant prefix. */
const RAW_STATUS_COLOUR =
  /\b(?:text|fill|stroke)-(?:amber|yellow|orange|red|rose|green|emerald|lime)-\d{2,3}\b/g;

const NOT_STATUS = 'not a status colour';
const TINTED_SURFACE =
  'tinted callout or chip: the whole surface moves together, tracked separately';

/** Files still allowed raw status-hue colours, with how many and why. */
const ALLOWED: Record<string, { count: number; reason: string }> = {
  'layers/features/mesh/ui/TopologyLegend.tsx': {
    count: 1,
    reason: `${NOT_STATUS}: a capability legend`,
  },
  'layers/features/relay/ui/adapter/AdapterBindingRow.tsx': {
    count: 1,
    reason: `${NOT_STATUS}: the "can initiate messages" capability mark`,
  },
  'layers/features/chat/ui/chips/TouchChip.tsx': {
    count: 4,
    reason: `${NOT_STATUS}: diff +/- counts`,
  },
  'layers/features/chat/ui/chips/TouchChipStrip.tsx': {
    count: 4,
    reason: `${NOT_STATUS}: diff +/- counts`,
  },
  'layers/features/chat/ui/message/OutputRenderer.tsx': {
    count: 1,
    reason: `${NOT_STATUS}: JSON syntax highlighting`,
  },
  'layers/features/canvas/ui/CanvasJsonContent.tsx': {
    count: 2,
    reason: `${NOT_STATUS}: JSON syntax highlighting`,
  },
  'layers/shared/lib/tool-arguments-formatter.tsx': {
    count: 2,
    reason: `${NOT_STATUS}: argument value highlighting`,
  },
  'layers/features/feature-promos/ui/dialogs/PromoDialogLayout.tsx': {
    count: 1,
    reason: `${NOT_STATUS}: a promo accent palette`,
  },
  'layers/features/marketplace/ui/PackageCard.tsx': {
    count: 2,
    reason: `${NOT_STATUS}: a featured star`,
  },
  'layers/widgets/mobile-tabs/ui/MobileTabBar.tsx': {
    count: 1,
    reason: `${NOT_STATUS}: a count badge on an amber fill, tuned for that fill`,
  },
  'layers/entities/activity/model/activity-types.ts': {
    count: 1,
    reason: `${NOT_STATUS}: an activity category colour`,
  },
  'layers/features/settings/ui/ServerTab.tsx': { count: 14, reason: TINTED_SURFACE },
  'layers/features/settings/ui/external-mcp/DuplicateToolWarning.tsx': {
    count: 1,
    reason: TINTED_SURFACE,
  },
  'layers/features/chat/ui/message/PermissionDeniedChip.tsx': { count: 2, reason: TINTED_SURFACE },
  'layers/features/agent-creation/ui/TemplateReviewNotice.tsx': {
    count: 2,
    reason: TINTED_SURFACE,
  },
  'layers/features/relay/ui/DeadLetterSection.tsx': { count: 9, reason: TINTED_SURFACE },
  'layers/features/relay/ui/AdapterEventLog.tsx': { count: 10, reason: TINTED_SURFACE },
  'layers/features/relay/ui/wizard/TestStep.tsx': { count: 2, reason: TINTED_SURFACE },
  'layers/features/feedback-requests/ui/FeedbackRequestsPanel.tsx': {
    count: 4,
    reason: TINTED_SURFACE,
  },
  'layers/features/diff-review/ui/diff-chrome.tsx': { count: 2, reason: TINTED_SURFACE },
  'layers/features/dashboard-sidebar/ui/bottom-slot/UpdatePill.tsx': {
    count: 2,
    reason: TINTED_SURFACE,
  },
  'layers/features/marketplace/ui/PackageDetailSheet.tsx': { count: 2, reason: TINTED_SURFACE },
  'layers/features/marketplace/ui/InstalledPackagesView.tsx': { count: 4, reason: TINTED_SURFACE },
  'layers/features/marketplace/ui/ConfirmUpdatesDialog.tsx': { count: 2, reason: TINTED_SURFACE },
  'layers/entities/discovery/ui/CandidateCard.tsx': {
    count: 4,
    reason: 'tinted approve/deny buttons: a button variant, tracked separately',
  },
  'layers/entities/binding/ui/BindingDialog.tsx': {
    count: 2,
    reason: 'a destructive button with its own hover: a button variant, tracked separately',
  },
  'layers/features/marketplace/ui/InstallationIntegrityNote.tsx': {
    count: 6,
    reason: 'a warning summary that darkens on hover: no hover token yet, tracked separately',
  },
};

/** Every non-test, non-playground source file under `src/`. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'dev' || name === 'node_modules') continue;
      out.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Source with its comments removed, so a comment naming a class is not a use.
 *
 * A `//` right after a `:` or a quote is left alone: that is a URL, not a comment.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** How many raw status colours each file paints, keyed by its path under `src/`. */
function rawHits(): Record<string, number> {
  const hits: Record<string, number> = {};
  for (const path of sourceFiles(SRC)) {
    const code = stripComments(readFileSync(path, 'utf8'));
    const count = code.match(RAW_STATUS_COLOUR)?.length ?? 0;
    if (count > 0) hits[relative(SRC, path)] = count;
  }
  return hits;
}

/**
 * Every way the counts and the list disagree, as a sentence saying what to do.
 *
 * @param hits - Raw colours per file, from {@link rawHits}.
 * @param allowed - The list, file to count.
 */
function ratchetProblems(
  hits: Record<string, number>,
  allowed: Record<string, { count: number }>
): string[] {
  const problems: string[] = [];
  for (const [file, count] of Object.entries(hits)) {
    const ceiling = allowed[file]?.count ?? 0;
    if (count > ceiling)
      problems.push(`${file} paints ${count} raw status colours (allowed ${ceiling})`);
  }
  for (const [file, { count }] of Object.entries(allowed)) {
    const actual = hits[file] ?? 0;
    if (actual < count) {
      problems.push(
        actual === 0
          ? `remove the entry for ${file}: it paints no raw status colour now`
          : `lower the ceiling for ${file} to ${actual}`
      );
    }
  }
  return problems;
}

describe('raw status colours', () => {
  it('the pattern catches every variant a call site writes, and nothing else', () => {
    const match = (s: string) => s.match(RAW_STATUS_COLOUR) ?? [];
    expect(match('text-amber-600 dark:text-amber-400')).toHaveLength(2);
    expect(match('hover:text-red-700 fill-emerald-500 text-green-500/80')).toHaveLength(3);
    expect(match('text-status-warning-fg bg-amber-500/10 text-destructive')).toHaveLength(0);
  });

  it('the permission preview wears the warning token, not a raw amber', () => {
    const src = readFileSync(
      join(SRC, 'layers/features/marketplace/ui/PermissionPreviewSection.tsx'),
      'utf8'
    );
    expect(src.match(RAW_STATUS_COLOUR)).toBeNull();
    expect(src).toContain('text-status-warning-fg');
  });

  it('comments do not count, and a URL is not mistaken for one', () => {
    expect(stripComments('// text-amber-500\n/* text-red-500 */ x')).not.toMatch(RAW_STATUS_COLOUR);
    expect(stripComments("'https://x' text-red-500")).toMatch(RAW_STATUS_COLOUR);
  });

  it('the ratchet fails on an inflated entry, an unlisted file and a stale one', () => {
    expect(ratchetProblems({ 'a.tsx': 2 }, { 'a.tsx': { count: 3 } })).toEqual([
      'lower the ceiling for a.tsx to 2',
    ]);
    expect(ratchetProblems({}, { 'a.tsx': { count: 1 } })).toEqual([
      'remove the entry for a.tsx: it paints no raw status colour now',
    ]);
    expect(ratchetProblems({ 'b.tsx': 1 }, {})).toEqual([
      'b.tsx paints 1 raw status colours (allowed 0)',
    ]);
    expect(ratchetProblems({ 'a.tsx': 2 }, { 'a.tsx': { count: 2 } })).toEqual([]);
  });

  it('every file paints exactly the raw status colours the list allows it', () => {
    expect(ratchetProblems(rawHits(), ALLOWED)).toEqual([]);
  });
});
