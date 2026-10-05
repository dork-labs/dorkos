import { useState } from 'react';
import { Coffee } from 'lucide-react';
import {
  Button,
  ResponsivePopover,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  ResponsivePopoverTrigger,
  useResponsivePopover,
} from '@/layers/shared/ui';
import { useSettingsDeepLink } from '@/layers/shared/model';
import {
  describeKeepAwakeWork,
  isKeepingAwake,
  KEEP_AWAKE_CAVEAT,
  SLEEP_SETTINGS,
  useKeepAwake,
} from '@/layers/entities/keep-awake';

/**
 * The popover's one heading. On a phone the sheet draws it as its title; a
 * desktop popover has no title slot, so the same words are drawn inline.
 */
function KeepAwakeHeading({ work }: { work: string | null }) {
  const { isDesktop } = useResponsivePopover();
  if (!isDesktop) {
    return (
      <ResponsivePopoverTitle className="text-sm font-medium">
        Keeping awake: {work}
      </ResponsivePopoverTitle>
    );
  }
  return <p className="text-sm font-medium">Keeping awake: {work}</p>;
}

/**
 * A small cup in the top bar, present only while DorkOS is keeping this
 * computer awake for work (spec `keep-awake`).
 *
 * Beside the remote-access globe because keep-awake is machine-wide, like it:
 * the per-chat status line was the wrong home, since it would repeat one fact
 * about the computer in every chat. With nothing running, or the setting off,
 * or a computer that cannot be held awake, it draws nothing at all.
 *
 * Still, like the globe: no animation. It appears, says why, and goes.
 */
export function KeepAwakeBeacon() {
  const status = useKeepAwake();
  const { open: openSettings } = useSettingsDeepLink();
  const [open, setOpen] = useState(false);

  if (!isKeepingAwake(status)) return null;
  const work = describeKeepAwakeWork(status.working);

  return (
    <ResponsivePopover open={open} onOpenChange={setOpen}>
      <ResponsivePopoverTrigger asChild>
        <button
          type="button"
          data-testid="keep-awake-beacon"
          aria-label={`Keeping this computer awake: ${work}. Show details`}
          className="focus-ring text-muted-foreground hover:text-foreground inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors"
        >
          <Coffee className="size-4" aria-hidden />
        </button>
      </ResponsivePopoverTrigger>
      <ResponsivePopoverContent
        side="bottom"
        align="end"
        aria-label="Keeping awake"
        className="w-72 max-w-[calc(100vw-1.5rem)] space-y-2 p-3"
      >
        <KeepAwakeHeading work={work} />
        <p className="text-muted-foreground text-xs">{KEEP_AWAKE_CAVEAT}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setOpen(false);
            openSettings(SLEEP_SETTINGS.tab, SLEEP_SETTINGS.section);
          }}
        >
          Sleep settings
        </Button>
      </ResponsivePopoverContent>
    </ResponsivePopover>
  );
}
