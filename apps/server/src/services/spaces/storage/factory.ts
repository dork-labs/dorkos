import type { CommunityConfig } from '../config.js';
import type { BlobStore } from './blob-store.js';
import { FileSystemBlobStore } from './file-system-blob-store.js';
import { S3BlobStore } from './s3-blob-store.js';

/** Select the deployment's persistent blob backend from validated startup settings. */
export function createBlobStore(config: Pick<CommunityConfig, 'storage'>): BlobStore {
  return config.storage.kind === 'filesystem'
    ? new FileSystemBlobStore(config.storage.directory)
    : new S3BlobStore(config.storage);
}
