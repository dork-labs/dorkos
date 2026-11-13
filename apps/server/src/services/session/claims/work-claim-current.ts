/**
 * The live work-claim service (DOR-4019), set once at boot. Its own small
 * module, like `chat-message-current.ts`, so the launch path can reach it
 * without importing the wiring and everything the wiring imports.
 *
 * @module services/session/claims/work-claim-current
 */
import type { WorkClaimService } from './work-claim-service.js';

let current: WorkClaimService | undefined;

/** The live claim service, or `undefined` before boot wires it (and in most tests). */
export function getWorkClaims(): WorkClaimService | undefined {
  return current;
}

/**
 * Set or clear the live claim service.
 *
 * @param service - The service, or `undefined` to clear it.
 */
export function setWorkClaims(service: WorkClaimService | undefined): void {
  current = service;
}
