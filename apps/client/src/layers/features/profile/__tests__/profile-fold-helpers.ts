/**
 * Test helpers for the profile's folds (Work, Setup, Files): forget every
 * remembered fold between cases, and open them all to reach the rows inside.
 */
import userEvent from '@testing-library/user-event';
import { useProfileFoldStore } from '../model/profile-folds';

/** Every fold closed and nothing remembered, as on a first visit. */
export function resetProfileFolds(): void {
  localStorage.clear();
  useProfileFoldStore.setState({ byViewer: {} });
}

/** Open every closed fold on screen, the way a person would: by its header. */
export async function openProfileFolds(): Promise<void> {
  const headers = [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[data-slot="profile-fold"] > button[aria-expanded="false"]'
    ),
  ];
  for (const header of headers) await userEvent.click(header);
}

/**
 * Remember every fold open for this roster's viewer, for a suite whose subject
 * is the rows inside them rather than the folding.
 *
 * @param roster - The roster the profile is drawn against; its self row is the viewer.
 */
export function openEveryProfileFold(roster: ReadonlyArray<{ id: string; isSelf: boolean }>): void {
  const viewerId = roster.find((member) => member.isSelf)?.id ?? 'local';
  useProfileFoldStore.setState({
    byViewer: { [viewerId]: { work: true, setup: true, files: true } },
  });
}
