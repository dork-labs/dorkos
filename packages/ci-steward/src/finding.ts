/**
 * One problem a check found, written for the agent that has to fix it.
 *
 * Every finding names the file, the place inside it, what is wrong in plain
 * words, and the exact fix. A finding that only says "invalid" sends the reader
 * off to reverse-engineer the checker; these are the whole instruction.
 */
export interface Finding {
  /** Stable machine code, e.g. `deadlock/paths-filter`. Tests match on it. */
  code: string;
  /** Repo-relative path of the file to edit. */
  file: string;
  /** Where inside the file (a job, a step, a gate id, a ledger field), when that helps. */
  where?: string;
  /** What is wrong and why it matters. */
  message: string;
  /** The exact change that clears it. */
  fix: string;
}

/**
 * Render findings as the block a CI log or a terminal shows.
 *
 * @param tool - The subcommand name, used as the heading (`census`, `ledger-check`).
 * @param findings - What the check found; empty means it passed.
 */
export function formatFindings(tool: string, findings: readonly Finding[]): string {
  if (findings.length === 0) return `ci-steward ${tool}: ok\n`;
  const lines: string[] = [];
  for (const f of findings) {
    lines.push(`FAIL [${f.code}] ${f.file}${f.where ? ` (${f.where})` : ''}`);
    lines.push(`  ${f.message}`);
    lines.push(`  Fix: ${f.fix}`);
    lines.push('');
  }
  const noun = findings.length === 1 ? 'problem' : 'problems';
  lines.push(`ci-steward ${tool}: ${findings.length} ${noun}`);
  return lines.join('\n') + '\n';
}
