'use client';

import { useSyncExternalStore } from 'react';
import { Switch } from '@/components/ui/switch';
import { hasOptedOutCapturing, optInCapturing, optOutCapturing } from '@/lib/analytics';
import { hasDntSignal, hasGpcSignal, setStoredConsent } from '@/lib/consent';

/**
 * The visitor's cookie-analytics preference, as a stable primitive so it is
 * safe to hand to {@link useSyncExternalStore} (which requires the snapshot to
 * be referentially stable between changes):
 *
 * - `'on'` — cookie-based capture is active.
 * - `'off'` — opted out; only the cookieless anonymous floor remains.
 * - `'forced-off'` — a browser Do Not Track / Global Privacy Control signal
 *   holds it off and locks the switch.
 */
type AnalyticsPreference = 'on' | 'off' | 'forced-off';

/** Preference never changes except through this control, so we notify manually. */
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

function getSnapshot(): AnalyticsPreference {
  if (hasGpcSignal() || hasDntSignal()) return 'forced-off';
  return hasOptedOutCapturing() ? 'off' : 'on';
}

/** Conservative pre-hydration value: shows the switch off until the browser reads real state. */
function getServerSnapshot(): AnalyticsPreference {
  return 'off';
}

/**
 * Reads (and lets you change) whether cookie-based analytics is on for this
 * visitor. Uses {@link useSyncExternalStore} so the server snapshot is stable
 * and the browser value swaps in after hydration — no hydration mismatch, no
 * set-state-in-effect cascade (matching `lib/use-platform.ts`).
 */
function useAnalyticsPreference(): AnalyticsPreference {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * The analytics on/off control for the /privacy page. This is the opt-out (and
 * opt-in) surface for every visitor, including those in open regions who never
 * see the banner.
 *
 * "On" means cookie-based analytics (persists across visits). "Off" drops to
 * the cookieless anonymous floor — because the site runs
 * `cookieless_mode: 'on_reject'`, we still count you, but with no cookies and no
 * cross-day identity. The copy says so plainly; this is not a "capture nothing"
 * switch and never pretends to be.
 *
 * The choice persists via the same stored-consent mechanism the banner uses
 * (localStorage), so it survives reloads and, in gated regions, replaces the
 * banner decision. A Do Not Track or Global Privacy Control browser signal
 * forces analytics off and locks the switch — the browser has already decided.
 */
export function AnalyticsPreferenceControl() {
  const preference = useAnalyticsPreference();
  const forcedOff = preference === 'forced-off';
  const enabled = preference === 'on';

  const handleChange = (next: boolean) => {
    if (next) {
      setStoredConsent('accepted');
      optInCapturing({ captureEventName: false });
    } else {
      setStoredConsent('rejected');
      optOutCapturing();
    }
    listeners.forEach((l) => l());
  };

  return (
    <div className="border-warm-gray-light/30 space-y-3 rounded-xl border p-6">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <p className="text-charcoal font-medium">Cookie-based analytics</p>
          <p className="text-warm-gray text-sm leading-relaxed">
            {forcedOff
              ? 'Your browser is sending a Do Not Track or Global Privacy Control signal, so cookie-based analytics is off and stays off. We still count anonymous visits with no cookies.'
              : enabled
                ? 'On. We count your visits with a cookie so we can see repeat traffic. Turn it off and we still count you, but anonymously, with no cookies and no cross-day tracking.'
                : 'Off. We count your visits anonymously, with no cookies and no cross-day tracking. Turn it on to allow the cookie-based version.'}
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={handleChange}
          disabled={forcedOff}
          aria-label="Cookie-based analytics"
        />
      </div>
    </div>
  );
}
