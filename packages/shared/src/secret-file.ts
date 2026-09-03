/**
 * First-writer-wins creation of a machine-managed secret file.
 *
 * Every secret DorkOS manages for itself — the Better Auth signing secret, the
 * local MCP token, a community credential, the `host.key` that encrypts
 * extension secrets — follows one shape: read the file if it is there,
 * otherwise mint a random value and persist it `0600`. Written the obvious way
 * (`existsSync` or a failed read, then a plain write) that shape has a
 * time-of-check/time-of-use hole, and it is the one file where the hole is
 * unrecoverable: two processes reaching a fresh data directory at the same
 * moment — a server plus a CLI command, a dev server plus the dogfood app, two
 * processes in a test — both see nothing, both mint, and the last write wins.
 * The loser keeps its own value in memory for that whole run, so everything it
 * encrypted or signed is derived from a key no longer on disk. Nothing reports
 * it; decryption simply starts failing later (DOR-712).
 *
 * The fix is to make creation itself the claim. `O_EXCL` (Node's `wx` flag)
 * fails with `EEXIST` when the file already exists, so exactly one racer
 * creates it and every other racer reads the winner's value and adopts it —
 * the same idiom the instance lock uses to claim a data directory
 * (`apps/server/src/lib/instance-lock.ts`).
 *
 * Deliberately synchronous: every caller resolves its secret on the boot path,
 * before anything it protects can be used, and the atomicity lives in the
 * kernel's `open(2)` rather than in any in-process lock — so unlike
 * {@link module:shared/atomic-write}, this holds across processes.
 *
 * @module shared/secret-file
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Backoff, in milliseconds, between attempts to read the winner's value after
 * losing the race.
 *
 * The winner creates the file and writes its bytes as two steps, so a loser
 * that reads in between sees an empty file. That window is microseconds wide
 * and the retries cover it many times over; a file still empty after all of
 * them is not a race, it is a truncated leftover from a crashed write, and the
 * caller's own value is adopted instead.
 */
const ADOPT_RETRY_DELAYS_MS = [1, 2, 5, 10, 25];

/** The outcome of a claim: the value in force, and who put it there. */
export interface SecretFileClaim<T> {
  /**
   * The value every process ends up agreeing on — this caller's own when it
   * created the file, the winner's when it did not.
   */
  value: T;
  /**
   * `true` when THIS caller created the file. Callers log the first-boot
   * "generated a secret" line only when it is set, so losing the race stays
   * quiet rather than announcing a value that was thrown away.
   */
  minted: boolean;
}

/**
 * Block the calling thread for `ms`.
 *
 * The claim is synchronous by design (see the module note), so the retry that
 * covers the winner's create-then-write window cannot await a timer. `Atomics.wait`
 * on a throwaway buffer is the only sleep that does not spin a CPU core.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read the winner's bytes, retrying while the file is still blank.
 *
 * Returns `null` when the file is readable but holds nothing usable after the
 * last retry, or has vanished — in both cases the caller is free to take it
 * over. Any other read failure is rethrown rather than reported as blank: a
 * file another account owns is unreadable here but is somebody's live secret,
 * and overwriting it would be the very loss this module exists to prevent.
 */
function readWinner(filePath: string, isUsable: (bytes: Buffer) => boolean): Buffer | null {
  for (let attempt = 0; attempt <= ADOPT_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) sleepSync(ADOPT_RETRY_DELAYS_MS[attempt - 1]!);
    try {
      const bytes = readFileSync(filePath);
      if (isUsable(bytes)) return bytes;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return null;
}

/**
 * Create `filePath` holding `contents`, or adopt what a racing process already
 * put there.
 *
 * @param filePath - Absolute path to the secret file. Parent directories are created.
 * @param contents - The value this caller would mint, used only if it wins.
 * @param mode - Permission bits for the file, re-asserted after the write
 *   because the process umask can clear bits from a create-time mode.
 * @param isUsable - Whether bytes read back count as a real secret; anything
 *   else is treated as a truncated leftover and overwritten.
 */
function claim(
  filePath: string,
  contents: Buffer,
  mode: number,
  isUsable: (bytes: Buffer) => boolean
): SecretFileClaim<Buffer> {
  mkdirSync(dirname(filePath), { recursive: true });

  try {
    // 'wx' fails when the file exists, which makes the mint atomic against
    // another process minting the same secret at the same moment.
    writeFileSync(filePath, contents, { flag: 'wx', mode });
    chmodSync(filePath, mode);
    return { value: contents, minted: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  const winner = readWinner(filePath, isUsable);
  if (winner) return { value: winner, minted: false };

  // Readable and blank: a create that died between the open and its content.
  // Nothing can have been encrypted or signed with an empty secret, so take the
  // file over. This last write is a plain one — two processes finding the same
  // blank file could still both take it over, which is the one interleave this
  // module does not close, and it can only happen after a crashed mint.
  writeFileSync(filePath, contents, { mode });
  chmodSync(filePath, mode);
  return { value: contents, minted: true };
}

/**
 * Claim a secret file holding raw bytes, first writer wins.
 *
 * @param filePath - Absolute path to the secret file. Parent directories are created.
 * @param contents - The bytes this caller would mint, used only if it wins.
 * @param mode - Permission bits for the file (`0o600` for every secret today).
 * @returns The bytes now in force, and whether this caller created the file.
 */
export function claimSecretBytes(
  filePath: string,
  contents: Buffer,
  mode: number
): SecretFileClaim<Buffer> {
  return claim(filePath, contents, mode, (bytes) => bytes.length > 0);
}

/**
 * Claim a secret file holding text, first writer wins.
 *
 * The text counterpart of {@link claimSecretBytes}: the value read back is
 * trimmed, and a file holding only whitespace counts as empty — the same
 * "blank means unset" rule every text secret in this repo already applies on
 * the read path. `contents` is trimmed before it is written, so the winner and
 * every adopter hold a byte-identical string.
 *
 * @param filePath - Absolute path to the secret file. Parent directories are created.
 * @param contents - The text this caller would mint, used only if it wins.
 * @param mode - Permission bits for the file (`0o600` for every secret today).
 * @returns The text now in force, and whether this caller created the file.
 * @throws If `contents` is blank — a secret nobody can tell from an unset one is
 *   a caller bug, and persisting it would make every later boot mint again.
 */
export function claimSecretText(
  filePath: string,
  contents: string,
  mode: number
): SecretFileClaim<string> {
  const text = contents.trim();
  if (!text) throw new Error(`Refusing to claim '${filePath}' with a blank secret.`);

  const claimed = claim(filePath, Buffer.from(text, 'utf8'), mode, (bytes) =>
    Boolean(bytes.toString('utf8').trim())
  );
  return {
    value: claimed.minted ? text : claimed.value.toString('utf8').trim(),
    minted: claimed.minted,
  };
}
