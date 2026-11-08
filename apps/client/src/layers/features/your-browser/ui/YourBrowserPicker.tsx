import { useEffect, useRef, useState } from 'react';
import type {
  YourBrowserChoice,
  YourBrowserKind,
  YourBrowserScan,
} from '@dorkos/shared/your-browser';
import { useTransport } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';

const NAMES: Record<YourBrowserKind, string> = { chrome: 'Chrome', edge: 'Edge', brave: 'Brave' };

/** A tap-only picker. Scan metadata never enters query caches or persistent state. */
export function YourBrowserPicker() {
  const transport = useTransport();
  const [scan, setScan] = useState<YourBrowserScan | null>(null);
  const [choice, setChoice] = useState<YourBrowserChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const scanButton = useRef<HTMLButtonElement>(null);
  const selectedHeading = useRef<HTMLHeadingElement>(null);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    []
  );
  useEffect(() => {
    if (choice) selectedHeading.current?.focus();
  }, [choice]);

  const find = async () => {
    const current = ++generation.current;
    setScan(null);
    setChoice(null);
    setError(false);
    setBusy(true);
    try {
      const result = await transport.scanYourBrowsers();
      if (generation.current === current) setScan(result);
    } catch {
      if (generation.current === current) setError(true);
    } finally {
      if (generation.current === current) setBusy(false);
    }
  };

  return (
    <section aria-labelledby="your-browser-heading" className="space-y-4">
      <div>
        <h2 id="your-browser-heading" className="text-base font-medium">
          Your browser
        </h2>
        <p className="text-muted-foreground text-sm">
          Find a browser profile on the computer running DorkOS.
        </p>
        <p className="text-muted-foreground text-sm">
          Profile names and emails are read only when you tap.
        </p>
      </div>
      <Button
        ref={scanButton}
        onClick={() => void find()}
        disabled={busy}
        aria-busy={busy}
        className="min-h-11"
      >
        {busy ? 'Finding browsers…' : scan || choice ? 'Scan again' : 'Find my browsers'}
      </Button>
      <div role="status" aria-live="polite">
        {busy && <p className="text-muted-foreground text-sm">Looking for browser profiles…</p>}
        {scan?.supported && <p className="text-sm">Found {scan.profiles.length} profiles</p>}
      </div>
      {error && (
        <p role="alert" className="text-sm">
          Couldn’t find your browsers. Try again.
        </p>
      )}
      {scan && !scan.supported && (
        <p className="text-sm">Browser discovery isn’t available on this computer.</p>
      )}
      {scan && scan.supported && scan.profiles.length === 0 && (
        <p className="text-muted-foreground text-sm">
          No profiles found. Open Chrome, Edge or Brave, then scan again.
        </p>
      )}
      {scan && scan.unreadable.length > 0 && (
        <p role="alert" className="text-muted-foreground text-sm">
          Couldn’t read {scan.unreadable.map((browser) => NAMES[browser]).join(', ')}. Close it and
          scan again.
        </p>
      )}
      {scan && scan.profiles.length > 0 && (
        <>
          <ul className="space-y-2" aria-label="Browser profiles">
            {scan.profiles.map((profile) => (
              <li
                key={`${profile.browser}/${profile.directory}`}
                className="bg-muted/50 flex min-w-0 items-center gap-3 rounded-lg p-3"
              >
                <span
                  aria-hidden="true"
                  className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-medium"
                >
                  {profile.displayName.slice(0, 2).toLocaleUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={profile.displayName}>
                    {NAMES[profile.browser]} · {profile.displayName}
                  </p>
                  <p className="text-muted-foreground truncate text-sm" title={profile.email}>
                    {profile.email ?? 'Not signed in'}
                  </p>
                </div>
                <Button
                  variant="outline"
                  className="min-h-11 shrink-0"
                  aria-label={`Use ${NAMES[profile.browser]} · ${profile.displayName}`}
                  onClick={() => {
                    // Drop every scanned email, including those in the other profiles, at the pick.
                    setScan(null);
                    setChoice({
                      browser: profile.browser,
                      directory: profile.directory,
                      displayName: profile.displayName,
                    });
                  }}
                >
                  Use this
                </Button>
              </li>
            ))}
          </ul>
          <Button
            variant="ghost"
            className="min-h-11"
            onClick={() => {
              setScan(null);
              scanButton.current?.focus();
            }}
          >
            Close list
          </Button>
        </>
      )}
      {choice && (
        <div className="bg-muted/50 space-y-1 rounded-lg p-3">
          <h3 ref={selectedHeading} tabIndex={-1} className="text-sm font-medium break-words">
            {NAMES[choice.browser]} · {choice.displayName}
          </h3>
          <p className="text-muted-foreground text-sm">Selected · Off</p>
          <p className="text-muted-foreground text-sm">
            Pairing is coming soon. Agents can’t use this browser yet.
          </p>
        </div>
      )}
      <p className="text-muted-foreground text-xs">
        Looks in Chrome, Edge and Brave. Arc isn’t supported yet.
      </p>
    </section>
  );
}
