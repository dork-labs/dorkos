/**
 * The sentence for each check that can refuse a chat canvas's file save, shared
 * by the save itself (`PUT /api/files/content`) and its recovery routes.
 *
 * @module routes/file-saves/refused-because
 */
import type { DocSaveRefusalReason } from '@dorkos/shared/file-save/recovery';

/**
 * Why a chat's canvas will not save its file, for the owner once they are
 * known to be asking (DOR-4442): one sentence per check, never a path.
 */
export const REFUSED_BECAUSE: Readonly<Record<DocSaveRefusalReason, string>> = {
  not_session: 'Only files on a chat’s canvas can be edited here.',
  no_recorded_folder: 'This file’s folder wasn’t recorded when it was opened, so editing is off.',
  root_mismatch: 'This file isn’t in this chat’s agent folder, so editing is off.',
  folder_gone: 'This file’s folder was moved or deleted, so editing is off.',
  outside_boundary: 'This file is outside the folders this chat can edit.',
};
