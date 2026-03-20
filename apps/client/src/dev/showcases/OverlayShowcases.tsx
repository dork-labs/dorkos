import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  Button,
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
  Popover,
  PopoverTrigger,
  PopoverContent,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetClose,
  ResponsiveDialog,
  ResponsiveDialogTrigger,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogClose,
  ResponsiveDialogFullscreenToggle,
} from '@/layers/shared/ui';

/** Overlay component showcases: Dialog, AlertDialog, Popover, DropdownMenu, Sheet, ResponsiveDialog. */
export function OverlayShowcases() {
  return (
    <>
      <PlaygroundSection
        title="Dialog"
        description="Modal dialog with title, description, and actions."
      >
        <ShowcaseDemo>
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">Open Dialog</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Agent</DialogTitle>
                <DialogDescription>
                  Configure a new autonomous agent for your project.
                </DialogDescription>
              </DialogHeader>
              <p className="text-muted-foreground text-sm">Dialog body content goes here.</p>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline">Cancel</Button>
                </DialogClose>
                <DialogClose asChild>
                  <Button>Create</Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection title="AlertDialog" description="Destructive confirmation dialog.">
        <ShowcaseDemo>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive">Delete Agent</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Are you sure?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete the agent and all its data. This action cannot be
                  undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction>Delete</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection title="Popover" description="Floating panel anchored to a trigger.">
        <ShowcaseDemo>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline">Open Popover</Button>
            </PopoverTrigger>
            <PopoverContent className="w-64">
              <div className="space-y-2">
                <h4 className="text-sm font-medium">Agent Status</h4>
                <p className="text-muted-foreground text-xs">
                  The agent is currently running and has processed 42 tasks.
                </p>
              </div>
            </PopoverContent>
          </Popover>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection title="DropdownMenu" description="Contextual menu triggered by a button.">
        <ShowcaseDemo>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">Open Menu</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>View Details</DropdownMenuItem>
              <DropdownMenuItem>Edit Agent</DropdownMenuItem>
              <DropdownMenuItem>Duplicate</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive">Delete</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection title="Sheet" description="Slide-out side panel from any edge.">
        <ShowcaseLabel>Right (default)</ShowcaseLabel>
        <ShowcaseDemo>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline">Open Right Sheet</Button>
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>Agent Details</SheetTitle>
                <SheetDescription>View and edit agent configuration.</SheetDescription>
              </SheetHeader>
              <div className="text-muted-foreground py-4 text-sm">
                Sheet body content goes here.
              </div>
              <SheetClose asChild>
                <Button variant="outline" className="mt-2">
                  Close
                </Button>
              </SheetClose>
            </SheetContent>
          </Sheet>
        </ShowcaseDemo>

        <ShowcaseLabel>Left</ShowcaseLabel>
        <ShowcaseDemo>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline">Open Left Sheet</Button>
            </SheetTrigger>
            <SheetContent side="left">
              <SheetHeader>
                <SheetTitle>Navigation</SheetTitle>
                <SheetDescription>Side navigation panel.</SheetDescription>
              </SheetHeader>
              <div className="text-muted-foreground py-4 text-sm">Navigation content here.</div>
            </SheetContent>
          </Sheet>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="ResponsiveDialog"
        description="Dialog on desktop, drawer on mobile. Supports fullscreen toggle."
      >
        <ShowcaseDemo>
          <ResponsiveDialog>
            <ResponsiveDialogTrigger asChild>
              <Button variant="outline">Open Responsive Dialog</Button>
            </ResponsiveDialogTrigger>
            <ResponsiveDialogContent>
              <ResponsiveDialogHeader>
                <ResponsiveDialogTitle>Session Settings</ResponsiveDialogTitle>
                <ResponsiveDialogDescription>
                  Configure the current session. On mobile, this renders as a bottom drawer.
                </ResponsiveDialogDescription>
                <ResponsiveDialogFullscreenToggle />
              </ResponsiveDialogHeader>
              <div className="text-muted-foreground py-4 text-sm">
                Responsive dialog body content.
              </div>
              <ResponsiveDialogFooter>
                <ResponsiveDialogClose asChild>
                  <Button variant="outline">Cancel</Button>
                </ResponsiveDialogClose>
                <ResponsiveDialogClose asChild>
                  <Button>Save</Button>
                </ResponsiveDialogClose>
              </ResponsiveDialogFooter>
            </ResponsiveDialogContent>
          </ResponsiveDialog>
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
