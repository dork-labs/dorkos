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
} from '@dork-labs/ui';
import { Section, Demo, DemoLabel } from './example-layout';

/** Production examples moved with their shared primitives. */
export function OverlayExamples() {
  return (
    <>
      <Section
        id="dialog"
        title="Dialog"
        description="Modal dialog with title, description, and actions."
      >
        <Demo>
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">Open Dialog</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create agent</DialogTitle>
                <DialogDescription>
                  Configure a new autonomous agent for your project.
                </DialogDescription>
              </DialogHeader>
              <p className="text-dui-muted-foreground text-sm">Dialog body content goes here.</p>
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
        </Demo>
      </Section>
      <Section id="alert-dialog" title="AlertDialog" description="Destructive confirmation dialog.">
        <Demo>
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
        </Demo>
      </Section>
      <Section id="popover" title="Popover" description="Floating panel anchored to a trigger.">
        <Demo>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline">Open Popover</Button>
            </PopoverTrigger>
            <PopoverContent className="w-64">
              <div className="space-y-2">
                <h4 className="text-sm font-medium">Agent Status</h4>
                <p className="text-dui-muted-foreground text-xs">
                  The agent is currently running and has processed 42 tasks.
                </p>
              </div>
            </PopoverContent>
          </Popover>
        </Demo>
      </Section>
      <Section
        id="dropdown-menu"
        title="DropdownMenu"
        description="Contextual menu triggered by a button."
      >
        <Demo>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">Open Menu</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>View Details</DropdownMenuItem>
              <DropdownMenuItem>Edit Agent</DropdownMenuItem>
              <DropdownMenuItem>Duplicate</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-dui-destructive">Delete</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </Demo>
      </Section>
      <Section id="sheet" title="Sheet" description="Slide-out side panel from any edge.">
        <DemoLabel>Right (default)</DemoLabel>
        <Demo>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline">Open Right Sheet</Button>
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>Agent Details</SheetTitle>
                <SheetDescription>View and edit agent configuration.</SheetDescription>
              </SheetHeader>
              <div className="text-dui-muted-foreground py-4 text-sm">
                Sheet body content goes here.
              </div>
              <SheetClose asChild>
                <Button variant="outline" className="mt-2">
                  Close
                </Button>
              </SheetClose>
            </SheetContent>
          </Sheet>
        </Demo>

        <DemoLabel>Left</DemoLabel>
        <Demo>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline">Open Left Sheet</Button>
            </SheetTrigger>
            <SheetContent side="left">
              <SheetHeader>
                <SheetTitle>Navigation</SheetTitle>
                <SheetDescription>Side navigation panel.</SheetDescription>
              </SheetHeader>
              <div className="text-dui-muted-foreground py-4 text-sm">Navigation content here.</div>
            </SheetContent>
          </Sheet>
        </Demo>
      </Section>
    </>
  );
}
