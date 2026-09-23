import { COMMUNITY_HOST_ADMIN_PATH } from '@dorkos/shared/community-wire';
import { CommunityApp } from './CommunityApp.js';
import { CommunityChooser } from './components/CommunityChooser.js';
import { DeletionRecovery } from './components/DeletionRecovery.js';
import { HostAdministration } from './components/HostAdministration.js';
import { OwnerClaim } from './components/OwnerClaim.js';
import { Pairing } from './components/Pairing.js';
import { OWNER_CLAIM_PATH } from './owner-claim.js';
import { ShortNameRoute } from './components/ShortNameRoute.js';
import { COMMUNITY_RESERVED_SHORT_NAMES } from '@dorkos/shared/community-admin-wire';
import { parseShortNamePath } from '../short-names/path.js';

const RESERVED_SHORT_NAMES: ReadonlySet<string> = new Set(COMMUNITY_RESERVED_SHORT_NAMES);

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
  if (pathname === COMMUNITY_HOST_ADMIN_PATH) return <HostAdministration />;
  if (pathname === OWNER_CLAIM_PATH) return <OwnerClaim />;
  const deletion = /^\/c\/([^/]+)\/deletion$/u.exec(pathname);
  if (deletion) return <DeletionRecovery communityId={deletion[1]} />;
  if (pathname === '/') return <CommunityChooser signedOut={() => <CommunityApp />} />;
  // `/<name>[/...]`: a community's short address, for any name the grammar allows that no page
  // of this app already owns. The server reads the path the same way.
  const named = parseShortNamePath(pathname, RESERVED_SHORT_NAMES);
  if (named) return <ShortNameRoute name={named.name} rest={named.rest} />;
  return <CommunityApp />;
}
