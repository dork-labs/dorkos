/**
 * The bodies the "Confirm it's you" sheet shows instead of the password field
 * when it can't be confirmed from here (DOR-3234, DOR-5086).
 *
 * @module features/auth/ui/StepUpRefusalBodies
 */
import { useState } from 'react';
import type { StepUpExtensionRisk } from '@dorkos/shared/step-up';
import { useSettingsDeepLink } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { hasUnsavedWork } from '../model/unsaved-work';

/** The command that sets or resets the owner's password, run on the computer DorkOS runs on. */
export const RESET_PASSWORD_COMMAND = 'dorkos auth reset-password';

/** The sheet once it ended: what happened, and Close. */
export function EndedBody({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="space-y-4">
      <p role="status" className="text-sm">
        {message}
      </p>
      <Button type="button" className="h-11 w-full sm:h-9" onClick={onClose} autoFocus>
        Close
      </Button>
    </div>
  );
}

/** One line for a mini app that keeps confirming off (PM, DOR-3234 Must 3). */
function extensionRiskLine(risk: StepUpExtensionRisk): string {
  return risk.reason === 'agent-folder'
    ? `Confirming is off while ${risk.name} can be edited by ${risk.agentName ?? 'an agent'}.`
    : `Confirming is off while ${risk.name} has changed since you approved it.`;
}

/** Close beside one way forward, stacked full width on a phone (designer, DOR-3467). */
function TwoButtons({
  action,
  onAction,
  onClose,
}: {
  action: string;
  onAction: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <Button
        type="button"
        variant="ghost"
        className="h-11 w-full sm:h-9 sm:w-auto"
        onClick={onClose}
      >
        Close
      </Button>
      <Button type="button" className="h-11 w-full sm:h-9 sm:w-auto" autoFocus onClick={onAction}>
        {action}
      </Button>
    </div>
  );
}

/**
 * A risky mini app cleared after this sign-in began, so this page may still
 * run its code (M1 on #3401): sign in again.
 */
export function StaleSignInBody({
  onClose,
  onSignInAgain,
}: {
  onClose: () => void;
  onSignInAgain: () => void;
}) {
  return (
    <div className="space-y-4">
      <p role="status" className="text-sm">
        Something changed after you signed in. Sign in again, then try once more.
      </p>
      <TwoButtons action="Sign in again" onAction={onSignInAgain} onClose={onClose} />
    </div>
  );
}

/**
 * This page can't show it loaded after the last change (DOR-5086), and it
 * didn't reload by itself: it already had for this action, or something typed
 * here would be lost. The person reloads it, knowing what that clears.
 */
export function StalePageBody({
  onClose,
  onReload,
}: {
  onClose: () => void;
  onReload: () => void;
}) {
  const [unsaved] = useState(() => hasUnsavedWork());
  return (
    <div className="space-y-4">
      <div role="status" className="space-y-1 text-sm">
        <p>This page opened before a change. Reload it, then try again.</p>
        {unsaved && <p>Reloading clears what you typed on this page.</p>}
      </div>
      <TwoButtons action="Reload" onAction={onReload} onClose={onClose} />
    </div>
  );
}

/**
 * The sheet while a loaded mini app keeps confirming off: no password field,
 * one line per mini app, and the way to fix it in Settings → Extensions.
 */
export function ExtensionRiskBody({
  risks,
  onClose,
}: {
  risks: readonly StepUpExtensionRisk[];
  onClose: () => void;
}) {
  const settings = useSettingsDeepLink();
  return (
    <div className="space-y-4">
      <div role="status" className="space-y-1 text-sm">
        {risks.map((risk) => (
          <p key={risk.id}>{extensionRiskLine(risk)}</p>
        ))}
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="ghost"
          className="h-11 w-full sm:h-9 sm:w-auto"
          onClick={onClose}
        >
          Close
        </Button>
        <Button
          type="button"
          className="h-11 w-full sm:h-9 sm:w-auto"
          autoFocus
          onClick={() => {
            onClose();
            settings.open('extensions');
          }}
        >
          How to fix
        </Button>
      </div>
    </div>
  );
}

/** The sheet when the owner has no password yet: where to set one. */
export function NoPasswordBody({ onClose, remote }: { onClose: () => void; remote?: boolean }) {
  return (
    <div className="space-y-4">
      <p role="status" className="text-sm">
        This computer has no DorkOS password yet.
      </p>
      {remote ? (
        <p role="status" className="text-sm">
          Set one on the computer running DorkOS.
        </p>
      ) : (
        <p className="text-sm">
          Set one in a terminal here:{' '}
          <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">
            {RESET_PASSWORD_COMMAND}
          </code>
        </p>
      )}
      <div className="flex gap-2">
        <Button type="button" className="flex-1" onClick={onClose} autoFocus>
          Close
        </Button>
      </div>
    </div>
  );
}
