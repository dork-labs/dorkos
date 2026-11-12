/**
 * The app's own requests that carry a folder, a file or a name holding `/` or
 * `\`, built the way the client builds them (DOR-4212). Both remote listeners
 * must hand every one of these to the app: the filter refuses an encoded `/` or
 * `\` in a URL path, so each value rides in the query string or is a bare name.
 * The values are made up.
 */

/** One request the app sends, as method and origin-form target. */
export interface AppOwnRoute {
  method: 'GET' | 'POST' | 'DELETE';
  target: string;
}

const q = encodeURIComponent;

/** Requests the app sends today; each must pass both remote listeners. */
export const APP_OWN_ROUTES: readonly AppOwnRoute[] = [
  // Unblock agent (`clearMeshDenial`), a macOS and a Windows folder.
  { method: 'DELETE', target: `/api/mesh/denied?path=${q('/Users/qa/projects/demo-agent')}` },
  { method: 'DELETE', target: `/api/mesh/denied?path=${q('C:\\Users\\qa\\projects\\demo-agent')}` },
  // An upload's thumbnail (`FileAttachmentList`): the bare saved name, even
  // when a Windows server wrote the path, and the folder in `cwd`.
  { method: 'GET', target: `/api/uploads/8a3b2c1d-shot.png?cwd=${q('C:\\proj')}` },
  // A marketplace source saved by an older DorkOS, whose name holds a `/`.
  { method: 'DELETE', target: `/api/marketplace/sources?name=${q('acme/plugins')}` },
  { method: 'POST', target: `/api/marketplace/sources/refresh?name=${q('acme/plugins')}` },
  // A package name with a dot, which stays in the path.
  { method: 'POST', target: '/api/marketplace/packages/acme.flow-tools/install' },
];

/**
 * The shapes those requests had before DOR-4212. They stay refused: the fix
 * moved the values, it did not loosen the filter.
 */
export const RETIRED_ENCODED_PATHS: readonly string[] = [
  `/api/mesh/denied/${q('/Users/qa/projects/demo-agent')}`,
  `/api/mesh/denied/${q('C:\\Users\\qa\\projects\\demo-agent')}`,
  `/api/uploads/${q('C:\\proj\\.dork\\.temp\\uploads\\8a3b2c1d-shot.png')}`,
  `/api/marketplace/sources/${q('acme/plugins')}/refresh`,
];
