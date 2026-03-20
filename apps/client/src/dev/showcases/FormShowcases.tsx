import { useState } from 'react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  Input,
  Textarea,
  Switch,
  Label,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Checkbox,
  RadioGroup,
  RadioGroupItem,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/layers/shared/ui';

/** Form component showcases: Input, Textarea, Switch, Select, Tabs, Checkbox, RadioGroup, Label, Command. */
export function FormShowcases() {
  const [switchOn, setSwitchOn] = useState(true);
  const [checkA, setCheckA] = useState(true);
  const [checkB, setCheckB] = useState(false);
  const [radioValue, setRadioValue] = useState('claude-code');

  return (
    <>
      <PlaygroundSection title="Input" description="Text input field variants.">
        <ShowcaseLabel>Default</ShowcaseLabel>
        <ShowcaseDemo>
          <Input placeholder="Type something..." />
        </ShowcaseDemo>

        <ShowcaseLabel>With Label</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="space-y-1.5">
            <Label htmlFor="demo-email">Email</Label>
            <Input id="demo-email" type="email" placeholder="kai@example.com" />
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Disabled</ShowcaseLabel>
        <ShowcaseDemo>
          <Input disabled placeholder="Disabled input" />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection title="Textarea" description="Multi-line text input.">
        <ShowcaseLabel>Default</ShowcaseLabel>
        <ShowcaseDemo>
          <Textarea placeholder="Write a message..." />
        </ShowcaseDemo>

        <ShowcaseLabel>With Content</ShowcaseLabel>
        <ShowcaseDemo>
          <Textarea defaultValue="This textarea has some initial content that spans multiple lines to demonstrate the component." />
        </ShowcaseDemo>

        <ShowcaseLabel>Disabled</ShowcaseLabel>
        <ShowcaseDemo>
          <Textarea disabled placeholder="Disabled textarea" />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection title="Switch" description="Toggle switch for binary settings.">
        <ShowcaseDemo>
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <Switch id="demo-switch-on" checked={switchOn} onCheckedChange={setSwitchOn} />
              <Label htmlFor="demo-switch-on">{switchOn ? 'Enabled' : 'Disabled'}</Label>
            </div>
            <div className="flex items-center gap-3">
              <Switch id="demo-switch-disabled" disabled />
              <Label htmlFor="demo-switch-disabled">Disabled</Label>
            </div>
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection title="Select" description="Dropdown select component.">
        <ShowcaseDemo>
          <Select>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Select a runtime" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="claude-code">Claude Code</SelectItem>
              <SelectItem value="codex">Codex</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent>
          </Select>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection title="Tabs" description="Tabbed content navigation.">
        <ShowcaseDemo>
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="settings">Settings</TabsTrigger>
              <TabsTrigger value="logs">Logs</TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              <p className="text-muted-foreground text-sm">Overview content goes here.</p>
            </TabsContent>
            <TabsContent value="settings">
              <p className="text-muted-foreground text-sm">Settings content goes here.</p>
            </TabsContent>
            <TabsContent value="logs">
              <p className="text-muted-foreground text-sm">Logs content goes here.</p>
            </TabsContent>
          </Tabs>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection title="Checkbox" description="Checkboxes for multi-select form fields.">
        <ShowcaseLabel>Default</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex items-center gap-2">
            <Checkbox id="demo-check-a" checked={checkA} onCheckedChange={(v) => setCheckA(!!v)} />
            <Label htmlFor="demo-check-a">Enable notifications</Label>
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Unchecked</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex items-center gap-2">
            <Checkbox id="demo-check-b" checked={checkB} onCheckedChange={(v) => setCheckB(!!v)} />
            <Label htmlFor="demo-check-b">Auto-approve tool calls</Label>
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Disabled</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Checkbox id="demo-check-disabled-on" checked disabled />
              <Label htmlFor="demo-check-disabled-on">Checked (disabled)</Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="demo-check-disabled-off" disabled />
              <Label htmlFor="demo-check-disabled-off">Unchecked (disabled)</Label>
            </div>
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="RadioGroup"
        description="Radio buttons for single-select form fields."
      >
        <ShowcaseLabel>Default</ShowcaseLabel>
        <ShowcaseDemo>
          <RadioGroup value={radioValue} onValueChange={setRadioValue}>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="claude-code" id="demo-radio-cc" />
              <Label htmlFor="demo-radio-cc">Claude Code</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="codex" id="demo-radio-codex" />
              <Label htmlFor="demo-radio-codex">Codex</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="custom" id="demo-radio-custom" />
              <Label htmlFor="demo-radio-custom">Custom Runtime</Label>
            </div>
          </RadioGroup>
        </ShowcaseDemo>

        <ShowcaseLabel>With descriptions</ShowcaseLabel>
        <ShowcaseDemo>
          <RadioGroup defaultValue="fast">
            <div className="flex items-start gap-2">
              <RadioGroupItem value="fast" id="demo-radio-fast" className="mt-0.5" />
              <div>
                <Label htmlFor="demo-radio-fast">Fast mode</Label>
                <p className="text-muted-foreground text-xs">
                  Lower latency, reduced context window
                </p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <RadioGroupItem value="thorough" id="demo-radio-thorough" className="mt-0.5" />
              <div>
                <Label htmlFor="demo-radio-thorough">Thorough mode</Label>
                <p className="text-muted-foreground text-xs">
                  Full context, extended thinking enabled
                </p>
              </div>
            </div>
          </RadioGroup>
        </ShowcaseDemo>

        <ShowcaseLabel>Disabled</ShowcaseLabel>
        <ShowcaseDemo>
          <RadioGroup defaultValue="locked" disabled>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="locked" id="demo-radio-locked" />
              <Label htmlFor="demo-radio-locked">Locked option</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="other" id="demo-radio-other-dis" />
              <Label htmlFor="demo-radio-other-dis">Unavailable</Label>
            </div>
          </RadioGroup>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Label"
        description="Standalone label component for form accessibility."
      >
        <ShowcaseDemo>
          <div className="space-y-3">
            <Label>Default label</Label>
            <div className="space-y-1.5">
              <Label htmlFor="demo-label-input">Associated input</Label>
              <Input id="demo-label-input" placeholder="Click the label above" />
            </div>
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Command"
        description="Search/autocomplete input with filterable list."
      >
        <ShowcaseDemo>
          <Command className="border shadow-md">
            <CommandInput placeholder="Search agents..." />
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
    </>
  );
}
