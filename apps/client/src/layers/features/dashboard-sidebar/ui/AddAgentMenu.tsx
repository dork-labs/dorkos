import { useState } from 'react';
import { Plus, FolderPlus, FolderKanban, Store, Wand2 } from 'lucide-react';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  SidebarGroupAction,
  Separator,
} from '@/layers/shared/ui';
import { useAgentCreationStore, useImportProjectsStore } from '@/layers/shared/model';
import { useNavigate } from '@tanstack/react-router';
import type { SmartGroupPreset } from '../model/smart-group-presets';

interface AddAgentMenuProps {
  /** Open the inline group-create flow (adds a "New group" entry to the menu). */
  onNewGroup?: () => void;
  /**
   * Smart-group preset chips (DOR-338) — one click creates the group with
   * that preset's rules. Empty below the disclosure threshold, so the menu
   * shows no new chrome for small fleets (spec §5).
   */
  smartGroupPresets?: SmartGroupPreset[];
  /** Create a smart group immediately from a preset. */
  onCreatePresetSmartGroup?: (preset: SmartGroupPreset) => void;
  /** Open the custom-rules dialog for a from-scratch smart group. */
  onOpenSmartGroupDialog?: () => void;
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
 * - Smart-group presets + "Custom rules…" -> one-click or dialog-based smart
 *   group creation (DOR-338), shown only once `smartGroupPresets` is non-empty
 */
export function AddAgentMenu({
  onNewGroup,
  smartGroupPresets = [],
  onCreatePresetSmartGroup,
  onOpenSmartGroupDialog,
}: AddAgentMenuProps) {
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
        {smartGroupPresets.length > 0 && (
          <>
            <Separator className="my-1" />
            <p className="text-muted-foreground px-2 pt-1 pb-0.5 text-xs font-medium tracking-wide uppercase">
              Smart group
            </p>
            {smartGroupPresets.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onCreatePresetSmartGroup?.(preset);
                }}
                className="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm"
              >
                <Wand2 className="size-4" />
                {preset.label}
              </button>
            ))}
            {onOpenSmartGroupDialog && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onOpenSmartGroupDialog();
                }}
                className="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm"
              >
                <Wand2 className="size-4" />
                Custom rules…
              </button>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
