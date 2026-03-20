import { useAppStore } from '@/layers/shared/model';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogBody,
  Kbd,
} from '@/layers/shared/ui';
import { getShortcutsGrouped, formatShortcutKey } from '@/layers/shared/lib';

/** Modal listing all keyboard shortcuts grouped by category. */
export function ShortcutsPanel() {
  const open = useAppStore((s) => s.shortcutsPanelOpen);
  const setOpen = useAppStore((s) => s.setShortcutsPanelOpen);
  const groups = getShortcutsGrouped();

  return (
    <ResponsiveDialog open={open} onOpenChange={setOpen}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Keyboard Shortcuts</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="space-y-6">
          {groups.map(({ group, label, shortcuts }) => (
            <div key={group}>
              <h3 className="text-muted-foreground mb-2 text-xs font-medium tracking-wider uppercase">
                {label}
              </h3>
              <div className="space-y-1">
                {shortcuts.map((s) => (
                  <div key={s.id} className="flex items-center justify-between py-1.5 text-sm">
                    <span>{s.label}</span>
                    <Kbd className="inline-flex">{formatShortcutKey(s)}</Kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
