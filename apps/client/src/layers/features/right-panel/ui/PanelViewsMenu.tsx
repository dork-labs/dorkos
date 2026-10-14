import { Plus, SquareTerminal } from 'lucide-react';
import {
  Button,
  ContributedIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/layers/shared/ui';
import type { PanelView } from '../model/use-panel-views';

/** Add and switch views from one always-reachable menu, including tabs beyond the visible strip. */
export function PanelViewsMenu({
  views,
  activeId,
  onActivate,
  onCreateTerminal,
  onStopTerminal,
  onCreateBrowser,
  onCreateDocument,
  onRemoveDocument,
  onPinDocument,
  documentPinned,
}: {
  views: PanelView[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onCreateTerminal?: () => void;
  onStopTerminal?: () => void;
  onCreateBrowser?: () => void;
  onCreateDocument?: () => void;
  onRemoveDocument?: () => void;
  onPinDocument?: () => void;
  documentPinned?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-md"
          aria-label="Add view"
          className="size-11 shrink-0 lg:size-7"
        >
          <Plus className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-[70dvh] min-w-48 overflow-y-auto [&_[role=menuitem]]:min-h-11 lg:[&_[role=menuitem]]:min-h-0"
      >
        <DropdownMenuLabel>Views</DropdownMenuLabel>
        {views.map((view) => (
          <DropdownMenuItem
            key={view.id}
            aria-current={view.id === activeId ? 'true' : undefined}
            onSelect={() => onActivate(view.id)}
          >
            <ContributedIcon icon={view.icon} />
            <span className="max-w-64 truncate">{view.title}</span>
            {view.id === activeId && (
              <span aria-hidden="true" className="ml-auto">
                ✓
              </span>
            )}
          </DropdownMenuItem>
        ))}
        {onCreateTerminal && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onCreateTerminal}>
              <SquareTerminal />
              New terminal
            </DropdownMenuItem>
          </>
        )}
        {onCreateBrowser && (
          <DropdownMenuItem onSelect={onCreateBrowser}>New browser page</DropdownMenuItem>
        )}
        {onCreateDocument && (
          <DropdownMenuItem onSelect={onCreateDocument}>New document</DropdownMenuItem>
        )}
        {onPinDocument && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onPinDocument}>
              {documentPinned ? 'Unpin document' : 'Pin document'}
            </DropdownMenuItem>
          </>
        )}
        {onRemoveDocument && (
          <DropdownMenuItem onSelect={onRemoveDocument}>Remove document</DropdownMenuItem>
        )}
        {onStopTerminal && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onStopTerminal}>Stop terminal</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
