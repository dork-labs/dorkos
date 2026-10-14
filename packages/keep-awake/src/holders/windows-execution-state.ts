/**
 * Windows: a PowerShell holder that calls `SetThreadExecutionState` and then
 * waits for the owning process to exit.
 *
 * `ES_CONTINUOUS | ES_SYSTEM_REQUIRED` (`0x80000001`), plus `ES_DISPLAY_REQUIRED`
 * (`0x80000003` in all) when a hold asks for the screen too, belongs to the
 * calling thread and is cleared by Windows when that thread ends, so killing the
 * holder (or the owner dying, which ends `Wait-Process`) releases it. No native
 * module.
 *
 * The script travels as `-EncodedCommand` (UTF-16LE, base64): no quoting rules
 * to get wrong, and the only variable in it is the pid, interpolated as an
 * integer.
 *
 * @module keep-awake/holders/windows-execution-state
 */
import type { HolderCommand } from './types.js';

/**
 * The PowerShell script one holder runs.
 *
 * The flags are a long literal on purpose: PowerShell 5.1 reads a bare
 * `0x80000001` as a negative Int32, which will not convert to the `uint`
 * parameter.
 *
 * @param watchPid - The process whose exit ends the hold.
 * @param display - Whether the screen is kept on too (`ES_DISPLAY_REQUIRED`).
 */
export function windowsExecutionStateScript(watchPid: number, display = false): string {
  const flags = display ? '0x80000003L' : '0x80000001L';
  return [
    '$signature = \'[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);\'',
    "$power = Add-Type -MemberDefinition $signature -Name 'ExecutionState' -Namespace 'DorkOS' -PassThru",
    `[void]$power::SetThreadExecutionState([uint32]${flags})`,
    `Wait-Process -Id ${Math.trunc(watchPid)}`,
  ].join('\n');
}

/**
 * The PowerShell command line for one holder.
 *
 * @param watchPid - The process whose exit ends the hold.
 * @param display - Whether the screen is kept on too.
 */
export function windowsExecutionStateCommand(watchPid: number, display = false): HolderCommand {
  const encoded = Buffer.from(windowsExecutionStateScript(watchPid, display), 'utf16le').toString(
    'base64'
  );
  return {
    mechanism: 'windows-execution-state',
    command: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encoded,
    ],
    renews: false,
    display,
  };
}
