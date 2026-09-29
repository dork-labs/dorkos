/**
 * Settings → Permissions: what agents may do by default (spec
 * `agent-permissions`). The preset picker at the top, the Files & commands
 * stop, every area with its three-way switch and individual actions, the
 * history of changes, and where connected accounts keep their own permissions.
 *
 * @module features/settings/ui/tabs/PermissionsTab
 */
import { useNavigate } from '@tanstack/react-router';
import { usePermissions } from '@/layers/entities/permissions';
import { getRuntimeDescriptor } from '@/layers/entities/runtime';
import {
  BLOCKED_IS_NOT_A_SANDBOX,
  DefaultFilesAndCommandsRow,
  NewAgentRecordNotice,
  PermissionHistory,
  PermissionList,
  PresetPicker,
} from '@/layers/features/permissions';
import { AutonomyConfirmDialog } from '@/layers/features/status';
import { useSettingsDeepLink } from '@/layers/shared/model';
import { Button, FieldCard, FieldCardContent } from '@/layers/shared/ui';
import { useTrustStopWrites } from '../../model/use-trust-stop-writes';

/**
 * The Files & commands stop everyone has. It is the `runtimes.defaultTrustStop`
 * setting, so it writes through the one consent-gated path Settings has for it,
 * the same one Settings → Runtimes uses.
 */
function FilesAndCommandsSetting() {
  const { data } = usePermissions();
  const trust = useTrustStopWrites();
  if (!data) return null;
  return (
    <>
      <DefaultFilesAndCommandsRow
        files={data.filesAndCommands}
        preset={data.preset}
        onChange={(stop) => trust.changeTrustStop(null, stop)}
        disabled={trust.isPending}
        runtimeLabel={(runtime) => getRuntimeDescriptor(runtime).label}
      />
      {trust.writeError ? (
        <p className="text-destructive text-xs" role="alert">
          {trust.writeError}
        </p>
      ) : null}
      <AutonomyConfirmDialog
        descriptor={trust.pendingAutonomy?.descriptor ?? null}
        canRemember={false}
        consentNote="Every new session will start here, and DorkOS will remember that you have read this."
        onCancel={trust.cancelAutonomy}
        onConfirm={trust.confirmAutonomy}
      />
    </>
  );
}

/** Settings → Permissions. */
export function PermissionsTab() {
  const navigate = useNavigate();
  const { close } = useSettingsDeepLink();

  return (
    <div className="space-y-6">
      <NewAgentRecordNotice />
      <FieldCard>
        <FieldCardContent className="@container space-y-2">
          <PresetPicker surface="settings" />
        </FieldCardContent>
      </FieldCard>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">What agents may do</h3>
        <p className="text-muted-foreground text-sm">
          Allowed runs without asking. Ask waits for your yes. Blocked is refused.{' '}
          {BLOCKED_IS_NOT_A_SANDBOX}
        </p>
        <FieldCard>
          <FieldCardContent className="divide-border divide-y">
            <FilesAndCommandsSetting />
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
            void navigate({ to: '/connections' });
          }}
        >
          Connections
        </Button>
        .
      </p>
    </div>
  );
}
