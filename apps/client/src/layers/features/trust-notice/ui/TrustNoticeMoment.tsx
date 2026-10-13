import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { docsUrl } from '@dorkos/shared/links';

import { useUpdateConfig } from '@/layers/entities/config';
import { useSetPermission } from '@/layers/entities/permissions';
import {
  Button,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ExternalLinkAnchor,
} from '@/layers/shared/ui';
import { appRoutes } from '@/layers/shared/lib';

import { useSharedApps, type SharedApp } from '../model/use-shared-apps';
import { SharedAppsList } from './SharedAppsList';

/** The docs section that walks through the change, linked as "What changed". */
export const TRUST_NOTICE_DOCS_URL = docsUrl('/guides/permissions#what-changed');

/** The two lines under the opening sentence, one block each. */
const NOTICE_LINES = [
  'Everything they do is recorded in Activity. Anyone can pause an agent.',
  'Messages and code from strangers still need your yes.',
] as const;

/** Props for {@link TrustNoticeMoment}. */
export interface TrustNoticeMomentProps {
  /** The moments rail's close handler, called once an answer is recorded. */
  onClose: () => void;
  /**
   * Connection ids the Trusted upgrade shared with every agent
   * (`permissions.sharedAtUpgrade`). The notice lists those still shared,
   * each with **Choose agents**.
   */
  sharedConnectionIds?: readonly string[];
}

/** The toast after Keep asking me, when apps stay shared with every agent. */
const KEEP_ASKING_WITH_APPS =
  'Agents ask first again. Shared apps stay shared; change them in Connections.';

/** Turn a failed write into one sentence a person can act on. */
function describeWriteFailure(err: unknown): string {
  return (err instanceof Error && err.message) || 'Couldn’t save that. Try again.';
}

/**
 * The one-time notice that agents now work without asking (spec
 * `trusted-by-default-flip` §5.8, ADR `261006-225605`).
 *
 * It tells rather than asks: the install is already Trusted, by the upgrade
 * migration or by being new. It renders inside the dialog the moments rail
 * owns, and either button retires it for good by writing `ui.trustNoticeSeenAt`.
 *
 * - **Got it** writes the stamp and nothing else.
 * - **Keep asking me** chooses the Careful preset first (which also sets the
 *   Files & commands stop to Ask), then writes the stamp. The order matters: if
 *   the preset write is refused, nothing is stamped and the notice stays up to
 *   say so. If the preset lands but the stamp does not, the install is Careful,
 *   which already makes the notice ineligible.
 *
 * - **Choose agents**, beside each app the upgrade shared with every agent,
 *   opens that app's "Who can use it?" on "Only agents you pick". It closes
 *   the notice without retiring it while other listed apps are still shared,
 *   so the notice comes back on a later launch to name them; on the last one
 *   it writes the stamp like Got it. Nothing about the app changes until Save.
 * - With apps listed, **Keep asking me** says they stay shared, and where to
 *   change them: Careful asks first from now on, and shares nothing back.
 *
 * Closing the dialog without an answer writes nothing, and the rail offers the
 * notice again on a later launch.
 *
 * @param props - See {@link TrustNoticeMomentProps}.
 */
export function TrustNoticeMoment({ onClose, sharedConnectionIds = [] }: TrustNoticeMomentProps) {
  // The apps are read only when there are any, so a notice with none needs no
  // connector data at all.
  return sharedConnectionIds.length > 0 ? (
    <NoticeWithSharedApps onClose={onClose} connectionIds={sharedConnectionIds} />
  ) : (
    <Notice onClose={onClose} sharedApps={[]} />
  );
}

function NoticeWithSharedApps({
  onClose,
  connectionIds,
}: {
  onClose: () => void;
  connectionIds: readonly string[];
}) {
  return <Notice onClose={onClose} sharedApps={useSharedApps(connectionIds)} />;
}

function Notice({
  onClose,
  sharedApps,
}: {
  onClose: () => void;
  sharedApps: readonly SharedApp[];
}) {
  const navigate = useNavigate();
  const updateConfig = useUpdateConfig();
  const setPermission = useSetPermission({ kind: 'default' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const busy = submitting || updateConfig.isPending || setPermission.isPending;

  const answer = async (keepAsking: boolean, then?: () => void) => {
    setError(null);
    setSubmitting(true);
    try {
      if (keepAsking) {
        // 'first-run' is the closest surface on record: no surface names this
        // notice yet, so history reads "during setup" even after an upgrade.
        await setPermission.mutateAsync({
          kind: 'preset',
          preset: 'careful',
          surface: 'first-run',
        });
      }
      await updateConfig.mutateAsync({ ui: { trustNoticeSeenAt: new Date().toISOString() } });
    } catch (err) {
      setError(describeWriteFailure(err));
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
    if (keepAsking) {
      toast.success(
        sharedApps.length > 0
          ? KEEP_ASKING_WITH_APPS
          : 'Agents ask first again. Change it in Permissions.'
      );
    }
    onClose();
    then?.();
  };

  const openApp = (connectionId: string) =>
    void navigate({ ...appRoutes.connections(), search: { app: connectionId, who: 'picked' } });
  const chooseAgents = (connectionId: string) => {
    // Others still listed: leave the notice unanswered so it names them again.
    if (sharedApps.length > 1) {
      onClose();
      openApp(connectionId);
      return;
    }
    void answer(false, () => openApp(connectionId));
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle data-testid="trust-notice">Agents now work without asking</DialogTitle>
        <DialogDescription>
          They edit files, run commands, schedule work and use your connected apps on their own.
        </DialogDescription>
      </DialogHeader>

      <div className="text-muted-foreground space-y-2 text-sm">
        {NOTICE_LINES.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>

      {sharedApps.length > 0 && (
        <SharedAppsList apps={sharedApps} onChooseAgents={chooseAgents} disabled={busy} />
      )}

      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}

      <DialogFooter className="items-center gap-2 sm:justify-between">
        <ExternalLinkAnchor
          href={TRUST_NOTICE_DOCS_URL}
          className="text-muted-foreground hover:text-foreground text-xs font-medium underline underline-offset-2"
        >
          What changed
        </ExternalLinkAnchor>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => answer(true)} disabled={busy}>
            Keep asking me
          </Button>
          <Button size="sm" onClick={() => answer(false)} disabled={busy}>
            Got it
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}
