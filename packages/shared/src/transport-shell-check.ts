/**
 * The Transport slice for DorkOS's check on agents' shell commands (DOR-3300).
 *
 * @module shared/transport-shell-check
 */
import type { ShellCheckStatus } from './notification-schemas.js';

/** What the app reads about the check, and a person's choice to go on without it. */
export interface ShellCheckTransport {
  /** What the app shows about the check. */
  getShellCheckStatus(): Promise<ShellCheckStatus>;
  /** A person goes on at Full without the check, until restart. Refused for anything else. */
  continueWithoutShellCheck(): Promise<ShellCheckStatus>;
}
