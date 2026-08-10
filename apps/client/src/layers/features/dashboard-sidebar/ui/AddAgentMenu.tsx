import { useState } from 'react';
import { Plus, FolderPlus, FolderInput, MessageSquare, Store, Wand2 } from 'lucide-react';
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
   * Open the direct-message picker.
   *
   * **Here on purpose, and temporarily.** Direct messages are created from the
   * Direct messages section's "+", and BC-32 withholds that section until a
   * conversation exists — so on a fresh install there was no way to start the
   * first one. The design's answer is the single New button (design-decisions
   * §7), which P2.4 lands; until it does, the way in lives on the header that
   * always exists when there is anybody to message. P2.4 removes this entry.
   */
  onNewMessage?: () => void;
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
 * - New agent… -> opens CreateAgentDialog on the gallery
 * - Bring in a project -> opens the standalone import dialog
 * - Browse Marketplace -> navigates to /marketplace
 * - New group… -> opens the inline group-create flow (when `onNewGroup` is given)
 * - Smart-group presets + "Custom rules…" -> one-click or dialog-based smart
 *   group creation (DOR-338), shown only once `smartGroupPresets` is non-empty
 *
 * **The two shared verbs are spelled exactly as the Agents section header
 * spells them** — same words, same icons, same trailing `…` — because this "+"
 * sits in that header's own row and the pair reading differently was the drift
 * spec `rooms` §14.1 exists to stop. The header's renderer appends the ellipsis
 * from `opensInput`; here it is written out, since these buttons are plain
 * markup with no node list behind them.
 */
export function AddAgentMenu({
  onNewGroup,
  onNewMessage,
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
          New agent…
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            useImportProjectsStore.getState().open();
          }}
          className="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm"
        >
          {/* Not FolderPlus: that icon now belongs to "New group…", which the
              section header spells the same way, and one popover cannot use one
              glyph for two different things. */}
          <FolderInput className="size-4" />
          Bring in a project
        </button>
        {onNewMessage && (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onNewMessage();
            }}
            className="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm"
          >
            <MessageSquare className="size-4" />
            New message…
          </button>
        )}
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
              <FolderPlus className="size-4" />
              New group…
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
