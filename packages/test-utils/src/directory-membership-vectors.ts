/**
 * The shared table of "does this session belong to this project" cases.
 *
 * Session membership is decided at three call sites — the OpenCode adapter's
 * listing, the server's per-agent fan-out, and the client's session selector.
 * They all route through one predicate (`isWithinDirectory` in
 * `@dorkos/shared/paths`), and each one's own suite drives THIS table so that
 * agreement is proven at every layer rather than assumed from a shared import.
 * Before DOR-674 all three tested raw string equality, and a session started in
 * a subfolder was dropped by whichever layer reached it first.
 *
 * Add a case here, not in one suite, whenever the rule gains an edge.
 *
 * @module directory-membership-vectors
 */

/** One membership case: is `candidate` inside `root`? */
export interface DirectoryMembershipVector {
  /** What this case proves — used as the test name at every call site. */
  name: string;
  /** The project directory a session list is being built for. */
  root: string;
  /** The session's own working directory. */
  candidate: string;
  /** Whether the session belongs to that project. */
  within: boolean;
}

/** Cases every layer that decides session membership must answer identically. */
export const DIRECTORY_MEMBERSHIP_VECTORS: DirectoryMembershipVector[] = [
  {
    name: 'the project folder itself',
    root: '/work/project',
    candidate: '/work/project',
    within: true,
  },
  {
    name: 'a session started one folder in',
    root: '/work/project',
    candidate: '/work/project/packages',
    within: true,
  },
  {
    name: 'a session started deep inside',
    root: '/work/project',
    candidate: '/work/project/packages/api/src',
    within: true,
  },
  {
    name: 'a sibling folder whose name merely starts the same way',
    root: '/work/project',
    candidate: '/work/project-2/src',
    within: false,
  },
  {
    name: 'a sibling folder whose name starts the same way, exactly',
    root: '/work/project',
    candidate: '/work/projectile',
    within: false,
  },
  {
    name: 'the folder above the project',
    root: '/work/project',
    candidate: '/work',
    within: false,
  },
  {
    name: 'an unrelated project',
    root: '/work/project',
    candidate: '/elsewhere/other',
    within: false,
  },
  {
    name: 'a project path written with a trailing slash',
    root: '/work/project/',
    candidate: '/work/project/api',
    within: true,
  },
  {
    name: 'a session directory written with a trailing slash',
    root: '/work/project',
    candidate: '/work/project/api/',
    within: true,
  },
  {
    name: 'a path written with "." segments',
    root: '/work/./project',
    candidate: '/work/project/./api',
    within: true,
  },
  {
    name: 'a path whose ".." climbs back inside',
    root: '/work/project',
    candidate: '/work/project/api/../api/src',
    within: true,
  },
  {
    name: 'a path whose ".." escapes the project',
    root: '/work/project',
    candidate: '/work/project/../other',
    within: false,
  },
  {
    name: 'a path written with doubled separators',
    root: '/work//project',
    candidate: '/work/project//api',
    within: true,
  },
  {
    name: 'the filesystem root, which contains everything',
    root: '/',
    candidate: '/work/project',
    within: true,
  },
  {
    name: 'a relative project path, which nothing can be proven to be inside',
    root: 'work/project',
    candidate: '/work/project/api',
    within: false,
  },
  {
    name: 'a relative session directory',
    root: '/work/project',
    candidate: 'work/project/api',
    within: false,
  },
  { name: 'an empty project path', root: '', candidate: '/work/project', within: false },
  { name: 'an empty session directory', root: '/work/project', candidate: '', within: false },
  {
    name: 'a Windows subfolder written with backslashes',
    root: 'C:\\work\\project',
    candidate: 'C:\\work\\project\\packages\\api',
    within: true,
  },
  {
    name: 'a Windows path mixing both separators',
    root: 'C:/work/project',
    candidate: 'C:\\work\\project/packages',
    within: true,
  },
  {
    name: 'the same Windows path on a different drive',
    root: 'C:\\work\\project',
    candidate: 'D:\\work\\project\\api',
    within: false,
  },
  {
    name: 'a Windows sibling whose name merely starts the same way',
    root: 'C:\\work\\project',
    candidate: 'C:\\work\\project-2',
    within: false,
  },
  {
    // Case folding is a filesystem question (Linux says these differ), so the
    // rule stays case-sensitive until DOR-695 decides it in one place.
    name: 'a spelling that differs only in case (DOR-695 owns this)',
    root: '/work/project',
    candidate: '/work/Project/api',
    within: false,
  },
];
