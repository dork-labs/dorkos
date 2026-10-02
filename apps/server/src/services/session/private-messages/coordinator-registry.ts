/** Composition-root installation for the single protected session coordinator. */
import type { PrivateSessionMessageAcceptanceService } from './acceptance.js';
let sharedService: PrivateSessionMessageAcceptanceService | undefined;

/** Install the process-wide protected-message coordinator at the composition root. */
export function setPrivateSessionMessageAcceptanceService(
  service: PrivateSessionMessageAcceptanceService | undefined
): void {
  sharedService = service;
}

/** Read the protected-message coordinator, if this host configured one. */
export function getPrivateSessionMessageAcceptanceService():
  PrivateSessionMessageAcceptanceService | undefined {
  return sharedService;
}
