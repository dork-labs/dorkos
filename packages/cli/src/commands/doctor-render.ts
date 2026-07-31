/**
 * The checklist renderer shared by `dorkos doctor` and `pnpm doctor:dev`.
 *
 * One list of {@link CheckResult}s in, one calm report out — glyphs, dimmed
 * detail, a fix line where there is something to do, and a closing summary. The
 * exit-code rule lives here too, because it is part of what the checklist
 * means: only a `fail` is worth a non-zero exit.
 *
 * @module commands/doctor-render
 */
import type { CheckResult } from '@dorkos/shared/health-schemas';

/** ANSI colors, used directly (the CLI has no color dependency). */
const COLOR = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
} as const;

/** Glyph + color per status. */
const GLYPH: Record<CheckResult['status'], { symbol: string; color: string }> = {
  pass: { symbol: '✔', color: COLOR.green },
  warn: { symbol: '⚠', color: COLOR.yellow },
  fail: { symbol: '✖', color: COLOR.red },
  info: { symbol: '•', color: COLOR.dim },
};

/**
 * Print a whole checklist: a heading, one line per check, then the summary.
 *
 * @param heading - The line printed above the checklist.
 * @param results - The checks, in the order they should be read.
 */
export function printChecklist(heading: string, results: readonly CheckResult[]): void {
  console.log(`\n${heading}\n`);
  for (const result of results) {
    printResult(result);
  }
  printSummary(results);
}

/** Print one checklist line, with dimmed detail and a fix hint when relevant. */
export function printResult(result: CheckResult): void {
  const { symbol, color } = GLYPH[result.status];
  console.log(`  ${color}${symbol}${COLOR.reset} ${result.label}`);
  if (result.detail) {
    console.log(`    ${COLOR.dim}${result.detail}${COLOR.reset}`);
  }
  if (result.fix && (result.status === 'warn' || result.status === 'fail')) {
    for (const line of result.fix.split('\n')) {
      console.log(`    ${COLOR.dim}${line}${COLOR.reset}`);
    }
  }
}

/** Print the closing one-line summary. */
export function printSummary(results: readonly CheckResult[]): void {
  const failures = results.filter((r) => r.status === 'fail').length;
  const warnings = results.filter((r) => r.status === 'warn').length;
  console.log('');
  if (failures > 0) {
    console.log(
      `  ${COLOR.red}${failures} ${plural(failures, 'thing needs', 'things need')} fixing before DorkOS runs right.${COLOR.reset}`
    );
  } else if (warnings > 0) {
    console.log(
      `  ${COLOR.yellow}Ready to run. ${warnings} ${plural(warnings, 'note', 'notes')} worth a look above.${COLOR.reset}`
    );
  } else {
    console.log(`  ${COLOR.green}Everything looks good.${COLOR.reset}`);
  }
  console.log('');
}

/**
 * The exit code a checklist implies: `1` when something is genuinely broken,
 * `0` for warnings and notes.
 *
 * @param results - The checks that ran.
 * @returns The intended process exit code.
 */
export function exitCodeFor(results: readonly CheckResult[]): number {
  return results.some((r) => r.status === 'fail') ? 1 : 0;
}

/** Singular/plural helper for the summary line. */
function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
