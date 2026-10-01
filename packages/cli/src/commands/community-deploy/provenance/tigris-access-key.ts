/**
 * The Tigris access key Fly makes for a bucket, which deleting the bucket does not delete.
 *
 * Fly's `createAddOn` makes the bucket and one access key for it; `deleteAddOn` (and so
 * `fly storage destroy`) soft-deletes the bucket and leaves that key active in Tigris (DOR-2646).
 * Nothing the launcher holds can delete it: Fly's GraphQL schema has no mutation that touches the
 * key, the Tigris IAM API needs a Tigris sign-in, and a bucket key may only delete keys it made
 * itself. So every removal names the key and tells the person how to delete it.
 *
 * @module commands/community-deploy/provenance/tigris-access-key
 */

/**
 * The name Tigris shows for the access key Fly made with a bucket.
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
    `Tigris still has this bucket's access key, ${key}, and it still works. Fly does not delete it with the bucket. Delete it yourself:`,
    `  1. Run: fly storage dashboard --org ${flyOrganization}`,
    `  2. In the Tigris console, open Access Keys and delete ${key}.`,
    '  Or with the Tigris command-line tool (npm install -g @tigrisdata/cli): run tigris login oauth, then tigris access-keys list to find its id, then tigris access-keys delete <id>.',
  ];
}
