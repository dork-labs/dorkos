import { ChevronRight } from 'lucide-react';
import { createModalHandoff } from '@/layers/shared/lib';
import { useAppStore, useSettingsDeepLink } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { PresetPicker } from '@/layers/features/permissions';

/**
 * The Control Center's power setting: the permission preset (spec
 * `agent-permissions`, task 3.8). Careful · Balanced · Full power, reading
 * "Full power, 2 changes" when the defaults differ from the preset.
 *
 * It is the same {@link PresetPicker} Settings shows, so the Full autonomy
 * consent step and the "agents set differently" question are the ones Settings
 * asks. The Control Center stays a summary: the per-area switches live in
 * Settings → Permissions, one tap away.
 */
export function ControlCenterDial() {
  const { open: openSettings } = useSettingsDeepLink();
  const setControlCenterOpen = useAppStore((s) => s.setControlCenterOpen);
  const openAndClose = createModalHandoff(() => setControlCenterOpen(false));

  return (
    <section className="@container flex flex-col gap-2" data-testid="control-center-dial">
      <div>
        <p className="text-sm font-medium">Power</p>
        <p className="text-muted-foreground text-xs">
          How much your agents may do without asking you first.
        </p>
      </div>
      <PresetPicker surface="control-center" />
      {/* After the picker, so the flyout's first focus lands on the choice
          itself rather than on a link away from it. */}
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground h-7 self-start px-2 text-xs"
        onClick={openAndClose(() => openSettings('permissions'))}
      >
        Edit permissions
        <ChevronRight className="size-3.5" aria-hidden />
      </Button>
    </section>
  );
}
