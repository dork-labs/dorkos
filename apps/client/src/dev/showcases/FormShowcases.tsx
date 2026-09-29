import { useState } from 'react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  SegmentedControl,
  SegmentedControlItem,
  PermissionStateSwitch,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  BoundedNumberInput,
} from '@/layers/shared/ui';
import type { PermissionState } from '@dorkos/shared/permissions';

/** Application-owned form compositions. */
export function FormShowcases() {
  const [segmentValue, setSegmentValue] = useState('ask');
  const [segmentPair, setSegmentPair] = useState('grouped');
  const [permission, setPermission] = useState<PermissionState>('ask');
  const [floorPermission, setFloorPermission] = useState<PermissionState>('ask');

  return (
    <>
      <PlaygroundSection
        title="SegmentedControl"
        description="A few short choices, side by side. The raised thumb slides between them."
      >
        <ShowcaseLabel>Three stops</ShowcaseLabel>
        <ShowcaseDemo>
          {/* Click along the row: the raised surface travels rather than
              blinking off one stop and on at the next. */}
          <SegmentedControl
            value={segmentValue}
            onValueChange={setSegmentValue}
            aria-label="How much this agent may do on its own"
          >
            <SegmentedControlItem value="ask">Ask first</SegmentedControlItem>
            <SegmentedControlItem value="edits">Edits</SegmentedControlItem>
            <SegmentedControlItem value="full">Full autonomy</SegmentedControlItem>
          </SegmentedControl>
        </ShowcaseDemo>

        <ShowcaseLabel>Two stops</ShowcaseLabel>
        <ShowcaseDemo>
          <SegmentedControl
            value={segmentPair}
            onValueChange={setSegmentPair}
            className="w-auto"
            aria-label="Order the list"
          >
            <SegmentedControlItem value="grouped">Grouped</SegmentedControlItem>
            <SegmentedControlItem value="chronological">Chronological</SegmentedControlItem>
          </SegmentedControl>
        </ShowcaseDemo>

        <ShowcaseLabel>Disabled</ShowcaseLabel>
        <ShowcaseDemo>
          <SegmentedControl defaultValue="edits" disabled aria-label="Locked">
            <SegmentedControlItem value="ask">Ask first</SegmentedControlItem>
            <SegmentedControlItem value="edits">Edits</SegmentedControlItem>
            <SegmentedControlItem value="full">Full autonomy</SegmentedControlItem>
          </SegmentedControl>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="PermissionStateSwitch"
        description="What an agent may do in one area: Blocked, Ask, or Allowed. A floor area offers only the first two."
      >
        <ShowcaseLabel>Three states</ShowcaseLabel>
        <ShowcaseDemo>
          <PermissionStateSwitch value={permission} onChange={setPermission} aria-label="Rooms" />
        </ShowcaseDemo>

        <ShowcaseLabel>Floor area (never Allowed)</ShowcaseLabel>
        <ShowcaseDemo>
          <PermissionStateSwitch
            value={floorPermission}
            onChange={setFloorPermission}
            floor
            aria-label="Reach & secrets"
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Disabled while saving</ShowcaseLabel>
        <ShowcaseDemo>
          <PermissionStateSwitch value="allowed" onChange={() => {}} disabled aria-label="Tasks" />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Command"
        description="Search/autocomplete input with filterable list."
      >
        <ShowcaseDemo>
          <Command className="border shadow-md">
            <CommandInput placeholder="Search agents…" />
            <CommandList>
              <CommandEmpty>No results found.</CommandEmpty>
              <CommandGroup heading="Runtimes">
                <CommandItem>Claude Code</CommandItem>
                <CommandItem>Codex</CommandItem>
                <CommandItem>Custom Runtime</CommandItem>
              </CommandGroup>
              <CommandGroup heading="Actions">
                <CommandItem>Create new agent</CommandItem>
                <CommandItem>Import configuration</CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </ShowcaseDemo>
      </PlaygroundSection>

      <BoundedNumberInputShowcase />
    </>
  );
}

/** A number field that only reports numbers its bounds accept. */
function BoundedNumberInputShowcase() {
  const [value, setValue] = useState(5);
  return (
    <PlaygroundSection
      title="BoundedNumberInput"
      description="A number field that only reports numbers its bounds accept. Typing is not saving — it commits on blur or Enter, and Escape puts back the server's value. Out of range is refused, never clamped."
    >
      <ShowcaseLabel>Default (0–10) — try typing 500 and pressing Enter</ShowcaseLabel>
      <ShowcaseDemo>
        <BoundedNumberInput
          value={value}
          min={0}
          max={10}
          onCommit={setValue}
          aria-label="Retry count"
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Disabled — on hold, still shows its value</ShowcaseLabel>
      <ShowcaseDemo>
        <BoundedNumberInput
          value={3}
          min={0}
          max={10}
          onCommit={() => {}}
          disabled
          aria-label="Retry count (disabled)"
        />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
