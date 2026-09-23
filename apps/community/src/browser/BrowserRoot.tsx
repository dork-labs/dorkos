import { COMMUNITY_HOST_ADMIN_PATH } from '@dorkos/shared/community-wire';
import { CommunityApp } from './CommunityApp.js';
import { CommunityChooser } from './components/CommunityChooser.js';
import { DeletionRecovery } from './components/DeletionRecovery.js';
import { HostAdministration } from './components/HostAdministration.js';
import { OwnerClaim } from './components/OwnerClaim.js';
import { Pairing } from './components/Pairing.js';
import { OWNER_CLAIM_PATH } from './owner-claim.js';
import { ShortNameRoute } from './components/ShortNameRoute.js';
import {
  COMMUNITY_RESERVED_SHORT_NAMES,
  COMMUNITY_SHORT_NAME_PATTERN,
} from '@dorkos/shared/community-admin-wire';

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
  // of this app already owns.
  const named = /^\/([^/]+)(\/.*)?$/u.exec(pathname);
  if (
    named &&
    COMMUNITY_SHORT_NAME_PATTERN.test(named[1]) &&
    !COMMUNITY_RESERVED_SHORT_NAMES.includes(named[1])
  )
    return <ShortNameRoute name={named[1]} rest={named[2] ?? ''} />;
  return <CommunityApp />;
}
