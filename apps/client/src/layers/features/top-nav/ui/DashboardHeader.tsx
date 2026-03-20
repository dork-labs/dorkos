import { CommandPaletteTrigger } from './CommandPaletteTrigger';

/** Dashboard route header — title + command palette trigger. */
export function DashboardHeader() {
  return (
    <>
      <span className="text-muted-foreground text-sm font-medium">Dashboard</span>
      <div className="flex-1" />
      <CommandPaletteTrigger />
    </>
  );
}
