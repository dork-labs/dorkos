import type { FullResult, TestCase } from '@playwright/test/reporter';

/**
 * Puts the webServer legs' own output in the CI log, and times each leg's boot.
 *
 * WHY THIS EXISTS (DOR-2360). Every leg in `playwright.config.ts` sets
 * `stdout: 'pipe'`, which reads like "show me this leg's output" and in CI
 * showed nothing at all. Playwright hands piped leg output to the REPORTERS
 * (`reporter.onStdOut`, with no test attached), and CI's reporters are html,
 * json, github and this package's own: none of them prints output that belongs
 * to no test. Playwright would fall back to its `dot` reporter, which does, only
 * if no configured reporter claimed stdio, and `manifest-reporter.ts` claims it
 * by not saying otherwise. Playwright's wrapper for a v1 reporter also holds leg
 * output back until `onBegin`, which a run whose leg times out never reaches.
 * So when the marketing-site leg stalled, the log said `Timed out waiting 242000ms from config.webServer.`
 * after seven silent minutes, and nothing else.
 *
 * WHAT IT DOES. It is a v2 reporter (`version()` below), so it receives leg
 * output as it happens. Until the tests begin it prints every line, prefixed
 * `[<leg name>]` by Playwright, and GitHub stamps each one with the time it
 * arrived — so the next stall shows which leg, what it last said, and when. At
 * `onBegin`, or at the error when a leg never came up, it prints one line with
 * each leg's first output relative to the start of the run. The legs start one
 * after another (Playwright sets them up in order), so the gap between two
 * legs' first lines approximates the earlier leg's boot time (a leg that is
 * silent for a while after it starts makes it an underestimate): the per-leg
 * measurement the readiness timeouts were never set from.
 *
 * Each leg prints at most {@link LIVE_LINES} lines live, then one line saying
 * how many it held back; the tail still keeps the latest of them.
 *
 * AFTER THE BOOT it stops printing, because three Express servers and two Vite
 * servers logging every request of a 90-test shard would bury the report. It
 * keeps the last {@link TAIL_LINES} lines of each leg instead, and prints them
 * only when the run did not pass, which is when somebody will read them.
 */
export default class WebServerLegsReporter {
  private readonly started = Date.now();
  private readonly legs = new Map<string, LegRecord>();
  private began = false;
  private summarised = false;

  /** Marks this as a v2 reporter, so leg output arrives live instead of held until `onBegin`. */
  version(): 'v2' {
    return 'v2';
  }

  /**
   * Declines to count as the run's stdio reporter. It prints only leg output and
   * one summary line, so it must not stop Playwright choosing a real one.
   */
  printsToStdio(): boolean {
    return false;
  }

  /**
   * Leg output. Output that belongs to a test is the test's own and is left alone.
   *
   * @param chunk - The output.
   * @param test - The test it belongs to, if any.
   */
  onStdOut(chunk: string | Buffer, test?: TestCase): void {
    if (!test) this.take(chunk.toString(), process.stdout);
  }

  /**
   * Leg stderr, and the readiness probe's own complaints.
   *
   * @param chunk - The output.
   * @param test - The test it belongs to, if any.
   */
  onStdErr(chunk: string | Buffer, test?: TestCase): void {
    if (!test) this.take(chunk.toString(), process.stderr);
  }

  /** Every leg answered and global setup finished: print the boot timings and go quiet. */
  onBegin(): void {
    this.began = true;
    // `--list` and a config with no legs reach here with nothing to report.
    if (this.legs.size > 0) this.summarise('every webServer leg answered; tests begin');
  }

  /** A leg that never came up fails the run before `onBegin`; say how far each one got. */
  onError(): void {
    if (!this.began) this.summarise('the boot failed');
  }

  /**
   * On a failed run, print what each leg said last (after a failed boot, only
   * for a leg whose live output was cut off).
   *
   * @param result - The run's result.
   */
  onEnd(result: FullResult): void {
    if (!this.began) this.summarise('the boot failed');
    if (result.status === 'passed') return;
    for (const [name, leg] of this.legs) {
      // A failed boot already printed everything up to LIVE_LINES live.
      if (leg.tail.length === 0 || (!this.began && leg.lines <= LIVE_LINES)) continue;
      console.log(`webServer leg "${name}": its last ${leg.tail.length} line(s) of output`);
      for (const line of leg.tail) console.log(`  ${line}`);
    }
  }

  private take(text: string, stream: NodeJS.WriteStream): void {
    const now = Date.now();
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      const name = legName(line);
      const leg = this.legs.get(name) ?? { first: now, last: now, lines: 0, tail: [] };
      leg.last = now;
      leg.lines += 1;
      leg.tail.push(line);
      if (leg.tail.length > TAIL_LINES) leg.tail.shift();
      this.legs.set(name, leg);
      if (this.began) continue;
      if (leg.lines <= LIVE_LINES) stream.write(`${line}\n`);
      else if (leg.lines === LIVE_LINES + 1)
        stream.write(
          `[${name}] … more output held back; its last ${TAIL_LINES} lines print if the run fails\n`
        );
    }
  }

  private summarise(what: string): void {
    if (this.summarised) return;
    this.summarised = true;
    const at = (ms: number) => `+${Math.round((ms - this.started) / 1000)}s`;
    const legs = [...this.legs].map(
      ([name, leg]) => `${name} first ${at(leg.first)}, last ${at(leg.last)}, ${leg.lines} line(s)`
    );
    console.log(
      `webServer legs, ${what} at ${at(Date.now())}: ${legs.length ? legs.join('; ') : 'no leg printed anything'}`
    );
  }
}

/** Lines of each leg's output printed live during the boot, before the rest is held back. */
export const LIVE_LINES = 150;

/** Lines of each leg's output kept for a failed run. */
export const TAIL_LINES = 40;

/** What the reporter remembers about one leg. */
interface LegRecord {
  /** When its first line arrived (ms since epoch). */
  first: number;
  /** When its latest line arrived. */
  last: number;
  /** How many lines it has printed. */
  lines: number;
  /** Its last {@link TAIL_LINES} lines. */
  tail: string[];
}

/**
 * The leg a line came from: Playwright prefixes every piped line with
 * `[<name>] ` (dimmed, so ANSI codes may wrap it). A line with no prefix is the
 * readiness probe reporting on a leg, or other runner output, and is grouped
 * under `runner`.
 *
 * @param line - One line of leg output.
 * @internal Exported for testing only.
 */
export function legName(line: string): string {
  // eslint-disable-next-line no-control-regex -- the prefix is wrapped in ANSI dim codes
  const match = /^(?:\x1b\[[0-9;]*m)*\[([^\]]+)\] /.exec(line);
  return match ? match[1]! : 'runner';
}
