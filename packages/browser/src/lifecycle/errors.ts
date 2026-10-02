const codes = new Set([
  'BROWSER_LAUNCH_TIMEOUT',
  'BROWSER_STOPPED',
  'CAPTURE_FAILED',
  'CAPTURE_LIMIT',
  'CAPTURE_QUEUE_FULL',
  'CAPTURE_TIMEOUT',
  'COMMAND_UNSUPPORTED',
  'CONTEXT_CLOSE_TIMEOUT',
  'COUNTER_EXHAUSTED',
  'ENGINE_STOPPED',
  'EXECUTABLE_UNAVAILABLE',
  'FIXTURE_PROXY_CLOSE_FAILED',
  'FIXTURE_PROXY_UNAVAILABLE',
  'IDENTITY_MODE_UNAVAILABLE',
  'INITIAL_NAVIGATION_FAILED',
  'LIBRARY_UNAVAILABLE',
  'NETWORK_POLICY_UNSUPPORTED',
  'OPEN_FAILED',
  'OPERATION_FAILED',
  'PAGE_UNAVAILABLE',
  'PLATFORM_UNSUPPORTED',
  'POLICY_REFUSED',
  'POLICY_UNAVAILABLE',
  'PROCESS_ATTRIBUTION_UNAVAILABLE',
  'PROCESS_OBSERVATION_UNAVAILABLE',
  'PROFILE_IN_USE',
  'PROFILE_SETUP_FAILED',
  'PROFILE_UNCERTAIN',
  'RUNTIME_UNAVAILABLE',
  'STALE_BINDING',
  'UNKNOWN_NATIVE_HOLDER',
  'UNSAFE_DIRECTORY',
]);
const cleanupCodes = new Set([
  'PROFILE_UNCERTAIN',
  'observationUnavailable',
  'closeFailed',
  'processesRemain',
]);

/** Fixed lifecycle failures exclude paths, page contents and underlying stderr. */
export class BrowserLifecycleError extends Error {
  readonly code: string;
  readonly cleanupCode?: string;
  constructor(code: string, cleanupCode?: string) {
    const fixed = codes.has(code) ? code : 'OPERATION_FAILED';
    super(`Browser lifecycle failed: ${fixed}`);
    this.name = 'BrowserLifecycleError';
    this.code = fixed;
    if (cleanupCode !== undefined)
      this.cleanupCode = cleanupCodes.has(cleanupCode) ? cleanupCode : 'observationUnavailable';
    Object.freeze(this);
  }
}
