/**
 * Settings → Permissions: what agents may do by default (spec
 * `agent-permissions`). The preset at the top (read-only in this phase), every
 * area with its three-way switch, the history of changes, and where connected
 * accounts keep their own permissions.
 *
 * @module features/settings/ui/tabs/PermissionsTab
 */
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { usePermissions } from '@/layers/entities/permissions';
import {
  BLOCKED_IS_NOT_A_SANDBOX,
  PRESET_LABEL,
  PermissionHistory,
  PermissionList,
} from '@/layers/features/permissions';
import { FullPowerDoor } from '@/layers/features/full-power-door';
import { useSettingsDeepLink } from '@/layers/shared/model';
import { Button, Dialog, DialogContent, FieldCard, FieldCardContent } from '@/layers/shared/ui';

/** The preset line: which one is chosen, or that none is yet. */
function PresetSummary({ onChoose }: { onChoose: () => void }) {
  const { data } = usePermissions();
  if (!data) return null;
  if (data.preset === null) {
    return (
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <p className="text-sm">Not chosen yet. Your agents work as they did before.</p>
        <Button variant="outline" size="sm" onClick={onChoose}>
          Choose how much agents may do
        </Button>
      </div>
    );
  }
  const changes =
    data.changeCount === 0
      ? ''
      : `, ${data.changeCount} ${data.changeCount === 1 ? 'change' : 'changes'}`;
  return (
    <p className="text-sm" data-testid="permissions-preset">
      <span className="font-medium">{PRESET_LABEL[data.preset]}</span>
      {changes}
    </p>
  );
}

/** Settings → Permissions. */
export function PermissionsTab() {
  const [doorOpen, setDoorOpen] = useState(false);
  const navigate = useNavigate();
  const { close } = useSettingsDeepLink();

  return (
    <div className="space-y-6">
      <FieldCard>
        <FieldCardContent className="space-y-2">
          <PresetSummary onChoose={() => setDoorOpen(true)} />
        </FieldCardContent>
      </FieldCard>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">What agents may do</h3>
        <p className="text-muted-foreground text-sm">
          Allowed runs without asking. Ask waits for your yes. Blocked is refused.{' '}
          {BLOCKED_IS_NOT_A_SANDBOX}
        </p>
        <FieldCard>
          <FieldCardContent>
            <PermissionList scope={{ kind: 'default' }} />
          </FieldCardContent>
        </FieldCard>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">History</h3>
        <FieldCard>
          <FieldCardContent>
            <PermissionHistory />
          </FieldCardContent>
        </FieldCard>
      </section>

      <p className="text-muted-foreground text-sm">
        Your connected accounts have their own permissions. Manage them in{' '}
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-sm"
          onClick={() => {
            close();
            void navigate({ to: '/connections', search: { region: 'accounts' } });
          }}
        >
          Connections → Accounts
        </Button>
        .
      </p>

      <Dialog open={doorOpen} onOpenChange={setDoorOpen}>
        <DialogContent>
          <FullPowerDoor
            heading="How much may your agents do?"
            onClose={() => setDoorOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
