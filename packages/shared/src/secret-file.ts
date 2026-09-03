/**
 * First-writer-wins publication of a machine-managed secret file.
 *
 * Every secret DorkOS manages for itself — the Better Auth signing secret, the
 * local MCP token, a community credential, this install's VAPID keypair, the
 * `host.key` that encrypts extension secrets — follows one shape: read the file
 * if it is there, otherwise mint a random value and persist it `0600`. Written
 * the obvious way (`existsSync` or a failed read, then a plain write) that
 * shape has a time-of-check/time-of-use hole, and it is the one file where the
 * hole is unrecoverable: two processes reaching a fresh data directory at the
 * same moment — a server plus a CLI command, a dev server plus the dogfood app,
 * two processes in a test — both see nothing, both mint, and the last write
 * wins. The loser keeps its own value in memory for that whole run, so
 * everything it encrypted or signed is derived from a key no longer on disk.
 * Nothing reports it; decryption simply starts failing later (DOR-712).
 *
 * ## Why a link and not `wx`
 *
 * `O_EXCL` (Node's `wx` flag) makes the *creation* exclusive, which is most of
 * the answer but not all of it: creating the file and writing its bytes are two
 * steps, so a racer that reads in between finds the file present and EMPTY.
 * Whatever it does with that — adopt an empty secret, or decide the file is
 * junk and overwrite it — puts the original bug back, and a reviewer staging a
 * descheduled winner reproduced exactly that.
 *
 * So the content is complete before the name exists. {@link publishSecretFile}
 * writes a temp file in the destination directory, then `link(2)`s it to the
 * destination: the link is atomic, it fails with `EEXIST` when the destination
 * is taken, and the file it publishes is whole from the instant it is
 * reachable. There is no window to read, so there is no retry loop and no
 * "maybe it is still being written" guess anywhere in this module.
 *
 * A destination that exists but holds no usable secret is therefore never
 * something this module wrote. It predates this code or something else made it,
 * and {@link claimSecretBytes} / {@link claimSecretText} REFUSE it loudly rather
 * than overwriting: a secret that cannot be read is not the same as a secret
 * that is not there, and treating the second as the first is how the data is
 * lost. Callers that genuinely want to replace an unusable file (the VAPID
 * keypair authorises nothing when it does not parse) move it aside with
 * {@link quarantineSecretFile} and claim again, so even the replacement is a
 * first-writer-wins publication.
 *
 * Hard links are assumed to work in the data directory. Every filesystem DorkOS
 * can run on supports them — the same ones must support SQLite's locking — and
 * a link failure surfaces as an error rather than silently degrading to a
 * racier write.
 *
 * Deliberately synchronous: every caller resolves its secret on the boot path,
 * before anything it protects can be used, and the atomicity lives in the
 * kernel rather than in any in-process lock — so unlike
 * {@link module:shared/atomic-write}, this holds across processes.
 *
 * @module shared/secret-file
 */
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  readFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** The outcome of a claim: the value in force, and who put it there. */
export interface SecretFileClaim<T> {
  /**
   * The value every process ends up agreeing on — this caller's own when it
   * published the file, the winner's when it did not.
   */
  value: T;
  /**
   * `true` when THIS caller published the file. Callers log the first-boot
   * "generated a secret" line only when it is set, so losing the race stays
   * quiet rather than announcing a value that was thrown away.
   */
  minted: boolean;
}

/** A unique temp path beside `filePath`, so the publishing link stays in one filesystem. */
function tempPathFor(filePath: string): string {
  return join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
}

/**
 * The refusal every claim raises rather than overwriting a file it cannot use.
 *
 * Deliberately loud and terminal. A boot that stops with this message costs an
 * operator one manual step; a boot that "recovered" by minting over the file
 * costs them every secret stored under the old one, silently.
 */
function unusableSecretError(filePath: string, detail: string): Error {
  return new Error(
    `'${filePath}' exists but does not hold a usable secret (${detail}). ` +
      'DorkOS will not overwrite it: if anything was encrypted or signed with it, ' +
      'overwriting makes that unreadable forever. Move the file aside or delete it to mint a new secret.'
  );
}

/**
 * Publish `contents` at `filePath` if nothing is there yet.
 *
 * The destination is created by linking a fully-written temp file into place,
 * so it never exists holding partial content: any process that can see the
 * path can read the whole secret. The temp file is removed on every path.
 *
 * @param filePath - Absolute destination path. Parent directories are created.
 * @param contents - The complete file contents.
 * @param mode - Permission bits, applied to the temp file so the destination
 *   carries them from the instant it exists.
 * @returns `true` when this caller published the file, `false` when another
 *   writer already had.
 */
export function publishSecretFile(
  filePath: string,
  contents: Buffer | string,
  mode: number
): boolean {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = tempPathFor(filePath);
  try {
    writeFileSync(tempPath, contents, { mode });
    // The write mode is subject to the umask, so re-assert it BEFORE the link:
    // the destination shares this inode and inherits whatever it has now.
    chmodSync(tempPath, mode);
    try {
      linkSync(tempPath, filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
    return true;
  } finally {
    rmSync(tempPath, { force: true });
  }
}

/**
 * Move an unusable secret file out of the way, so a fresh one can be claimed.
 *
 * The file is renamed beside itself rather than deleted — it is somebody's data
 * even when nothing can be done with it, and a support question is answerable
 * with it on disk. Two processes doing this at once is safe: one rename wins,
 * the other finds nothing to move, and both then race to publish the
 * replacement through {@link publishSecretFile}, where only one can win.
 *
 * @param filePath - Absolute path to the file to set aside.
 * @returns Where the file was moved, or `null` when it was already gone.
 */
export function quarantineSecretFile(filePath: string): string | null {
  const quarantinePath = `${filePath}.unusable-${randomUUID()}`;
  try {
    renameSync(filePath, quarantinePath);
    return quarantinePath;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Claim a secret file holding raw bytes, first writer wins.
 *
 * A file that is already there is adopted only when it holds exactly as many
 * bytes as `contents` — every byte secret in this repo has one canonical
 * length, so a shorter file is a leftover rather than a secret, and adopting it
 * would mean deriving keys from a value nobody chose.
 *
 * @param filePath - Absolute path to the secret file. Parent directories are created.
 * @param contents - The bytes this caller would mint, used only if it wins.
 * @param mode - Permission bits for the file (`0o600` for every secret today).
 * @returns The bytes now in force, and whether this caller published them.
 * @throws If the file exists and is the wrong length, or cannot be read.
 */
export function claimSecretBytes(
  filePath: string,
  contents: Buffer,
  mode: number
): SecretFileClaim<Buffer> {
  if (publishSecretFile(filePath, contents, mode)) return { value: contents, minted: true };

  const existing = readFileSync(filePath);
  if (existing.length !== contents.length) {
    throw unusableSecretError(
      filePath,
      `expected ${contents.length} bytes, found ${existing.length}`
    );
  }
  return { value: existing, minted: false };
}

/**
 * Claim a secret file holding text, first writer wins.
 *
 * The text counterpart of {@link claimSecretBytes}: the value read back is
 * trimmed, and a file holding only whitespace is unusable — the same "blank
 * means unset" rule every text secret in this repo applies on the read path.
 * `contents` is trimmed before it is written, so the winner and every adopter
 * hold a byte-identical string. Length is NOT checked: unlike the byte secrets,
 * an operator may legitimately have written their own value here.
 *
 * @param filePath - Absolute path to the secret file. Parent directories are created.
 * @param contents - The text this caller would mint, used only if it wins.
 * @param mode - Permission bits for the file (`0o600` for every secret today).
 * @returns The text now in force, and whether this caller published it.
 * @throws If `contents` is blank — a secret nobody can tell from an unset one is
 *   a caller bug — or if the file exists and is blank or unreadable.
 */
export function claimSecretText(
  filePath: string,
  contents: string,
  mode: number
): SecretFileClaim<string> {
  const text = contents.trim();
  if (!text) throw new Error(`Refusing to claim '${filePath}' with a blank secret.`);

  if (publishSecretFile(filePath, text, mode)) return { value: text, minted: true };

  const existing = readFileSync(filePath, 'utf8').trim();
  if (!existing) throw unusableSecretError(filePath, 'the file is blank');
  return { value: existing, minted: false };
}
