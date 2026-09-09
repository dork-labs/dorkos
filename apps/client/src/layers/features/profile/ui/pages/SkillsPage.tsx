/**
 * Skills — every skill this agent's folder holds, and what each of your agent
 * tools does with it (spec `harness-sync-status` §User Experience, "The Skills
 * page").
 *
 * It used to list installed marketplace skill-packs, which said "no skills" to
 * a person with thirty-one of them. The page now composes `entities/harness`:
 * the same read `dorkos harness sync` prints, arranged per file with one chip
 * per tool.
 *
 * @module features/profile/ui/pages/SkillsPage
 */
import { Package } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { useSafeNavigate } from '@/layers/shared/model';
import {
  HarnessDriftBanner,
  NotEnabledNotice,
  NotSharedPanel,
  ProjectLevelNoticesPanel,
  SkillsWithHarnessesList,
  useHarnessStatus,
} from '@/layers/entities/harness';
import type { ProfilePageContentProps } from './types';

/**
 * The page's body, once there is a folder to read.
 *
 * Its own component because the hooks below may only run when there is a path
 * to run them about, and the "no folder" answer is a return before any of them.
 *
 * **The read is shared, not repeated.** `useHarnessStatus` here and inside
 * `SkillsWithHarnessesList` name one query key, so TanStack serves both from a
 * single request — the same cache hit the profile root already takes for the
 * About row's manifest. The list owns the six states and draws them; this
 * component only needs the parts that live outside the list.
 *
 * **One "Browse skill-packs", always.** The page keeps it at the foot, which is
 * where it has always been — it is what you do after reading the list, not
 * before. So the list's zero-skills state is told not to draw its own
 * (`showBrowseLink={false}`), and a person with no skills sees one link rather
 * than two.
 */
function SkillsPageBody({ projectPath }: { projectPath: string }) {
  const navigate = useSafeNavigate();
  const { data: status } = useHarnessStatus(projectPath);
  // Only a `ready` tree has anything for these three to draw. The other states
  // carry empty arrays today, so this changes nothing on screen — it is what
  // stops a future payload filing a panel under "DorkOS can't read this folder".
  const ready = status?.state === 'ready' ? status : null;

  return (
    <div className="flex flex-col gap-2" data-slot="profile-skills">
      {/* Above everything a person reads about the tree: at most one line about
          what is out of date, and — after a sync — what changed, in its place.
          It reads the same query key this page already holds, so mounting it
          costs no extra request. */}
      <HarnessDriftBanner projectPath={projectPath} />
      {ready && <NotEnabledNotice notEnabled={ready.notEnabled} />}
      <SkillsWithHarnessesList projectPath={projectPath} showBrowseLink={false} />
      {ready && <NotSharedPanel rows={ready.rows} enabled={ready.enabled} />}
      {ready && <ProjectLevelNoticesPanel entries={ready.projectLevel} />}
      {navigate && (
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground w-full"
          onClick={() => void navigate({ to: '/marketplace', search: { type: 'skill-pack' } })}
        >
          <Package aria-hidden className="mr-1.5 size-3.5" />
          Browse skill-packs
        </Button>
      )}
    </div>
  );
}

/**
 * What this agent knows how to do, which of your tools can see it, and where to
 * get it more.
 *
 * Top to bottom: the tools whose files are in the folder that DorkOS is not
 * sharing to, the skills themselves, one collapsed panel per tool that is
 * missing something, the notices that belong to the project rather than to any
 * tool, and the marketplace link.
 */
export function SkillsPage({ member }: ProfilePageContentProps) {
  const projectPath = member.agent?.projectPath ?? null;

  if (projectPath === null) {
    return <p className="text-muted-foreground text-sm">This agent’s folder isn’t known here.</p>;
  }

  return <SkillsPageBody projectPath={projectPath} />;
}
