/**
 * Fail a release when the Agent browser's fallback Chromium is over 30 days behind stable.
 *
 * WHY THIS EXISTS. When a person has no Google Chrome installed, the Agent browser and its plain
 * sign-in window run the Chromium build pinned in `playwright-backend.ts`
 * (`LOCAL_MANAGED_CHROMIUM_VERSION`). That pin moves only when a release bumps Playwright, so
 * nothing keeps it current by itself, and a person may type a password into it. Security's terms
 * for DOR-3876 (#dorkos, Nov 4): the sign-in window may hide Chromium's "only for automated
 * testing" bar only while this check holds the pinned build within 30 days of stable. It runs in
 * the `/system:release` pre-flight, so a stale pin stops the release, not a person's sign-in.
 *
 * HOW "BEHIND" IS MEASURED. A pin is behind from the day the next milestone first reached stable
 * (its early-stable date when Chromium published one, else its stable date) until the pin moves.
 * A pin at or ahead of today's stable milestone (Playwright's alphas run ahead) is 0 days behind.
 * Dates come from Chromium Dash, the release team's own schedule; the release feed's `time` field
 * is when the feed was read, not when a build shipped, so it is never used.
 *
 * Exit 0: within the limit. Exit 1: over it (bump Playwright, or record why not, before releasing).
 * Exit 2: could not read the pin or the schedule. A gate that cannot measure must not pass.
 *
 * Usage: `pnpm check:chromium-age`
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** How many days the fallback Chromium may trail stable (Security's starting number, DOR-3876). */
export const MAX_DAYS_BEHIND = 30;

const PIN_FILE = fileURLToPath(
  new URL(
    '../../apps/server/src/services/session/local-browser/playwright-backend.ts',
    import.meta.url
  )
);
const DASH = 'https://chromiumdash.appspot.com';
const DAY_MS = 24 * 60 * 60 * 1000;

/** What the check found, in the words a release report needs. */
export interface ChromiumAge {
  /** The pinned fallback Chromium, for example `157.0.8103.15`. */
  pinned: string;
  /** The newest milestone on the stable channel. */
  stableMilestone: number;
  /** Whole days the pin has trailed stable; 0 when it is current or ahead. */
  daysBehind: number;
  /** True when `daysBehind` is within {@link MAX_DAYS_BEHIND}. */
  ok: boolean;
}

/** The two reads the check makes, so tests can hand it canned answers. */
export interface ChromiumAgeSources {
  /** The pinned version string from the source file. */
  pinned(): string;
  /** The newest stable milestone. */
  stableMilestone(): Promise<number>;
  /** The first day a milestone reached stable. */
  firstStableDate(milestone: number): Promise<Date>;
}

/**
 * Read `LOCAL_MANAGED_CHROMIUM_VERSION` out of the backend's source text.
 *
 * @param source - The text of `playwright-backend.ts`.
 * @returns The pinned version.
 */
export function readPinnedVersion(source: string): string {
  const match = /LOCAL_MANAGED_CHROMIUM_VERSION\s*=\s*'(\d+\.\d+\.\d+\.\d+)'/.exec(source);
  if (!match?.[1])
    throw new Error('No LOCAL_MANAGED_CHROMIUM_VERSION pin found in playwright-backend.ts');
  return match[1];
}

/**
 * Measure how far the pinned fallback Chromium trails stable.
 *
 * @param sources - Where the pin and the schedule come from.
 * @param now - Today, for the day count.
 * @returns The measurement and whether it passes.
 */
export async function measureChromiumAge(
  sources: ChromiumAgeSources,
  now: Date
): Promise<ChromiumAge> {
  const pinned = sources.pinned();
  const pinnedMilestone = Number(pinned.split('.')[0]);
  const stableMilestone = await sources.stableMilestone();
  let daysBehind = 0;
  if (stableMilestone > pinnedMilestone) {
    const since = await sources.firstStableDate(pinnedMilestone + 1);
    // A milestone already on stable can't reach stable in the future. Sources that disagree
    // can't be measured from, and counting 0 days would pass a stale pin.
    if (since.getTime() > now.getTime())
      throw new Error(
        `Milestone ${pinnedMilestone + 1} is listed as stable, but its schedule says it reaches stable later`
      );
    daysBehind = Math.floor((now.getTime() - since.getTime()) / DAY_MS);
  }
  return { pinned, stableMilestone, daysBehind, ok: daysBehind <= MAX_DAYS_BEHIND };
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Chromium Dash answered ${response.status} for ${url}`);
  return response.json();
}

/** Chromium Dash writes its schedule dates as `YYYY-MM-DDTHH:MM:SS`, in UTC, with no zone. */
const DASH_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

function dashDate(value: unknown, what: string): Date | undefined {
  if (value === undefined || value === null) return undefined;
  const date = typeof value === 'string' && DASH_DATE.test(value) ? new Date(`${value}Z`) : null;
  if (!date || Number.isNaN(date.getTime()))
    throw new Error(`Chromium Dash gave an unreadable ${what}: ${JSON.stringify(value)}`);
  return date;
}

/**
 * Chromium Dash as the schedule. Every answer is read strictly: anything malformed throws, so
 * the check exits 2 rather than measuring from a guess. Skipping a bad entry could hide the
 * newest milestone, and a schedule for the wrong milestone could start the count late; both
 * would read as fewer days behind, so neither is ever tolerated.
 *
 * @param getJson - Fetches a URL and returns its parsed JSON body.
 * @returns The two schedule reads.
 */
export function dashSchedule(
  getJson: (url: string) => Promise<unknown>
): Pick<ChromiumAgeSources, 'stableMilestone' | 'firstStableDate'> {
  return {
    async stableMilestone() {
      const releases = await getJson(`${DASH}/fetch_releases?channel=Stable&platform=Mac&num=10`);
      if (!Array.isArray(releases) || releases.length === 0)
        throw new Error('Chromium Dash listed no stable Mac releases');
      const milestones = releases.map((release: { milestone?: unknown } | null) => {
        const milestone = release?.milestone;
        if (!Number.isInteger(milestone) || (milestone as number) < 1)
          throw new Error(`Chromium Dash listed a release with no milestone`);
        return milestone as number;
      });
      return Math.max(...milestones);
    },
    async firstStableDate(milestone) {
      const body = (await getJson(`${DASH}/fetch_milestone_schedule?mstone=${milestone}`)) as {
        mstones?: unknown;
      } | null;
      const entries = Array.isArray(body?.mstones) ? body.mstones : [];
      const entry = entries[0] as
        { mstone?: unknown; early_stable?: unknown; stable_date?: unknown } | undefined;
      if (entries.length !== 1 || entry?.mstone !== milestone)
        throw new Error(`Chromium Dash has no schedule for milestone ${milestone}`);
      const dates = [
        dashDate(entry.early_stable, 'early stable date'),
        dashDate(entry.stable_date, 'stable date'),
      ].filter((date): date is Date => date !== undefined);
      if (dates.length === 0)
        throw new Error(`Chromium Dash has no stable date for milestone ${milestone}`);
      return new Date(Math.min(...dates.map((date) => date.getTime())));
    },
  };
}

/** The live sources: the pin from this checkout, the schedule from Chromium Dash. */
export const liveSources: ChromiumAgeSources = {
  pinned: () => readPinnedVersion(readFileSync(PIN_FILE, 'utf8')),
  ...dashSchedule(fetchJson),
};

async function main(): Promise<void> {
  let age: ChromiumAge;
  try {
    age = await measureChromiumAge(liveSources, new Date());
  } catch (error) {
    console.error(`Could not measure the fallback Chromium's age: ${(error as Error).message}`);
    process.exitCode = 2;
    return;
  }
  const line = `Fallback Chromium ${age.pinned}, stable is ${age.stableMilestone}: ${age.daysBehind} days behind (limit ${MAX_DAYS_BEHIND}).`;
  if (age.ok) {
    console.log(`OK. ${line}`);
    return;
  }
  console.error(`STOP. ${line} Bump Playwright so the pin moves before releasing (DOR-3876).`);
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
