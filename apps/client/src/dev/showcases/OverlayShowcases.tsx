import { PlaygroundSection } from '../PlaygroundSection';
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
} from '@/layers/shared/ui';

/** Overlay component showcases: Dialog, AlertDialog, Popover, DropdownMenu. */
export function OverlayShowcases() {
  return (
    <>
      <PlaygroundSection
        title="Dialog"
        description="Modal dialog with title, description, and actions."
      >
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
            <p className="text-muted-foreground text-sm">
              Dialog body content goes here.
            </p>
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
      </PlaygroundSection>

      <PlaygroundSection
        title="AlertDialog"
        description="Destructive confirmation dialog."
      >
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive">Delete Agent</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Are you sure?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete the agent and all its data. This
                action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </PlaygroundSection>

      <PlaygroundSection
        title="Popover"
        description="Floating panel anchored to a trigger."
      >
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
      </PlaygroundSection>

      <PlaygroundSection
        title="DropdownMenu"
        description="Contextual menu triggered by a button."
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">Open Menu</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>View Details</DropdownMenuItem>
            <DropdownMenuItem>Edit Agent</DropdownMenuItem>
            <DropdownMenuItem>Duplicate</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive">
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PlaygroundSection>
    </>
  );
}
