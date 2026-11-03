import { useState } from 'react';
import { Copy, Pencil, Settings, Trash2 } from 'lucide-react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Input,
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuItem,
  ResponsiveDropdownMenuLabel,
  ResponsiveDropdownMenuSeparator,
  ResponsiveDropdownMenuTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/layers/shared/ui';

/** A menu holding every row a menu can: icon, group name, tick, nesting, long, off, destructive. */
function EveryRowMenu() {
  const [checked, setChecked] = useState(true);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Every row</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>This room</DropdownMenuLabel>
        <DropdownMenuItem>
          <Pencil />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem>
          <Copy />
          Copy link
        </DropdownMenuItem>
        <DropdownMenuCheckboxItem checked={checked} onCheckedChange={setChecked}>
          Mute notifications
        </DropdownMenuCheckboxItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Move to</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem>Marketing</DropdownMenuItem>
            <DropdownMenuItem>Build</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem>
          <span className="truncate">
            A very long label that has to stop at the edge of the menu and not wrap
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem disabled>Archive (only the owner can)</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive">
          <Trash2 />
          Delete room
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One surface and one set of rules for everything above the page. */
export function OverlaySurfaceShowcases() {
  return (
    <>
      <PlaygroundSection
        title="Menus"
        description="32px rows, 44px on a phone. The highlight is the row tint, and space splits the groups."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <ShowcaseLabel>Dropdown</ShowcaseLabel>
            <ShowcaseDemo>
              <EveryRowMenu />
            </ShowcaseDemo>
          </div>
          <div>
            <ShowcaseLabel>Becomes a drawer on a phone</ShowcaseLabel>
            <ShowcaseDemo>
              <ResponsiveDropdownMenu>
                <ResponsiveDropdownMenuTrigger asChild>
                  <Button variant="outline">Responsive menu</Button>
                </ResponsiveDropdownMenuTrigger>
                <ResponsiveDropdownMenuContent align="start">
                  <ResponsiveDropdownMenuLabel>This room</ResponsiveDropdownMenuLabel>
                  <ResponsiveDropdownMenuItem icon={Pencil}>Rename</ResponsiveDropdownMenuItem>
                  <ResponsiveDropdownMenuItem
                    icon={Copy}
                    description="Anyone in the room can open it"
                  >
                    Copy link
                  </ResponsiveDropdownMenuItem>
                  <ResponsiveDropdownMenuSeparator />
                  <ResponsiveDropdownMenuItem icon={Settings}>Settings</ResponsiveDropdownMenuItem>
                </ResponsiveDropdownMenuContent>
              </ResponsiveDropdownMenu>
            </ShowcaseDemo>
          </div>
          <div>
            <ShowcaseLabel>Context menu</ShowcaseLabel>
            <ShowcaseDemo>
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <div className="bg-row-group rounded-md p-6 text-center text-sm">
                    Right-click here
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem>
                    Open
                    <ContextMenuShortcut>⌘O</ContextMenuShortcut>
                  </ContextMenuItem>
                  <ContextMenuItem>
                    Copy
                    <ContextMenuShortcut>⌘C</ContextMenuShortcut>
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive">Delete</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            </ShowcaseDemo>
          </div>
          <div>
            <ShowcaseLabel>Select</ShowcaseLabel>
            <ShowcaseDemo>
              <Select defaultValue="week">
                <SelectTrigger className="w-48" aria-label="Period">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="day">Today</SelectItem>
                  <SelectItem value="week">This week</SelectItem>
                  <SelectItem value="month">This month</SelectItem>
                  <SelectItem value="year" disabled>
                    This year
                  </SelectItem>
                </SelectContent>
              </Select>
            </ShowcaseDemo>
          </div>
        </div>
      </PlaygroundSection>

      <PlaygroundSection
        title="Floating surfaces"
        description="Grow out of what opened them. Tooltips wait 400ms and never show on touch."
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <ShowcaseLabel>Disabled button: the reason also shows on touch</ShowcaseLabel>
            <ShowcaseDemo>
              <Button variant="outline" disabledReason="Only the owner can archive this.">
                Archive room
              </Button>
            </ShowcaseDemo>
          </div>
          <div>
            <ShowcaseLabel>Popover</ShowcaseLabel>
            <ShowcaseDemo>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline">Open popover</Button>
                </PopoverTrigger>
                <PopoverContent>
                  <PopoverHeader>
                    <PopoverTitle>Agent status</PopoverTitle>
                    <PopoverDescription>Running, with 42 tasks done.</PopoverDescription>
                  </PopoverHeader>
                </PopoverContent>
              </Popover>
            </ShowcaseDemo>
          </div>
          <div>
            <ShowcaseLabel>Hover card</ShowcaseLabel>
            <ShowcaseDemo>
              <HoverCard>
                <HoverCardTrigger asChild>
                  <Button variant="ghost">Rest here</Button>
                </HoverCardTrigger>
                <HoverCardContent>
                  <p className="text-sm font-semibold">Ana</p>
                  <p className="text-muted-foreground text-xs">Writes the weekly report.</p>
                </HoverCardContent>
              </HoverCard>
            </ShowcaseDemo>
          </div>
          <div>
            <ShowcaseLabel>Tooltip</ShowcaseLabel>
            <ShowcaseDemo>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Room settings">
                    <Settings />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Room settings</TooltipContent>
              </Tooltip>
            </ShowcaseDemo>
          </div>
        </div>
      </PlaygroundSection>

      <PlaygroundSection
        title="Modal surfaces"
        description="No border, a left-aligned title, and focus that never lands on the close button or a destructive one."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <ShowcaseLabel>Dialog, with a menu inside and a long body</ShowcaseLabel>
            <ShowcaseDemo>
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="outline">Open dialog</Button>
                </DialogTrigger>
                <DialogContent className="flex max-h-[28rem] flex-col">
                  <DialogHeader>
                    <DialogTitle>New room</DialogTitle>
                    <DialogDescription>Name it, then pick who joins.</DialogDescription>
                  </DialogHeader>
                  <DialogBody>
                    <div className="space-y-3 pr-2">
                      <Input aria-label="Room name" placeholder="Room name" />
                      <EveryRowMenu />
                      {Array.from({ length: 14 }, (_, i) => (
                        <p key={i} className="text-muted-foreground text-sm">
                          Line {i + 1}, so the edge shows while this body scrolls.
                        </p>
                      ))}
                    </div>
                  </DialogBody>
                  <DialogFooter>
                    <Button variant="outline">Cancel</Button>
                    <Button>Create</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </ShowcaseDemo>
          </div>
          <div>
            <ShowcaseLabel>Alert dialog: opens on Cancel</ShowcaseLabel>
            <ShowcaseDemo>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive">Delete room</Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this room?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Its messages go too. This can't be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction variant="destructive">Delete</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </ShowcaseDemo>
          </div>
          <div>
            <ShowcaseLabel>Side sheet</ShowcaseLabel>
            <ShowcaseDemo>
              <Sheet>
                <SheetTrigger asChild>
                  <Button variant="outline">Open sheet</Button>
                </SheetTrigger>
                <SheetContent>
                  <SheetHeader>
                    <SheetTitle>Room details</SheetTitle>
                    <SheetDescription>Who's here, and what it's for.</SheetDescription>
                  </SheetHeader>
                </SheetContent>
              </Sheet>
            </ShowcaseDemo>
          </div>
          <div>
            <ShowcaseLabel>Drawer, with a grabber when it can be dragged</ShowcaseLabel>
            <ShowcaseDemo>
              <Drawer>
                <DrawerTrigger asChild>
                  <Button variant="outline">Open drawer</Button>
                </DrawerTrigger>
                <DrawerContent className="max-h-[85vh]">
                  <DrawerHeader>
                    <DrawerTitle>Room details</DrawerTitle>
                    <DrawerDescription>Who's here, and what it's for.</DrawerDescription>
                  </DrawerHeader>
                  <div className="text-muted-foreground px-4 pb-6 text-sm">
                    Drag it down, tap the scrim, or press Escape.
                  </div>
                </DrawerContent>
              </Drawer>
            </ShowcaseDemo>
          </div>
        </div>
      </PlaygroundSection>
    </>
  );
}
