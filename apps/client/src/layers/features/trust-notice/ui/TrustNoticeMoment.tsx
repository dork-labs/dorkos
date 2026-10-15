import { useState } from 'react';
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
}

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
 * Closing the dialog without an answer writes nothing, and the rail offers the
 * notice again on a later launch.
 *
 * @param props - See {@link TrustNoticeMomentProps}.
 */
export function TrustNoticeMoment({ onClose }: TrustNoticeMomentProps) {
  const updateConfig = useUpdateConfig();
  const setPermission = useSetPermission({ kind: 'default' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const busy = submitting || updateConfig.isPending || setPermission.isPending;

  const answer = async (keepAsking: boolean) => {
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
    if (keepAsking) toast.success('Agents ask first again. Change it in Permissions.');
    onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle data-testid="trust-notice">Agents now work without asking</DialogTitle>
        <DialogDescription>
          They edit files, run commands and schedule work on their own.
        </DialogDescription>
      </DialogHeader>

      <div className="text-muted-foreground space-y-2 text-sm">
        {NOTICE_LINES.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>

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
