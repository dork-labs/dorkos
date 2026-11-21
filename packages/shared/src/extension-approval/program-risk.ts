/** Programs whose permission also allows starting any other program. */
const RUNS_ANYTHING = new Set([
  'sh',
  'bash',
  'zsh',
  'cmd',
  'powershell',
  'pwsh',
  'node',
  'python',
  'python3',
  'osascript',
  'env',
  'xargs',
]);

/**
 * Classify a shell or interpreter by file name, including Windows paths.
 * Shared by package reviews and extension permission cards; this is display
 * information, never an authorization rule.
 */
export function runsAnyProgram(name: string): boolean {
  const base = name.split(/[\\/]/).pop() ?? name;
  return RUNS_ANYTHING.has(base.toLowerCase().replace(/\.exe$/, ''));
}
