/**
 * The Tigris access key Fly makes for a bucket, which deleting the bucket does not delete.
 *
 * Fly's `createAddOn` makes the bucket and one access key for it; `deleteAddOn` (and so
 * `fly storage destroy`) soft-deletes the bucket and leaves that key active in Tigris (DOR-2646).
 * Nothing the launcher holds can delete it: Fly's GraphQL schema has no mutation that touches the
 * key, the Tigris IAM API needs a Tigris sign-in, and a bucket key may only delete keys it made
 * itself. So every removal names the key and tells the person how to delete it.
 *
 * Lives here, beside the removal output that uses it, because `community-deploy/` is at the
 * repository's per-directory file limit (`scripts/check-dir-size.sh`).
 *
 * @module commands/community-deploy/provenance/tigris-access-key
 */

/**
 * The name Tigris usually shows for the access key Fly made with a bucket.
 *
 * Seen only for buckets named after their app (`<bucket>_access_key`); a bucket with a custom name
 * is expected to follow the same pattern, but that is unconfirmed, so user text calls it "usually".
 *
 * @param bucketName - The bucket's name as the launch planned it.
 */
export function tigrisAccessKeyName(bucketName: string): string {
  return `${bucketName}_access_key`;
}

/**
 * Plain steps for deleting a removed bucket's access key by hand, one line each.
 *
 * @param bucketName - The removed bucket's name.
 * @param flyOrganization - The Fly organization the bucket belonged to.
 */
export function tigrisAccessKeySteps(bucketName: string, flyOrganization: string): string[] {
  const key = tigrisAccessKeyName(bucketName);
  return [
    `Tigris still has the access key Fly made for bucket ${bucketName}, and it still works. Fly does not delete it with the bucket. Delete it yourself:`,
    `  1. Run: fly storage dashboard --org ${flyOrganization}`,
    `  2. In the Tigris console, open Access Keys. The key is named after the bucket, usually ${key}: look for it in the list and delete it.`,
    '  Or use the Tigris command-line tool (npm install -g @tigrisdata/cli):',
    '    tigris login oauth            (choose "Sign in with Fly")',
    `    tigris access-keys list       (find the key named after the bucket, usually ${key}; its id starts with tid_)`,
    '    tigris access-keys delete <id>',
  ];
}
