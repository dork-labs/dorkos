/**
 * An agent computer's own DorkOS Cloud instance key (DOR-2940,
 * `specs/everything-is-a-space/design-agent-computers.md` §5).
 *
 * It is the only credential the computer holds: it reads the computer's
 * assignment (link code included), and it mints the computer's own model
 * tokens (`POST /v1/inference/tokens`), which the service caps per computer
 * and per account. Whoever holds it can spend the account's credits.
 *
 * ## Where it comes from: a file, never the environment
 *
 * Cloud mounts the key in a file and names the file in
 * `DORKOS_AGENT_COMPUTER_INSTANCE_KEY_FILE`. A process's starting environment
 * stays readable for its whole life (`/proc/<pid>/environ` on Linux) even
 * after `process.env` forgets it, so a key handed over that way could not be
 * kept from anything else on the machine. {@link loadAgentComputerInstanceKey}
 * runs first in an agent computer's startup and refuses to start, with a
 * fixed sentence, when:
 *
 * - `DORKOS_AGENT_COMPUTER_INSTANCE_KEY` is set at all (an image that still
 *   passes the key in the environment fails loudly rather than half-working);
 * - the `_FILE` path is missing or not absolute;
 * - it is not a regular file (opened with `O_NOFOLLOW`, so a symbolic link is
 *   refused, and checked on the open file, so it cannot be swapped between
 *   the check and the read; `O_NONBLOCK`, so a FIFO cannot hang the boot);
 * - group or others may read or write it (`mode & 0o077`);
 * - it is not owned by the user this server runs as;
 * - the key in it is shorter than 16 characters, after one trailing newline
 *   is dropped.
 *
 * The key then waits in a process-wide slot under
 * `Symbol.for('dorkos.env.agentComputerInstanceKey')`, the one place every
 * reader of it looks. Both variable names are removed from `process.env` the
 * moment this module loads, so no child process this server starts learns
 * either the key or where it lives.
 *
 * ## What the computer's image must provide
 *
 * - **Two users.** The DorkOS server runs as one user; agents, their
 *   terminals, their tools and the OpenCode sidecar that runs those tools run
 *   as another, which can neither read the key file, nor signal the server,
 *   nor ptrace it. The checks above only prove the file is the server's own;
 *   the user split is what keeps an agent from reading it. **Not built yet:**
 *   DorkOS starts the OpenCode sidecar and terminals as its own user today,
 *   so the image needs a launcher that starts them as the agents' user. Until
 *   it has one, an agent's tool runs as the server's user and can read the
 *   key file.
 * - **The key file** at mode 0600, owned by the server's user.
 * - Optional hardening: `/proc` mounted with `hidepid=2`.
 *
 * The key is never written anywhere else, never logged and never sent
 * anywhere but the Cloud API.
 *
 * @module services/core/agent-computer/instance-key
 */
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isAgentComputer } from '../server-role/role-checks.js';

/** The variable an agent computer must never be given. */
export const AGENT_COMPUTER_INSTANCE_KEY_NAME = 'DORKOS_AGENT_COMPUTER_INSTANCE_KEY';

/** The variable naming the file the key is in. */
export const AGENT_COMPUTER_INSTANCE_KEY_FILE_NAME = 'DORKOS_AGENT_COMPUTER_INSTANCE_KEY_FILE';

/** The shortest key the contract allows (`packages/cloud-api/src/hubs.ts`). */
const MIN_KEY_LENGTH = 16;

const KEY_SLOT = Symbol.for('dorkos.env.agentComputerInstanceKey');
const kept = globalThis as typeof globalThis & { [KEY_SLOT]?: string };

/** What the environment said at load, before both names were removed from it. */
export interface AgentComputerKeySource {
  /** Whether `DORKOS_AGENT_COMPUTER_INSTANCE_KEY` was set at all. */
  readonly keyInEnvironment: boolean;
  /** The `_FILE` path, as given, or `undefined`. */
  readonly keyFile: string | undefined;
}

/* eslint-disable no-restricted-syntax -- both names leave the environment at load, so no child process learns them (see the module doc) */
const fromEnvironment: AgentComputerKeySource = {
  keyInEnvironment: process.env[AGENT_COMPUTER_INSTANCE_KEY_NAME] !== undefined,
  keyFile: process.env[AGENT_COMPUTER_INSTANCE_KEY_FILE_NAME],
};
delete process.env[AGENT_COMPUTER_INSTANCE_KEY_NAME];
delete process.env[AGENT_COMPUTER_INSTANCE_KEY_FILE_NAME];
/* eslint-enable no-restricted-syntax */

/** Why an agent computer refused to start over its key. */
export type AgentComputerKeyProblem =
  | 'key-in-environment'
  | 'no-file'
  | 'relative-path'
  | 'not-a-file'
  | 'open-to-others'
  | 'wrong-owner'
  | 'too-short';

/** The fixed sentence for each problem. Names no path and no key. */
const PROBLEM_SENTENCES: Record<AgentComputerKeyProblem, string> = {
  'key-in-environment': `${AGENT_COMPUTER_INSTANCE_KEY_NAME} must not be set on an agent computer. Mount the key in a file and name it in ${AGENT_COMPUTER_INSTANCE_KEY_FILE_NAME}.`,
  'no-file': `${AGENT_COMPUTER_INSTANCE_KEY_FILE_NAME} is not set, or names no file.`,
  'relative-path': `${AGENT_COMPUTER_INSTANCE_KEY_FILE_NAME} must be an absolute path.`,
  'not-a-file': `${AGENT_COMPUTER_INSTANCE_KEY_FILE_NAME} must name a regular file, not a link or a folder.`,
  'open-to-others': `The instance key file must not be readable or writable by group or others (mode 0600).`,
  'wrong-owner': `The instance key file must be owned by the user this server runs as.`,
  'too-short': `The instance key file must hold a key of at least ${MIN_KEY_LENGTH} characters.`,
};

/** An agent computer's key is missing or unsafe, so the server does not start. */
export class AgentComputerKeyError extends Error {
  /**
   * Build the refusal.
   *
   * @param problem - What was wrong.
   */
  constructor(readonly problem: AgentComputerKeyProblem) {
    super(PROBLEM_SENTENCES[problem]);
    this.name = 'AgentComputerKeyError';
  }
}

/** The error code of a failed open, if any. */
function codeOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

/**
 * Read and check an agent computer's key, and put it in the slot. Runs first
 * in an agent computer's startup; a throw fails the boot, and the server
 * exits non-zero. Does nothing on any other role.
 *
 * @param source - What the environment said; the real one unless a test replaces it.
 * @param uid - The user this server runs as.
 * @throws {AgentComputerKeyError} When the key is missing or unsafe.
 */
export function loadAgentComputerInstanceKey(
  source: AgentComputerKeySource = fromEnvironment,
  uid: number | undefined = process.getuid?.()
): void {
  if (!isAgentComputer()) return;
  if (source.keyInEnvironment) throw new AgentComputerKeyError('key-in-environment');
  const file = source.keyFile?.trim();
  if (!file) throw new AgentComputerKeyError('no-file');
  if (!path.isAbsolute(file)) throw new AgentComputerKeyError('relative-path');
  let fd: number;
  try {
    // O_NONBLOCK so a FIFO at the path cannot hang the boot; it is refused below.
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    throw new AgentComputerKeyError(codeOf(err) === 'ENOENT' ? 'no-file' : 'not-a-file');
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new AgentComputerKeyError('not-a-file');
    if ((stat.mode & 0o077) !== 0) throw new AgentComputerKeyError('open-to-others');
    if (uid === undefined || stat.uid !== uid) throw new AgentComputerKeyError('wrong-owner');
    const key = readFileSync(fd, 'utf8').replace(/\r?\n$/, '');
    if (key.length < MIN_KEY_LENGTH) throw new AgentComputerKeyError('too-short');
    kept[KEY_SLOT] = key;
  } finally {
    closeSync(fd);
  }
}

/**
 * This agent computer's own instance key, or `null` on any other role, or
 * before {@link loadAgentComputerInstanceKey} has put one in the slot. Never
 * reads the account link a person's computer keeps: an agent computer pays
 * only with its own key.
 */
export function agentComputerInstanceKey(): string | null {
  if (!isAgentComputer()) return null;
  const key = kept[KEY_SLOT]?.trim();
  return key && key.length >= MIN_KEY_LENGTH ? key : null;
}

/**
 * Replace the kept key. Test seam only: production fills it through
 * {@link loadAgentComputerInstanceKey}.
 *
 * @param key - The key to keep, or `undefined` to forget it.
 * @internal
 */
export function __setAgentComputerInstanceKeyForTests(key: string | undefined): void {
  if (key === undefined) delete kept[KEY_SLOT];
  else kept[KEY_SLOT] = key;
}
