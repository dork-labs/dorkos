import type { OwnedInputAuthorization } from '@dorkos/browser/server-owner';
import type { BrowserBinding } from '@dorkos/shared/browser-schemas';
import type { BrowserControllerActor } from './controller.js';
import type { BrowserApiRefusal } from './service.js';

/** Original authenticated actor and strict controller receiver, captured privately by the runtime issuer. */
export interface BrowserArtifactActorAdmission {
  refresh(): Promise<BrowserControllerActor>;
  current(): BrowserControllerActor | undefined;
  authorization(
    binding: BrowserBinding,
    controllerId: string,
    grant?: Readonly<{ grantId: string; revision: number }>,
    onOriginalDenial?: (value: BrowserApiRefusal) => void
  ): Promise<OwnedInputAuthorization>;
  onOriginalDenial?(value: BrowserApiRefusal): void;
}

/** Capture each receiver once inside the host's preregistered operation; no HTTP identity is synthesized. */
export function captureArtifactActor(original: BrowserArtifactActorAdmission) {
  const refresh = original.refresh.bind(original);
  const current = original.current.bind(original);
  const authorization = original.authorization.bind(original);
  const observer = original.onOriginalDenial;
  const onOriginalDenial = observer?.bind(original);
  return Object.freeze({ refresh, current, authorization, onOriginalDenial });
}
