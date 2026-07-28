/**
 * Canary accounting for the Q3 contention harness (DOR-500).
 *
 * Each `q3-*` agent appends lines to a shared canary file with a deliberately
 * non-atomic read-modify-write. This module counts what survived and compares
 * it to what every agent said it wrote.
 *
 * THE CANARY IS AN INTERLEAVE DETECTOR, NOT A CORRUPTION METER. A shortfall
 * proves concurrent whole-file rewrites interleaved and clobbered each other.
 * It is NOT the data loss real agent tooling would suffer — a writer using
 * temp-file-plus-atomic-rename (ADR-0304's install transaction, for one) loses
 * NOTHING on this workload. {@link CANARY_METHOD} and {@link CANARY_CAVEAT}
 * ride on every {@link CanaryReport} so the caveat reaches `summary.json`
 * alongside the number, and cannot be quoted apart from it. Design of record:
 * `research/20260725_q3-contention-preregistration.md`.
 *
 * It reports; it does not interpret. Whether "17 lines missing" means the
 * working tree collides first is a question for whoever reads the numbers, not
 * for this file.
 *
 * Pure by design — the caller supplies the file's text — so the accounting is
 * testable without a run.
 *
 * @module scripts/q3-contention/canary
 */

/** How the numbers in a {@link CanaryReport} were produced. */
export const CANARY_METHOD =
  'Each agent repeatedly read the whole shared file, appended one tagged line, and wrote the whole file back — no append mode, no lock, no atomic rename.';

/** The interpretation limit that must travel with every canary number. */
export const CANARY_CAVEAT =
  'Interleave detector, NOT a corruption rate. A shortfall proves concurrent whole-file rewrites clobbered each other; a writer using atomic temp-file-plus-rename loses nothing on this same workload. Do not quote these numbers as data loss for real agent tooling. See research/20260725_q3-contention-preregistration.md.';

/** One parsed canary line: `<vocab> <seq> <iso>`. */
export interface CanaryLine {
  readonly vocab: string;
  readonly seq: number;
}

/** Per-vocabulary survival counts within one canary file. */
export interface CanaryVocabStats {
  /** Distinct sequence numbers present. */
  readonly survived: number;
  /** Lines the agent reported writing (`appends=` from its summary). */
  readonly reported: number;
  /** `reported - survived`; positive means lost updates. */
  readonly missing: number;
  /** Highest sequence number present, or -1 when nothing survived. */
  readonly maxSeq: number;
  /** Lines whose (vocab, seq) pair appears more than once. */
  readonly duplicates: number;
}

/** The full accounting for one canary file. */
export interface CanaryReport {
  /** Absolute path of the canary. */
  readonly path: string;
  /** Well-formed lines found, counting duplicates. */
  readonly totalLines: number;
  /** Distinct (vocab, seq) pairs found — the survivor count `missingTotal` uses. */
  readonly survivedTotal: number;
  /** Lines that did not parse — the signature of a torn concurrent write. */
  readonly malformedLines: number;
  /** Sum of every agent's reported `appends` for this file. */
  readonly reportedTotal: number;
  /**
   * `reportedTotal - survivedTotal`; positive means writes were interleaved
   * away. Derived from DISTINCT survivors, the same basis as every per-vocab
   * `missing`, so the total and the breakdown always agree even when a
   * duplicated line inflates `totalLines`.
   */
  readonly missingTotal: number;
  /** Per-vocabulary breakdown, including vocabularies with zero survivors. */
  readonly byVocab: Readonly<Record<string, CanaryVocabStats>>;
  /** {@link CANARY_METHOD}, carried so `summary.json` records how this was produced. */
  readonly method: string;
  /** {@link CANARY_CAVEAT}, carried so the number can never be quoted without it. */
  readonly caveat: string;
}

const LINE_PATTERN = /^([a-z]+) (\d+) (\S+)$/;

/**
 * Parse a canary file's text into well-formed lines plus a malformed count.
 *
 * @param text - Full contents of the canary file.
 * @returns The parsed lines in file order and the count that failed to parse.
 */
export function parseCanary(text: string): { lines: CanaryLine[]; malformed: number } {
  const lines: CanaryLine[] = [];
  let malformed = 0;
  for (const raw of text.split('\n')) {
    if (raw === '') continue;
    const match = LINE_PATTERN.exec(raw);
    if (!match) {
      malformed++;
      continue;
    }
    lines.push({ vocab: match[1]!, seq: Number(match[2]) });
  }
  return { lines, malformed };
}

/**
 * Build the survival report for one canary file.
 *
 * @param canaryPath - Absolute path of the canary (echoed into the report).
 * @param text - Full contents of the canary file.
 * @param reportedByVocab - Each agent's self-reported append count, by vocabulary.
 * @returns Counts of what survived versus what was written.
 */
export function buildCanaryReport(
  canaryPath: string,
  text: string,
  reportedByVocab: Readonly<Record<string, number>>
): CanaryReport {
  const { lines, malformed } = parseCanary(text);

  const seenByVocab = new Map<string, Map<number, number>>();
  for (const line of lines) {
    const seqs = seenByVocab.get(line.vocab) ?? new Map<number, number>();
    seqs.set(line.seq, (seqs.get(line.seq) ?? 0) + 1);
    seenByVocab.set(line.vocab, seqs);
  }

  const vocabs = new Set([...Object.keys(reportedByVocab), ...seenByVocab.keys()]);
  const byVocab: Record<string, CanaryVocabStats> = {};
  let survivedTotal = 0;
  for (const vocab of vocabs) {
    const seqs = seenByVocab.get(vocab) ?? new Map<number, number>();
    const survived = seqs.size;
    survivedTotal += survived;
    const reported = reportedByVocab[vocab] ?? 0;
    let duplicates = 0;
    for (const count of seqs.values()) duplicates += count - 1;
    byVocab[vocab] = {
      survived,
      reported,
      missing: reported - survived,
      maxSeq: seqs.size === 0 ? -1 : Math.max(...seqs.keys()),
      duplicates,
    };
  }

  const reportedTotal = Object.values(reportedByVocab).reduce((sum, n) => sum + n, 0);
  return {
    path: canaryPath,
    totalLines: lines.length,
    survivedTotal,
    malformedLines: malformed,
    reportedTotal,
    // Distinct survivors, matching every per-vocab `missing`. Using the raw
    // line count here would disagree with the breakdown whenever a duplicate
    // appears — and duplicates are exactly what a contended run produces.
    missingTotal: reportedTotal - survivedTotal,
    byVocab,
    method: CANARY_METHOD,
    caveat: CANARY_CAVEAT,
  };
}
