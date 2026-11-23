/**
 * The QA-GO gate (DOR-5050): a release is tagged and published only at the
 * exact tree QA said GO on. QA keeps an append-only ledger of verdicts, one
 * markdown table row each, later rows superseding earlier ones (release rule
 * 00, PM 2026-10-30). The tag step and the publish step both call
 * {@link checkQaGo} themselves, so the gate no longer depends on a release
 * lane remembering to run it.
 *
 * The ledger lives outside this repo, on the machine that releases, so its
 * path is always named explicitly ({@link qaGoLedgerPath}): there is no
 * default, and a missing, unreadable or empty ledger refuses. Node builtins
 * and git only.
 *
 * A row passes only when it is the LAST row for the version, its verdict
 * starts with GO and holds none of {@link NOT_A_GO}, it names a full 40-hex
 * SHA, it names a rows file that exists inside the ledger's own `evidence/`
 * folder, and that SHA's tree equals the target commit's tree.
 *
 * Trust model: this proves "the target's tree matches a GO row in this ledger
 * file". It does not prove who wrote the row; the ledger is a file on the
 * releasing machine, and the PASS line names it so the release records which
 * ledger vouched for it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';

/** The variable that names the ledger when no `--qa-go-ledger` flag does. */
export const QA_GO_LEDGER_ENV = 'DORKOS_QA_GO_LEDGER';

/** The ledger's file name; it always sits in QA's `evidence/` folder. */
export const QA_GO_LEDGER_NAME = 'GO-LEDGER.md';

/** Words that make a GO row something less than a GO. */
export const NOT_A_GO = ['NO-GO', 'PENDING', 'NOT verified', 'reported'] as const;

/** One verdict row of QA's ledger, as its cells read. */
export interface QaGoRow {
  /** When QA wrote it. */
  time: string;
  /** The version cell, e.g. `0.141.0` or `0.141.0 (candidate)`. */
  version: string;
  /** The SHA cell, as written. */
  sha: string;
  /** The verdict cell, with markdown bold removed. */
  verdict: string;
  /** The rows-file cell, as written. */
  rows: string;
}

/** A refusal to tag or publish, naming the version and the SHA it was asked about. */
export class QaGoRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QaGoRefusal';
  }
}

/**
 * The last ledger row for `version`: rows whose version cell is the version,
 * or starts with it and a space. `undefined` when there is none.
 *
 * @param ledger - The ledger's text.
 * @param version - The release version, `X.Y.Z`.
 */
export function lastQaGoRow(ledger: string, version: string): QaGoRow | undefined {
  const rows = ledger
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim())
    )
    .filter((cells) => cells[1] === version || (cells[1] ?? '').startsWith(version + ' '));
  // Matched on the version alone, so a short row still supersedes the rows above it and,
  // with its missing cells empty, refuses rather than letting an older GO win.
  const last = rows.at(-1);
  if (!last) return undefined;
  return {
    time: last[0] ?? '',
    version: last[1] ?? '',
    sha: last[2] ?? '',
    verdict: (last[4] ?? '').replaceAll('*', ''),
    rows: last[6] ?? '',
  };
}

/** The full SHA a row names, or `undefined` when it names none. */
export function qaGoSha(row: QaGoRow): string | undefined {
  return /\b[0-9a-f]{40}\b/.exec(row.sha)?.[0];
}

/** The `evidence/...` path a row's rows cell names, or `undefined` when it names none. */
export function qaGoRowsPath(row: QaGoRow): string | undefined {
  return /evidence\/[^ (,;]+/.exec(row.rows)?.[0].replace(/[.:]*$/, '');
}

/**
 * Why `row` is not a GO QA can be held to, or `undefined` when it is one. Pure:
 * the tree comparison is {@link checkQaGo}'s.
 *
 * @param row - The last ledger row for the version.
 * @param rowsExist - Whether a rows path exists under QA's folder.
 */
export function qaGoRowRefusal(
  row: QaGoRow,
  rowsExist: (path: string) => boolean
): string | undefined {
  if (!row.verdict.startsWith('GO')) return `its verdict is not GO ("${row.verdict}")`;
  const bad = NOT_A_GO.find((word) => row.verdict.includes(word));
  if (bad) return `its verdict says "${bad}"`;
  if (!qaGoSha(row)) return 'it names no full 40-hex SHA';
  const rows = qaGoRowsPath(row);
  if (!rows || rows.split('/').includes('..') || !rowsExist(rows))
    return `it names no rows file that exists (${row.rows})`;
  return undefined;
}

/**
 * The ledger path a release step was given: its `--qa-go-ledger <path>` flag,
 * else {@link QA_GO_LEDGER_ENV}. Refuses when neither names one.
 *
 * @param flag - The flag's value, when the step was given one.
 * @param env - The environment to read the variable from.
 */
export function qaGoLedgerPath(
  flag: string | undefined,
  env: Record<string, string | undefined> = process.env
): string {
  const path = flag ?? env[QA_GO_LEDGER_ENV];
  if (!path)
    throw new QaGoRefusal(
      `No QA GO ledger was named. Pass --qa-go-ledger <path> or set ${QA_GO_LEDGER_ENV}.`
    );
  return path;
}

/**
 * Take `--qa-go-ledger <path>` out of a step's arguments. Refuses the flag with no path.
 *
 * @param argv - The step's arguments.
 */
export function takeQaGoLedgerFlag(argv: string[]): { ledger: string | undefined; rest: string[] } {
  const at = argv.indexOf('--qa-go-ledger');
  if (at < 0) return { ledger: undefined, rest: argv };
  const ledger = argv[at + 1];
  if (!ledger || ledger.startsWith('--')) throw new QaGoRefusal('--qa-go-ledger needs a path.');
  return { ledger, rest: argv.filter((_, i) => i !== at && i !== at + 1) };
}

/** What {@link checkQaGo} checks. */
export interface QaGoCheck {
  /** QA's ledger file. */
  ledgerPath: string;
  /** The release version, `X.Y.Z`. */
  version: string;
  /** The tag or commit about to be tagged or published. */
  target: string;
  /** The repository to resolve `target` and the GO SHA in. */
  cwd: string;
}

/**
 * Pass only when QA's last row for the version is a GO for the target's exact
 * tree. Returns the PASS line; throws {@link QaGoRefusal} naming the version
 * and the target's SHA otherwise.
 *
 * @param check - The ledger, version, target and repository.
 */
export function checkQaGo(check: QaGoCheck): string {
  const { ledgerPath, version, target, cwd } = check;
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  let published: string;
  try {
    published = git('rev-parse', '--verify', `${target}^{commit}`);
  } catch {
    throw new QaGoRefusal(`No QA GO for ${version}: ${target} is not a commit here.`);
  }
  const refuse = (why: string): never => {
    throw new QaGoRefusal(
      `No QA GO for ${version} at ${published}: ${why}. Send QA ${published} and wait for a GO line in its ledger.`
    );
  };
  // QA's ledger is always <QA's folder>/evidence/GO-LEDGER.md, and its rows files sit beside
  // it, so a ledger at any other name, or a rows file that resolves outside that folder, refuses.
  let real: string;
  let ledger: string;
  try {
    real = realpathSync(ledgerPath);
    ledger = readFileSync(real, 'utf8');
  } catch {
    return refuse(`the QA ledger at ${ledgerPath} cannot be read`);
  }
  const evidence = dirname(real);
  if (basename(real) !== QA_GO_LEDGER_NAME || basename(evidence) !== 'evidence')
    return refuse(`${ledgerPath} is not a QA ledger (<QA folder>/evidence/${QA_GO_LEDGER_NAME})`);
  const row = lastQaGoRow(ledger, version);
  if (!row) return refuse('the QA ledger has no row for this version');
  const why = qaGoRowRefusal(row, (path) => {
    try {
      const real = realpathSync(join(dirname(evidence), path));
      return real.startsWith(evidence + sep);
    } catch {
      return false;
    }
  });
  if (why) return refuse(`QA's last row for it (${row.time}) is not a GO: ${why}`);
  const go = qaGoSha(row)!;
  let goTree: string;
  try {
    goTree = git('rev-parse', '--verify', `${go}^{tree}`);
  } catch {
    return refuse(`QA's GO names ${go}, which is not in this repository`);
  }
  const tree = git('rev-parse', '--verify', `${published}^{tree}`);
  if (tree !== goTree) return refuse(`its tree is not the tree QA said GO on (GO ${go})`);
  return `PASS: ${published} has QA's GO tree for ${version} (GO ${go}, rows ${qaGoRowsPath(row)}, ledger ${join(evidence, QA_GO_LEDGER_NAME)}).`;
}
