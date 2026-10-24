import { Pause } from 'lucide-react';
import type { AdapterConfirmation } from '@dorkos/shared/relay-schemas';
import {
  pausedConfirmHint,
  pausedMeta,
  pausedNotSent,
  pausedReferenceList,
  type useConfirmAdapterReferences,
} from '@/layers/entities/relay';
import { PanelFix } from '@/layers/features/connections';

interface PausedConfirmProps {
  /** The connection's kind ("Webhook", "Telegram"). */
  kind: string;
  /** Its name, for the toast. */
  name: string;
  /** Its id. */
  id: string;
  /** What the server listed it with: what it sends, where, and what it dropped. */
  confirmation: AdapterConfirmation;
  /** The confirm mutation, owned by the panel. */
  confirm: ReturnType<typeof useConfirmAdapterReferences>;
}

/**
 * A connection paused until its owner confirms the `env:`/`keychain:`
 * settings it sends (DOR-3271; designer spec `adapter-confirm`): why, what it
 * sends and where, what it dropped meanwhile, and one Confirm. Names only,
 * never a setting's value; the host is always ASCII.
 */
export function PausedConfirm({ kind, name, id, confirmation, confirm }: PausedConfirmProps) {
  const notSent = pausedNotSent(confirmation.notSent);
  const many = confirmation.references.length > 2;
  return (
    <PanelFix
      icon={Pause}
      message="Paused · confirm the setting it sends."
      detail={
        <>
          <span
            className="text-muted-foreground block break-words"
            title={many ? pausedReferenceList(confirmation) : undefined}
          >
            {pausedMeta(kind, confirmation)}
            {many && <span className="sr-only">: {pausedReferenceList(confirmation)}</span>}
          </span>
          {notSent && <span className="text-muted-foreground block">{notSent}</span>}
        </>
      }
      action="Confirm this setting"
      actionHint={pausedConfirmHint(confirmation)}
      pending={confirm.isPending}
      onAction={() => confirm.mutate({ id, name, fingerprint: confirmation.fingerprint })}
    />
  );
}
