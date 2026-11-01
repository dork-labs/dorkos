import type { CompanyCertificatesStatus, ServerConfig } from '@dorkos/shared/schemas';
import { NetworkSection } from '@/layers/features/settings';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';

const BUNDLE = '/Users/kai/certs/company-ca.pem';
const LONG_BUNDLE =
  '/Users/kai/Library/Application Support/Acme Corp/Network/certs/acme-root-ca.pem';

/** The desktop window, as the card sees it: a file dialog that picks a file, and a restart. */
const DESKTOP = { picker: async () => BUNDLE, canRestart: true };

/** A config carrying only what the Network card reads. */
function configWith(path: string | null, status: CompanyCertificatesStatus | null): ServerConfig {
  return {
    network: { extraCaCertsPath: path, companyCertificates: status },
  } as unknown as ServerConfig;
}

/** Every state the desktop app can report at start-up, and a save it has not loaded yet. */
const STATES: { label: string; config: ServerConfig; browser?: true }[] = [
  {
    label: 'Loaded',
    config: configWith(BUNDLE, { outcome: 'added', added: 3, path: BUNDLE }),
  },
  {
    label: 'Loaded, one certificate, long path',
    config: configWith(LONG_BUNDLE, { outcome: 'added', added: 1, path: LONG_BUNDLE }),
  },
  {
    label: 'NODE_EXTRA_CA_CERTS set, no file chosen',
    config: configWith(null, { outcome: 'ignored-env', added: 0, path: null }),
  },
  {
    label: 'File could not be read',
    config: configWith(BUNDLE, { outcome: 'unreadable', added: 0, path: BUNDLE }),
  },
  {
    label: 'File holds no certificate',
    config: configWith(BUNDLE, { outcome: 'empty', added: 0, path: BUNDLE }),
  },
  {
    label: 'Changed, restart due',
    config: configWith('/Users/kai/certs/new-ca.pem', { outcome: 'added', added: 3, path: BUNDLE }),
  },
  {
    label: 'Stopped, restart due',
    config: configWith(null, { outcome: 'added', added: 3, path: BUNDLE }),
  },
  {
    label: 'First file chosen, restart due',
    config: configWith(BUNDLE, { outcome: 'not-set', added: 0, path: null }),
  },
  {
    label: 'In a browser (no file dialog, no restart)',
    config: configWith('/Users/kai/certs/new-ca.pem', { outcome: 'added', added: 3, path: BUNDLE }),
    browser: true,
  },
  {
    label: 'Nothing set',
    config: configWith(null, { outcome: 'not-set', added: 0, path: null }),
  },
];

/**
 * Settings → Server → Network (DOR-3361): which company certificates the
 * desktop app trusts. The card draws only inside the desktop app, so each
 * state here hands it the status the app would report.
 */
export function CompanyCertificatesShowcases() {
  return (
    <PlaygroundSection
      title="Company Certificates"
      description="The Network card in Settings → Server. The desktop app trusts only the file chosen here, and the line under it says what it loaded at start-up."
    >
      {STATES.map((state) => (
        <div key={state.label}>
          <ShowcaseLabel>{state.label}</ShowcaseLabel>
          <ShowcaseDemo>
            <div className="max-w-lg">
              <NetworkSection
                config={state.config}
                desktop={state.browser ? { picker: null, canRestart: false } : DESKTOP}
              />
            </div>
          </ShowcaseDemo>
        </div>
      ))}
    </PlaygroundSection>
  );
}
