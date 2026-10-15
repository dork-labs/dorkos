import type { LocalBrowserCapabilities, LocalBrowserMode } from '@dorkos/shared/local-browser';

export const BROWSER_MODE_LABELS: Record<LocalBrowserMode, string> = {
  embedded: 'DorkOS browser',
  'new-window': 'New browser window',
};
const HELP: Record<LocalBrowserMode, string> = {
  embedded: 'Browse here. Saved logins stay separate from your usual browser.',
  'new-window': 'Opens on the computer running DorkOS. Saved logins stay separate.',
};

/** Two browser choices, with truthful availability on the current app surface. */
export function BrowserModeChoice({
  value,
  onChange,
  capabilities,
  disabled,
}: {
  value: LocalBrowserMode | null;
  onChange: (mode: LocalBrowserMode) => void;
  capabilities?: LocalBrowserCapabilities;
  disabled: boolean;
}) {
  const supported = {
    embedded: !!capabilities?.embedded && !!window.electronAPI?.localBrowser,
    'new-window': !!capabilities?.newWindow,
  };
  return (
    <fieldset disabled={disabled} className="space-y-2">
      <legend className="sr-only">Browser</legend>
      {(Object.keys(BROWSER_MODE_LABELS) as LocalBrowserMode[]).map((mode) => (
        <label key={mode} className="bg-muted/40 flex items-start gap-2 rounded-lg p-3">
          <input
            type="radio"
            name="local-browser-mode"
            value={mode}
            checked={value === mode}
            disabled={!supported[mode]}
            onChange={() => onChange(mode)}
            className="mt-1"
          />
          <span className="min-w-0 space-y-1">
            <span className="block text-sm font-medium">{BROWSER_MODE_LABELS[mode]}</span>
            <span className="text-muted-foreground block text-xs">{HELP[mode]}</span>
            {!supported[mode] && (
              <span className="text-muted-foreground block text-xs">
                {capabilities?.unavailableReasons?.[mode] ??
                  (mode === 'embedded'
                    ? 'Requires the DorkOS desktop app.'
                    : 'Available on your DorkOS computer.')}
              </span>
            )}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
