import type { Hono } from 'hono';
import type { Pool } from 'pg';
import type { CommunityConfig } from '../config.js';
import { ApiError } from '../http.js';
import { streamAttachment } from '../routes/community/downloads/attachment-download.js';
import { streamExportArchive } from '../routes/community/downloads/export-download.js';
import type { BlobStore } from '../storage/index.js';
import { memberOfLink, principalOfLink } from './access.js';
import { readUserContentLink } from './links.js';

/**
 * Serve signed download links at `/u/<token>` (DOR-2957), and keep the two addresses apart when
 * a user-content address is set: it answers only `/u/*`, and the space's own address never does.
 * Unset, the space's own address serves the links itself. Registered before every other route,
 * so nothing on the user-content address answers before the split is checked.
 */
export function registerUserContentRoutes(
  app: Hono,
  {
    pool,
    config,
    blobStore,
    now = () => new Date(),
  }: { pool: Pool; config: CommunityConfig; blobStore: BlobStore; now?: () => Date }
): void {
  const fileHost = config.userContentUrl ? new URL(config.userContentUrl).host : null;
  // With a user-content address, the split is an allow-list: links answer only on the files
  // host, and the files host answers nothing else. A link on any other host (the space's own,
  // an IP, a stray name) is not found. The space's other routes keep answering whatever host
  // reaches them, so a platform health check by internal address still works. Unset, the
  // space's own address serves links itself, so local and test setups need nothing.
  app.use('*', async (c, next) => {
    if (fileHost !== null) {
      const onFileHost = new URL(c.req.url).host === fileHost;
      const isLink = c.req.path.startsWith('/u/');
      if (isLink ? !onFileHost : onFileHost) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
    }
    await next();
  });
  app.get('/u/:token', async (c) => {
    const claim = readUserContentLink(config, c.req.param('token'), now());
    if (claim === 'invalid')
      throw new ApiError(404, 'NOT_FOUND', 'This download link is not valid.');
    if (claim === 'expired')
      throw new ApiError(410, 'LINK_EXPIRED', 'This download link expired. Download it again.');
    if (claim.kind === 'attachment')
      return streamAttachment(
        { pool, blobStore },
        {
          attachmentId: claim.id,
          communityId: claim.communityId,
          current: () => principalOfLink(pool, claim),
          signal: c.req.raw.signal,
        }
      );
    const member = await memberOfLink(pool, claim);
    return streamExportArchive(
      { pool, blobStore },
      {
        id: claim.id,
        member,
        stillMember: async () => (await memberOfLink(pool, claim).catch(() => null)) !== null,
        request: c.req.raw,
      }
    );
  });
}
