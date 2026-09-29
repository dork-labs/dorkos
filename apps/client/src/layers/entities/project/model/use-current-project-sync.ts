import { useEffect } from 'react';
import { useAppStore } from '@/layers/shared/model';
import { useProjectForCwd } from './use-project-for-cwd';

/**
 * Keep the app store's `currentProject` in step with the selected folder, so
 * synchronous readers — the extension host's `api.getState()` and
 * `api.subscribe` — can tell which project the person is in (spec
 * `flow-multiproject` §6.4).
 *
 * It reads null while a new folder is being asked about: an extension that saw
 * the previous project's name beside the new folder would act on the wrong
 * one.
 */
export function useCurrentProjectSync(): void {
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const setCurrentProject = useAppStore((s) => s.setCurrentProject);
  const { project } = useProjectForCwd(selectedCwd);

  useEffect(() => {
    setCurrentProject(project);
  }, [project, setCurrentProject]);
}
