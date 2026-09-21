import { CommunityApp } from './CommunityApp.js';
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
  return pairing ? <Pairing search={search} /> : <CommunityApp />;
}
