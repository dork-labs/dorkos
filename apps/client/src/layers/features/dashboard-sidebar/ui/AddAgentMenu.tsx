import { useState } from 'react';
import { Plus, FolderPlus, FolderKanban, Store } from 'lucide-react';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  SidebarGroupAction,
  Separator,
} from '@/layers/shared/ui';
import { useAgentCreationStore, useImportProjectsStore } from '@/layers/shared/model';
import { useNavigate } from '@tanstack/react-router';

interface AddAgentMenuProps {
  /** Open the inline group-create flow (adds a "New group" entry to the menu). */
  onNewGroup?: () => void;
}

/**
 * Popover menu for adding agents — triggered by the + button
 * in the AGENTS sidebar group header.
 *
 * Actions:
 * - Create agent -> opens CreateAgentDialog on the gallery
 * - Bring in a project -> opens the standalone import dialog
 * - Browse Marketplace -> navigates to /marketplace
 * - New group -> opens the inline group-create flow (when `onNewGroup` is given)
 */
export function AddAgentMenu({ onNewGroup }: AddAgentMenuProps) {
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
            useImportProjectsStore.getState().open();
          }}
          className="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm"
        >
          <FolderPlus className="size-4" />
          Bring in a project
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
          Browse Marketplace
        </button>
        {onNewGroup && (
          <>
            <Separator className="my-1" />
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onNewGroup();
              }}
              className="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm"
            >
              <FolderKanban className="size-4" />
              New group
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
