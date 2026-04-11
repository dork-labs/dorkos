import { useState } from 'react';
import { Plus, FolderPlus, Store } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent, SidebarGroupAction } from '@/layers/shared/ui';
import { useAgentCreationStore } from '@/layers/shared/model';
import { useNavigate } from '@tanstack/react-router';

/**
 * Popover menu for adding agents — triggered by the + button
 * in the AGENTS sidebar group header.
 *
 * Three actions:
 * - Create agent -> opens CreateAgentDialog on 'new' tab
 * - Import project -> opens CreateAgentDialog on 'import' tab
 * - Browse Dork Hub -> navigates to /marketplace
 */
export function AddAgentMenu() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <SidebarGroupAction aria-label="Add agent">
          <Plus />
        </SidebarGroupAction>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-48 p-1">
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            useAgentCreationStore.getState().open();
          }}
          className="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm"
        >
          <Plus className="size-4" />
          Create agent
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            useAgentCreationStore.getState().open('import');
          }}
          className="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm"
        >
          <FolderPlus className="size-4" />
          Import project
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            navigate({ to: '/marketplace' });
          }}
          className="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm"
        >
          <Store className="size-4" />
          Browse Dork Hub
        </button>
      </PopoverContent>
    </Popover>
  );
}
