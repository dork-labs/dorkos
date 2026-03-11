import { useState } from 'react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
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
} from '@/layers/shared/ui';

/** Form component showcases: Input, Textarea, Switch, Select, Tabs. */
export function FormShowcases() {
  const [switchOn, setSwitchOn] = useState(true);

  return (
    <>
      <PlaygroundSection
        title="Input"
        description="Text input field variants."
      >
        <ShowcaseLabel>Default</ShowcaseLabel>
        <Input placeholder="Type something..." />

        <ShowcaseLabel>With Label</ShowcaseLabel>
        <div className="space-y-1.5">
          <Label htmlFor="demo-email">Email</Label>
          <Input id="demo-email" type="email" placeholder="kai@example.com" />
        </div>

        <ShowcaseLabel>Disabled</ShowcaseLabel>
        <Input disabled placeholder="Disabled input" />
      </PlaygroundSection>

      <PlaygroundSection
        title="Textarea"
        description="Multi-line text input."
      >
        <ShowcaseLabel>Default</ShowcaseLabel>
        <Textarea placeholder="Write a message..." />

        <ShowcaseLabel>With Content</ShowcaseLabel>
        <Textarea defaultValue="This textarea has some initial content that spans multiple lines to demonstrate the component." />

        <ShowcaseLabel>Disabled</ShowcaseLabel>
        <Textarea disabled placeholder="Disabled textarea" />
      </PlaygroundSection>

      <PlaygroundSection
        title="Switch"
        description="Toggle switch for binary settings."
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Switch
              id="demo-switch-on"
              checked={switchOn}
              onCheckedChange={setSwitchOn}
            />
            <Label htmlFor="demo-switch-on">
              {switchOn ? 'Enabled' : 'Disabled'}
            </Label>
          </div>
          <div className="flex items-center gap-3">
            <Switch id="demo-switch-disabled" disabled />
            <Label htmlFor="demo-switch-disabled">Disabled</Label>
          </div>
        </div>
      </PlaygroundSection>

      <PlaygroundSection
        title="Select"
        description="Dropdown select component."
      >
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
      </PlaygroundSection>

      <PlaygroundSection
        title="Tabs"
        description="Tabbed content navigation."
      >
        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <p className="text-muted-foreground text-sm">
              Overview content goes here.
            </p>
          </TabsContent>
          <TabsContent value="settings">
            <p className="text-muted-foreground text-sm">
              Settings content goes here.
            </p>
          </TabsContent>
          <TabsContent value="logs">
            <p className="text-muted-foreground text-sm">
              Logs content goes here.
            </p>
          </TabsContent>
        </Tabs>
      </PlaygroundSection>
    </>
  );
}
