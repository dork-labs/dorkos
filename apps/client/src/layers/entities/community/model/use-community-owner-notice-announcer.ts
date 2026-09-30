/**
 * Telling a community's owner, once, that someone asked to take the community over, and once
 * more when that request completes (DOR-2543).
 *
 * @module entities/community/model/use-community-owner-notice-announcer
 */
import { useEffect } from 'react';
import { toast } from 'sonner';
import type { CommunityConnectionOwnerNotice } from '@dorkos/shared/community-connections';
import { openExternalLink } from '@/layers/shared/lib';
import { communityPageUrl, ownerNoticeAnnouncement } from '../lib/owner-notice';
import { useCommunityConnections } from './use-community-connections';

/** Where this browser remembers which requests it already announced. */
export const OWNER_NOTICE_ANNOUNCED_KEY = 'dorkos:community-owner-notices-announced';

/** Enough to cover every community's latest request many times over, without growing forever. */
const MAX_REMEMBERED = 100;

/** What this page already announced, for when the browser keeps nothing between loads. */
const announcedThisPage = new Set<string>();

function announcementKey(notice: CommunityConnectionOwnerNotice): string {
  return `${notice.state}:${notice.replacementId}`;
}

function readAnnounced(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(OWNER_NOTICE_ANNOUNCED_KEY) ?? '[]');
    return Array.isArray(stored) ? stored.filter((key) => typeof key === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Claim one announcement: `true` the first time this browser sees it, `false` ever after,
 * across reloads. Falls back to this page's memory when the browser's storage is unavailable.
 */
function claimAnnouncement(key: string): boolean {
  if (announcedThisPage.has(key)) return false;
  announcedThisPage.add(key);
  const announced = readAnnounced();
  if (announced.includes(key)) return false;
  try {
    localStorage.setItem(
      OWNER_NOTICE_ANNOUNCED_KEY,
      JSON.stringify([...announced, key].slice(-MAX_REMEMBERED))
    );
  } catch {
    // Private windows and blocked storage: this page's memory still stops a repeat here.
  }
  return true;
}

/**
 * Announce each request to replace this person as a community's owner the first time the
 * connection list shows it, and its completion the first time that shows.
 *
 * Keyed by the request's id, so a request is announced once per browser however many reloads,
 * polls or windows later it is still showing, and even after a slow Community hid it for a read.
 * The local server attaches the notice only to the owner's own connection, so a non-owner is
 * never told. The banner and the row's dot stay for as long as the request is open; this is only
 * the moment it first appears. **Mount it exactly once**, from the app shell.
 */
export function useCommunityOwnerNoticeAnnouncer(): void {
  const { data: connections } = useCommunityConnections();
  useEffect(() => {
    for (const connection of connections ?? []) {
      const notice = connection.ownerNotice;
      if (!notice || !claimAnnouncement(announcementKey(notice))) continue;
      const { title, description } = ownerNoticeAnnouncement(notice, connection.label);
      const id = `community-owner-notice:${announcementKey(notice)}`;
      if (notice.state === 'completed') {
        toast.info(title, { id, description });
        continue;
      }
      toast.warning(title, {
        id,
        description,
        action: {
          label: 'Open community',
          onClick: () => openExternalLink(communityPageUrl(connection)),
        },
      });
    }
  }, [connections]);
}

/** Forget what this page announced. @internal Exported for tests, which reload by clearing it. */
export function resetOwnerNoticeAnnouncementsForTests(): void {
  announcedThisPage.clear();
}
