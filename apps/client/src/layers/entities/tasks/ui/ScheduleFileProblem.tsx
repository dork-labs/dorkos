/** The file fault stays visible even when schedule settings collapse. */
export function ScheduleFileProblem() {
  return (
    <span role="alert" className="text-status-warning-fg block text-xs break-words">
      <code>permissions</code> is in the wrong place, so this schedule won’t run. Move it under{' '}
      <code>schedule</code>.
    </span>
  );
}
