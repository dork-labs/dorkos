/** Live source-folder checks shared by the approval list and approval action. */
import fs from 'node:fs/promises';
import type { ExtensionRecord } from '@dorkos/extension-api';

/** Whether the copy's folder still exists and can be read as a directory. */
export async function extensionFolderExists(folder: string): Promise<boolean> {
  try {
    return (await fs.stat(folder)).isDirectory();
  } catch {
    return false;
  }
}

/** Keep only copies whose folders still exist, without running discovery. */
export async function presentExtensionCopies(
  records: readonly ExtensionRecord[]
): Promise<ExtensionRecord[]> {
  const present = await Promise.all(records.map((record) => extensionFolderExists(record.path)));
  return records.filter((_, index) => present[index]);
}
