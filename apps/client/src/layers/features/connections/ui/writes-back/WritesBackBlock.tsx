import { useId, useState } from 'react';
import { STEP_UP_REQUIRED_CODE } from '@dorkos/shared/step-up';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Checkbox,
  SwitchSettingRow,
} from '@/layers/shared/ui';
import { useSetWritesBack, useWritesBack } from '../../model/use-writes-back';

/** Props for {@link WritesBackBlock}. */
export interface WritesBackBlockProps {
  /** The connected app the switch is for. */
  connectionId: string;
  /** The app's display name, e.g. "Linear". */
  appName: string;
}

/** The switch's label, also its accessible name. */
export const WRITES_BACK_LABEL = 'Let agents write back without asking';

/**
 * A connected app's writes-back switch (DOR-4794): when on, an agent whose
 * turn read only this app can add, edit or comment there without a card.
 * Sends, other apps and deletes still ask.
 *
 * Shown only for apps the server offers it for (Linear today): an app whose
 * writes are sends, like mail, never gets it.
 *
 * Off by default. Turning it on asks the person to confirm the app copies
 * nothing somewhere public on its own (DorkOS can't see an app's own syncs),
 * then "Confirm it's you"; turning it off is immediate.
 */
export function WritesBackBlock({ connectionId, appName }: WritesBackBlockProps) {
  const writesBack = useWritesBack(connectionId);
  const set = useSetWritesBack(connectionId);
  const [confirming, setConfirming] = useState(false);
  const state = writesBack.data;

  // Offered only for apps whose changes stay in the team's own workspace (Linear today); the
  // server says which, so a mail or chat app, whose writes are sends, never shows it.
  if (state?.supported === false) return null;
  if (state == null) {
    if (!writesBack.isError) return null;
    return (
      <p role="alert" className="flex flex-wrap items-center gap-x-2 text-sm">
        Couldn’t load this setting.
        <Button
          variant="link"
          size="xs"
          className="h-auto p-0"
          onClick={() => void writesBack.refetch()}
        >
          Retry
        </Button>
      </p>
    );
  }

  // While a change is on its way (or waits on "Confirm it's you"), show where it goes.
  const checked = set.isPending ? set.variables.writesBackUnasked : state.writesBackUnasked;
  // Not confirming it's you is a choice, not a failure: the switch just stays off.
  const failed =
    set.isError && (set.error as { code?: unknown } | null)?.code !== STEP_UP_REQUIRED_CODE;

  return (
    <div data-testid="writes-back-block" className="space-y-1">
      <SwitchSettingRow
        label={WRITES_BACK_LABEL}
        description={`For agents that read only ${appName}. Sends and deletes still ask.`}
        checked={checked}
        disabled={set.isPending}
        onCheckedChange={(next) => {
          if (next) setConfirming(true);
          else set.mutate({ writesBackUnasked: false });
        }}
      />
      {failed && (
        <p role="alert" className="text-destructive text-sm">
          Couldn’t change this. Try again.
        </p>
      )}
      <ConfirmWritesBack
        open={confirming}
        onOpenChange={setConfirming}
        appName={appName}
        onConfirm={() => set.mutate({ writesBackUnasked: true, confirmsNoOutsideSync: true })}
      />
    </div>
  );
}

/** The short confirm before turning it on: what changes, what still asks, and the sync check. */
function ConfirmWritesBack({
  open,
  onOpenChange,
  appName,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appName: string;
  onConfirm: () => void;
}) {
  const checkId = useId();
  const [noOutsideSync, setNoOutsideSync] = useState(false);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Every opening starts unticked: the person says it again each time.
        if (!next) setNoOutsideSync(false);
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Let agents write back to {appName}?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                Agents that only read {appName} can add, edit or comment there without asking you.
              </p>
              <p>Sends, other apps and deletes still ask.</p>
              <p>
                DorkOS can’t see if {appName} copies its content somewhere public, like a two-way
                GitHub sync.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex min-h-11 items-center gap-2">
          <Checkbox
            id={checkId}
            checked={noOutsideSync}
            onCheckedChange={(next) => setNoOutsideSync(next === true)}
          />
          <label htmlFor={checkId} className="text-sm">
            {appName} doesn’t copy its content anywhere public
          </label>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!noOutsideSync}
            onClick={() => {
              setNoOutsideSync(false);
              onConfirm();
            }}
          >
            Turn on
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
