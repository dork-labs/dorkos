/**
 * The last segment of a path — what a person calls the folder or the file.
 *
 * **Deliberately off the `shared/lib` barrel**, and imported by its own path.
 * The sidebar model's purity contract
 * (`build-sidebar-model.contracts.test.ts`) bans that barrel outright, because
 * it is a door onto the transport — so a helper the pure rules need has to be
 * reachable without it. Same construction, and same reason, as
 * `overnight-boundary`: this module imports nothing, which is what lets the
 * contract whitelist it as the narrow thing it looks like.
 *
 * Written here rather than imported from `node:path`, which the browser bundle
 * has no business pulling in for one string operation. Both separators are
 * handled because a cwd on Windows uses the other one.
 *
 * @param path - An absolute or relative path.
 */
export function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}
