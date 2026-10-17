import { useEffect, useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingRow,
} from '@/layers/shared/ui';

/** The desktop shell's tab-session bridge, when there is one. */
function tabSession() {
  return typeof window === 'undefined' ? undefined : window.electronAPI?.tabSession;
}

/**
 * "When DorkOS opens": reopen your tabs after a quit, or start on one fresh
 * tab. The desktop shell keeps the setting beside the tabs it governs
 * (`main/tab-session/`), so it is read and written over the bridge rather than
 * the server config. Renders nothing outside the desktop app, where the
 * browser owns its own tabs.
 *
 * Only a normal quit follows it: an update, a crash or a recovery restart
 * always reopens everything, and Start fresh still files the old tabs under
 * Recently closed.
 */
export function StartupTabsRow() {
  const bridge = tabSession();
  const [mode, setMode] = useState<DesktopStartupMode | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let live = true;
    void bridge.getStartupMode().then((value) => {
      if (live) setMode(value);
    });
    return () => {
      live = false;
    };
  }, [bridge]);

  if (!bridge || mode === null) return null;

  const change = (value: string) => {
    if (value !== 'reopen' && value !== 'fresh') return;
    setMode(value);
    void bridge.setStartupMode(value).then((saved) => {
      if (saved) setMode(saved);
    });
  };

  return (
    <SettingRow
      label="When DorkOS opens"
      description="After a quit. Updates and crashes always bring your tabs back."
    >
      <Select value={mode} onValueChange={change}>
        <SelectTrigger className="w-40" aria-label="When DorkOS opens">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="reopen">Reopen your tabs</SelectItem>
          <SelectItem value="fresh">Start fresh</SelectItem>
        </SelectContent>
      </Select>
    </SettingRow>
  );
}
