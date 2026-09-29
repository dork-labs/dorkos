import { useState } from 'react';
import {
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
} from '@dork-labs/ui';
import { Section, Demo, DemoLabel } from './example-layout';

/** Production examples moved with their shared primitives. */
export function ControlExamples() {
  const [switchOn, setSwitchOn] = useState(true);
  const [checkA, setCheckA] = useState(true);
  const [checkB, setCheckB] = useState(false);
  const [radioValue, setRadioValue] = useState('claude-code');
  return (
    <>
      <Section id="textarea" title="Textarea" description="Multi-line text input.">
        <DemoLabel>Default</DemoLabel>
        <Demo>
          <Textarea placeholder="Write a message…" />
        </Demo>

        <DemoLabel>With Content</DemoLabel>
        <Demo>
          <Textarea defaultValue="This textarea has some initial content that spans multiple lines to demonstrate the component." />
        </Demo>

        <DemoLabel>Disabled</DemoLabel>
        <Demo>
          <Textarea disabled placeholder="Disabled textarea" />
        </Demo>
      </Section>
      <Section id="switch" title="Switch" description="Toggle switch for binary settings.">
        <DemoLabel>States</DemoLabel>
        <Demo>
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
        </Demo>

        {/* The thumb's travel has to match the track's width at every size, so
            every size is drawn checked — that is the state where a mismatch
            shows. These four opt out of `responsive` so each holds still at the
            size it names; the row below shows what the ladder does to them. */}
        <DemoLabel>Sizes</DemoLabel>
        <Demo>
          <div className="flex flex-wrap items-center gap-4">
            <Switch
              size="sm"
              responsive={false}
              checked
              aria-label="Small"
              onCheckedChange={() => {}}
            />
            <Switch
              size="md"
              responsive={false}
              checked
              aria-label="Medium"
              onCheckedChange={() => {}}
            />
            <Switch
              size="lg"
              responsive={false}
              checked
              aria-label="Large"
              onCheckedChange={() => {}}
            />
            <Switch
              size="xl"
              responsive={false}
              checked
              aria-label="Extra large"
              onCheckedChange={() => {}}
            />
          </div>
        </Demo>

        {/* `responsive` composes with `size` — every one of these climbs two
            steps on a phone and one on a tablet, then settles back. Resize the
            window past 640px and 768px to watch the whole row step down. */}
        <DemoLabel>Responsive (on by default — resize to see them step)</DemoLabel>
        <Demo>
          <div className="flex flex-wrap items-center gap-4">
            <Switch size="sm" checked aria-label="Small, responsive" onCheckedChange={() => {}} />
            <Switch checked aria-label="Medium, responsive" onCheckedChange={() => {}} />
            <Switch size="lg" checked aria-label="Large, responsive" onCheckedChange={() => {}} />
          </div>
        </Demo>
      </Section>
      <Section id="select" title="Select" description="Dropdown select component.">
        <Demo>
          <Select>
            <SelectTrigger className="w-48 max-w-full">
              <SelectValue placeholder="Select a runtime" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="claude-code">Claude Code</SelectItem>
              <SelectItem value="codex">Codex</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent>
          </Select>
        </Demo>
      </Section>
      <Section id="tabs" title="Tabs" description="Tabbed content navigation.">
        <Demo>
          <Tabs defaultValue="overview">
            <TabsList className="h-auto max-w-full flex-wrap justify-start">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="settings">Settings</TabsTrigger>
              <TabsTrigger value="logs">Logs</TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              <p className="text-dui-muted-foreground text-sm">Overview content goes here.</p>
            </TabsContent>
            <TabsContent value="settings">
              <p className="text-dui-muted-foreground text-sm">Settings content goes here.</p>
            </TabsContent>
            <TabsContent value="logs">
              <p className="text-dui-muted-foreground text-sm">Logs content goes here.</p>
            </TabsContent>
          </Tabs>
        </Demo>
      </Section>
      <Section
        id="checkbox"
        title="Checkbox"
        description="Checkboxes for multi-select form fields."
      >
        <DemoLabel>Default</DemoLabel>
        <Demo>
          <div className="flex items-center gap-2">
            <Checkbox id="demo-check-a" checked={checkA} onCheckedChange={(v) => setCheckA(!!v)} />
            <Label htmlFor="demo-check-a">Enable notifications</Label>
          </div>
        </Demo>

        <DemoLabel>Unchecked</DemoLabel>
        <Demo>
          <div className="flex items-center gap-2">
            <Checkbox id="demo-check-b" checked={checkB} onCheckedChange={(v) => setCheckB(!!v)} />
            <Label htmlFor="demo-check-b">Auto-approve tool calls</Label>
          </div>
        </Demo>

        <DemoLabel>Disabled</DemoLabel>
        <Demo>
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
        </Demo>
      </Section>
      <Section
        id="radio-group"
        title="RadioGroup"
        description="Radio buttons for single-select form fields."
      >
        <DemoLabel>Default</DemoLabel>
        <Demo>
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
        </Demo>

        <DemoLabel>With descriptions</DemoLabel>
        <Demo>
          <RadioGroup defaultValue="fast">
            <div className="flex items-start gap-2">
              <RadioGroupItem value="fast" id="demo-radio-fast" className="mt-0.5" />
              <div>
                <Label htmlFor="demo-radio-fast">Fast mode</Label>
                <p className="text-dui-muted-foreground text-xs">
                  Lower latency, reduced context window
                </p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <RadioGroupItem value="thorough" id="demo-radio-thorough" className="mt-0.5" />
              <div>
                <Label htmlFor="demo-radio-thorough">Thorough mode</Label>
                <p className="text-dui-muted-foreground text-xs">
                  Full context, extended thinking enabled
                </p>
              </div>
            </div>
          </RadioGroup>
        </Demo>

        <DemoLabel>Disabled</DemoLabel>
        <Demo>
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
        </Demo>
      </Section>
    </>
  );
}
