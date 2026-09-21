import { CommunityApp } from './CommunityApp.js';
import { CommunityChooser } from './components/CommunityChooser.js';
import { CommunityAdministration } from './components/CommunityAdministration.js';
import { HostAdministration } from './components/HostAdministration.js';
import { Pairing } from './components/Pairing.js';

/** Select the browser surface from an exact root or tenant-qualified path. */
export function BrowserRoot({
  pathname = window.location.pathname,
  search = window.location.search,
}: {
  pathname?: string;
  search?: string;
}) {
  const pairing = pathname === '/pairing' || /^\/c\/[^/]+\/pairing$/.test(pathname);
  if (pairing) return <Pairing search={search} />;
  if (pathname === '/host') return <HostAdministration />;
  if (/^\/c\/[^/]+\/deletion$/u.test(pathname))
    return (
      <main className="settings" aria-labelledby="deletion-recovery-title">
        <p className="eyebrow">Community settings</p>
        <h1 id="deletion-recovery-title">Deletion status</h1>
        <CommunityAdministration
          memberRole="owner"
          onChanged={() => undefined}
          onOpenPeople={() => undefined}
        />
      </main>
    );
  if (pathname === '/') return <CommunityChooser signedOut={() => <CommunityApp />} />;
  return <CommunityApp />;
}
