/**
 * The delimiter the login-shell PATH probe wraps its answer in.
 *
 * It lives here, apart from the probe itself (`main/shell-path.ts`), because
 * three places have to agree on it and only one of them can import Electron:
 * the probe that builds the shell command, its unit tests, and
 * `scripts/smoke-packaged.ts`, which launches the packaged app against a fake
 * login shell and needs to speak the same protocol. A copy in the smoke script
 * could drift from the probe and the smoke would go quietly green against a
 * shell nobody was reading.
 *
 * Why a delimiter at all: the probe runs the user's shell *interactively*,
 * because that is the only way to see a PATH exported from `~/.zshrc` — and an
 * interactive shell prints whatever that person's rc files print, all of it on
 * the same stdout as the answer. Marking both ends is what lets the parser find
 * the PATH inside the noise.
 *
 * @module shared/login-shell-path
 */

/** Wraps the PATH the login-shell probe prints, on both sides. */
export const LOGIN_SHELL_PATH_MARKER = '__dorkos_path__';
