/**
 * "Shows in" for one mini app's right-panel tabs, on its card in Settings →
 * Extensions (spec `mini-app-placement`).
 *
 * Two choices, Everywhere or Only in…, then the agents, channels and pages it
 * shows for, each removable, and an Add picker. Anything hidden by "Hide here"
 * in the panel is listed under Hidden in, removable the same way. Reset drops
 * the saved choice, which puts the mini app's own default back.
 *
 * @module features/extensions/ui/PanelTabPlacementEditor
 */
import { useMemo, useState } from 'react';
import { Bot, FileText, Hash, Plus, X } from 'lucide-react';
import {
  PLACEMENT_ANY,
  effectivePlacement,
  savedPlacementFor,
  type MiniAppPlacement,
  type PlacementTargets,
} from '@dorkos/shared/mini-app-placement';
import { getAgentDisplayName } from '@dorkos/shared/validation';
import { usePanelTabPlacements, useSetPanelTabPlacement } from '@/layers/entities/config';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { roomDisplayTitle, useRooms } from '@/layers/entities/room';
import { useSlotContributions, type RightPanelContribution } from '@/layers/shared/model';
import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SegmentedControl,
  SegmentedControlItem,
} from '@/layers/shared/ui';
import { PLACEMENT_PAGES, placementPageLabel } from '../lib/placement-pages';

type Kind = keyof PlacementTargets;

/** One place a chip names. */
interface Place {
  kind: Kind;
  id: string;
}

/**
 * The editors for every right-panel tab one mini app added, or nothing when it
 * added none (or is not running, so its tabs are not registered).
 *
 * @param props.extensionId - The mini app.
 */
export function PanelTabPlacementSection({ extensionId }: { extensionId: string }) {
  const tabs = useSlotContributions('right-panel').filter((c) => c.extensionId === extensionId);
  if (tabs.length === 0) return null;
  return (
    <div className="space-y-3 pt-1" data-testid={`panel-tab-placement-${extensionId}`}>
      {tabs.map((tab) => (
        <PanelTabPlacementEditor key={tab.id} tab={tab} labelled={tabs.length > 1} />
      ))}
    </div>
  );
}

/** Names for agent and room ids, so chips read as names rather than ids. */
function usePlaceNames() {
  const agents = useRegisteredAgents().data?.agents;
  const rooms = useRooms().data;
  return useMemo(() => {
    const agentNames = new Map((agents ?? []).map((a) => [a.id, getAgentDisplayName(a)]));
    const roomNames = new Map((rooms ?? []).map((r) => [r.id, roomDisplayTitle(r)]));
    return { agents: agents ?? [], rooms: rooms ?? [], agentNames, roomNames };
  }, [agents, rooms]);
}

/**
 * One tab's editor.
 *
 * @param props.tab - The tab.
 * @param props.labelled - Name the tab above its controls (when its mini app has several).
 */
function PanelTabPlacementEditor({
  tab,
  labelled,
}: {
  tab: RightPanelContribution;
  labelled: boolean;
}) {
  const saved = savedPlacementFor(usePanelTabPlacements(), tab.id);
  const { setPlacement } = useSetPanelTabPlacement();
  const names = usePlaceNames();
  const placement = effectivePlacement(saved, tab.declaredPlacement);
  const everywhere = placement.show.pages.includes(PLACEMENT_ANY);

  // Only `show` and `hide`: a saved entry also carries `tab`, which is not part
  // of a placement.
  const save = (next: MiniAppPlacement) =>
    setPlacement(tab.id, { show: next.show, hide: next.hide });
  const nameOf = (place: Place): string => {
    if (place.kind === 'agents') return names.agentNames.get(place.id) ?? 'An agent that is gone';
    if (place.kind === 'rooms') return names.roomNames.get(place.id) ?? 'A channel that is gone';
    return placementPageLabel(place.id);
  };
  // `show`'s wildcard is the Everywhere choice above, so it is no chip. In
  // `hide` it is one: hidden everywhere must be visible, and removable, here.
  const listed = (targets: PlacementTargets, withAny: boolean): Place[] =>
    (['agents', 'rooms', 'pages'] as const).flatMap((kind) =>
      targets[kind].filter((id) => withAny || id !== PLACEMENT_ANY).map((id) => ({ kind, id }))
    );
  const without = (targets: PlacementTargets, place: Place): PlacementTargets => ({
    ...targets,
    [place.kind]: targets[place.kind].filter((id) => id !== place.id),
  });

  const shown = listed(placement.show, false);
  const hidden = listed(placement.hide, true);

  return (
    <div className="space-y-2" data-testid={`panel-tab-placement-${tab.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm">{labelled ? `${tab.title} tab shows` : 'Panel tab shows'}</span>
        <SegmentedControl
          value={everywhere ? 'everywhere' : 'only'}
          onValueChange={(mode) =>
            save({
              hide: placement.hide,
              show:
                mode === 'everywhere'
                  ? { ...placement.show, pages: [PLACEMENT_ANY] }
                  : {
                      ...placement.show,
                      pages: placement.show.pages.filter((p) => p !== PLACEMENT_ANY),
                    },
            })
          }
          aria-label={`Where the ${tab.title} tab shows`}
        >
          <SegmentedControlItem value="everywhere">Everywhere</SegmentedControlItem>
          <SegmentedControlItem value="only">Only in…</SegmentedControlItem>
        </SegmentedControl>
        {saved && (
          <button
            type="button"
            onClick={() => setPlacement(tab.id, null)}
            className="text-muted-foreground hover:text-foreground focus-ring rounded-sm text-xs underline underline-offset-2"
          >
            {tab.declaredPlacement ? 'Use its default' : 'Reset'}
          </button>
        )}
      </div>

      {!everywhere && (
        <div className="flex flex-wrap items-center gap-1.5">
          {shown.map((place) => (
            <PlaceChip
              key={`${place.kind}:${place.id}`}
              place={place}
              name={nameOf(place)}
              removeLabel={`Remove ${nameOf(place)}`}
              onRemove={() => save({ ...placement, show: without(placement.show, place) })}
            />
          ))}
          <AddPlace
            tabTitle={tab.title}
            names={names}
            taken={placement.show}
            onAdd={(place) =>
              save({
                show: {
                  ...placement.show,
                  [place.kind]: [...placement.show[place.kind], place.id],
                },
                hide: without(placement.hide, place),
              })
            }
          />
          {shown.length === 0 && (
            <span className="text-muted-foreground text-xs">Shows nowhere yet. Add a place.</span>
          )}
        </div>
      )}

      {hidden.length > 0 && (
        <div
          role="group"
          aria-labelledby={`${tab.id}-hidden-in`}
          className="flex flex-wrap items-center gap-1.5"
        >
          <span id={`${tab.id}-hidden-in`} className="text-muted-foreground text-xs">
            Hidden in
          </span>
          {hidden.map((place) => (
            <PlaceChip
              key={`${place.kind}:${place.id}`}
              place={place}
              name={nameOf(place)}
              removeLabel={`Show in ${nameOf(place)} again`}
              onRemove={() => save({ ...placement, hide: without(placement.hide, place) })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const KIND_ICON = { agents: Bot, rooms: Hash, pages: FileText } as const;

/** A removable chip naming one place. */
function PlaceChip({
  place,
  name,
  removeLabel,
  onRemove,
}: {
  place: Place;
  name: string;
  /** The remove button's name, which says what removing does. */
  removeLabel: string;
  onRemove: () => void;
}) {
  const Icon = KIND_ICON[place.kind];
  return (
    <span className="bg-muted inline-flex h-6 items-center gap-1 rounded-md pr-0.5 pl-1.5 text-xs">
      <Icon className="text-muted-foreground size-3" aria-hidden />
      <span className="max-w-40 truncate">{name}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeLabel}
        className="text-muted-foreground hover:text-foreground focus-ring rounded-sm p-0.5"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

/** The Add picker: pages, agents and channels not already listed, searchable. */
function AddPlace({
  tabTitle,
  names,
  taken,
  onAdd,
}: {
  tabTitle: string;
  names: ReturnType<typeof usePlaceNames>;
  taken: PlacementTargets;
  onAdd: (place: Place) => void;
}) {
  const [open, setOpen] = useState(false);
  const pick = (place: Place) => {
    onAdd(place);
    setOpen(false);
  };
  const pages = PLACEMENT_PAGES.filter((p) => !taken.pages.includes(p.key));
  const agents = names.agents.filter((a) => !taken.agents.includes(a.id));
  const rooms = names.rooms.filter((r) => !taken.rooms.includes(r.id));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-xs"
          aria-label={`Add a place for the ${tabTitle} tab`}
        >
          <Plus className="size-3" />
          Add
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Find an agent, channel or page" />
          <CommandList className="max-h-64">
            <CommandEmpty>Nothing matches.</CommandEmpty>
            {agents.length > 0 && (
              <CommandGroup heading="Agents">
                {agents.map((agent) => (
                  <CommandItem
                    key={agent.id}
                    value={`agent ${getAgentDisplayName(agent)} ${agent.id}`}
                    onSelect={() => pick({ kind: 'agents', id: agent.id })}
                  >
                    <Bot className="size-3.5" />
                    {getAgentDisplayName(agent)}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {rooms.length > 0 && (
              <CommandGroup heading="Channels and DMs">
                {rooms.map((room) => (
                  <CommandItem
                    key={room.id}
                    value={`room ${roomDisplayTitle(room)} ${room.id}`}
                    onSelect={() => pick({ kind: 'rooms', id: room.id })}
                  >
                    <Hash className="size-3.5" />
                    {roomDisplayTitle(room)}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {pages.length > 0 && (
              <CommandGroup heading="Pages">
                {pages.map((page) => (
                  <CommandItem
                    key={page.key}
                    value={`page ${page.label}`}
                    onSelect={() => pick({ kind: 'pages', id: page.key })}
                  >
                    <FileText className="size-3.5" />
                    {page.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
