import { CommunityApp } from './CommunityApp.js';
import { CommunityChooser } from './components/CommunityChooser.js';
import { DeletionRecovery } from './components/DeletionRecovery.js';
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
  const deletion = /^\/c\/([^/]+)\/deletion$/u.exec(pathname);
  if (deletion) return <DeletionRecovery communityId={deletion[1]} />;
  if (pathname === '/') return <CommunityChooser signedOut={() => <CommunityApp />} />;
  return <CommunityApp />;
}
