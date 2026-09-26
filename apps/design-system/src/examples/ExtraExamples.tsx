import { useState } from 'react';
import {
  Button,
  Label,
  Slider,
  Progress,
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuCheckboxItem,
  ContextMenuSeparator,
} from '@dork-labs/ui';
import { Section, Demo } from './example-layout';

/** Selection and progress examples use the same exports as application screens. */
export function ExtraExamples() {
  const [amount, setAmount] = useState([40]);
  const [range, setRange] = useState([20, 80]);
  const [progress, setProgress] = useState(40);
  const [checked, setChecked] = useState(true);
  const [action, setAction] = useState('No action selected');
  return (
    <>
      <Section
        id="slider"
        title="Slider"
        description="Drag a thumb or use the arrow keys to change a value."
      >
        <Demo>
          <div className="space-y-6">
            <div className="space-y-3">
              <Label htmlFor="catalog-slider">Volume: {amount[0]}%</Label>
              <Slider
                id="catalog-slider"
                aria-label="Volume"
                value={amount}
                onValueChange={setAmount}
              />
            </div>
            <div className="space-y-3">
              <p className="text-sm">Range: {range.join('–')}</p>
              <Slider aria-label="Range" value={range} onValueChange={setRange} />
            </div>
            <Slider aria-label="Unavailable slider" defaultValue={[50]} disabled />
          </div>
        </Demo>
      </Section>
      <Section
        id="progress"
        title="Progress"
        description="A changing value with an accessible name."
      >
        <Demo>
          <div className="space-y-4">
            <Progress value={progress} aria-label="Example progress" />
            <p className="text-sm">{progress}% complete</p>
            <Button variant="outline" onClick={() => setProgress((value) => (value + 20) % 120)}>
              Advance progress
            </Button>
          </div>
        </Demo>
      </Section>
      <Section
        id="context-menu"
        title="ContextMenu"
        description="Right-click the example or press Shift+F10 to choose an action."
      >
        <ContextMenu>
          <ContextMenuTrigger
            className="border-dui-border block rounded-lg border border-dashed p-8 text-center"
            tabIndex={0}
          >
            Context menu area
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={() => setAction('Opened example')}>
              Open example
            </ContextMenuItem>
            <ContextMenuItem disabled>Unavailable action</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuCheckboxItem checked={checked} onCheckedChange={setChecked}>
              Show details
            </ContextMenuCheckboxItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger>More actions</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuItem onSelect={() => setAction('Copied example')}>
                  Copy example
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
          </ContextMenuContent>
        </ContextMenu>
        <p role="status" className="text-dui-muted-foreground text-sm">
          {action}
        </p>
      </Section>
    </>
  );
}
