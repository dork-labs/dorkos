import { useState } from 'react';
import {
  UiProvider,
  Button,
  Popover,
  PopoverTrigger,
  PopoverContent,
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@dork-labs/ui';
import { Section } from './example-layout';

function ThemeIsland({ theme }: { theme: 'light' | 'dark' }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [selection, setSelection] = useState('No selection');
  return (
    <div
      data-theme-island={theme}
      className={`${theme} border-dui-border bg-dui-background text-dui-foreground min-w-0 space-y-4 rounded-lg border p-5`}
    >
      <h3 className="text-sm font-semibold">{theme === 'light' ? 'Light' : 'Dark'} island</h3>
      <UiProvider portalContainer={host}>
        <div className="flex flex-wrap gap-3">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" className="h-auto min-h-11 max-w-full whitespace-normal">
                Open {theme} popover
              </Button>
            </PopoverTrigger>
            <PopoverContent
              data-theme-overlay={theme}
              className="max-w-[calc(100vw-2rem)] space-y-4"
            >
              <p className="text-sm">This panel inherits the {theme} island.</p>
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    className="h-auto min-h-11 max-w-full whitespace-normal"
                  >
                    {theme} nested menu
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent data-theme-menu={theme}>
                  <DropdownMenuItem onSelect={() => setSelection('First choice')}>
                    First choice
                  </DropdownMenuItem>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>More choices</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent data-theme-submenu={theme}>
                      <DropdownMenuItem onSelect={() => setSelection('Nested choice')}>
                        Nested choice
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </DropdownMenuContent>
              </DropdownMenu>
              <Dialog>
                <DialogTrigger asChild>
                  <Button>Open {theme} nested dialog</Button>
                </DialogTrigger>
                <DialogContent data-theme-dialog={theme}>
                  <DialogHeader>
                    <DialogTitle>{theme} dialog</DialogTitle>
                    <DialogDescription>
                      The same portal host owns this nested dialog.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogClose asChild>
                    <Button
                      variant="outline"
                      className="h-auto min-h-11 max-w-full whitespace-normal"
                    >
                      Return to {theme} popover
                    </Button>
                  </DialogClose>
                </DialogContent>
              </Dialog>
            </PopoverContent>
          </Popover>
        </div>
        <p className="text-dui-muted-foreground text-sm">{selection}</p>
        <div ref={setHost} data-portal-host={theme} />
      </UiProvider>
    </div>
  );
}

/** Independent theme hosts demonstrate actual portal inheritance and nesting. */
export function PortalExamples() {
  return (
    <Section
      id="portal-themes"
      title="Portal themes"
      description="Each panel keeps its own theme when a menu or dialog opens."
    >
      <div className="grid gap-4 md:grid-cols-2">
        <ThemeIsland theme="light" />
        <ThemeIsland theme="dark" />
      </div>
      <UiProvider portalContainer={null}>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" className="h-auto min-h-11 max-w-full whitespace-normal">
              Open document popover
            </Button>
          </PopoverTrigger>
          <PopoverContent data-document-portal className="max-w-[calc(100vw-2rem)]">
            <p className="text-sm">
              This example uses the document theme and the default body portal.
            </p>
          </PopoverContent>
        </Popover>
      </UiProvider>
    </Section>
  );
}
