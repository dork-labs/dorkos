/**
 * Shared UI primitives — shadcn/ui components (new-york style, neutral gray palette).
 *
 * @module shared/ui
 */
export {
  AlertDialog,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from './alert-dialog';
export { Badge, badgeVariants } from './badge';
export { Button, buttonVariants } from './button';
export type { ButtonSize, ButtonProps } from './button';
export { Collapsible, CollapsibleTrigger, CollapsibleContent } from './collapsible';
export { Input } from './input';
export type { InputProps } from './input';
export {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
} from './command';
export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from './dialog';
export {
  Drawer,
  DrawerPortal,
  DrawerOverlay,
  DrawerClose,
  DrawerTrigger,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
} from './drawer';
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from './dropdown-menu';
export { HoverBorderGradient } from './hover-border-gradient';
export { HoverCard, HoverCardTrigger, HoverCardContent } from './hover-card';
export { Kbd } from './kbd';
export { Label } from './label';
export { PathBreadcrumb } from './path-breadcrumb';
export {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverAnchor,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
} from './popover';
export {
  NavigationLayout,
  NavigationLayoutBody,
  NavigationLayoutSidebar,
  NavigationLayoutItem,
  NavigationLayoutContent,
  NavigationLayoutPanel,
  NavigationLayoutPanelHeader,
  NavigationLayoutDialogHeader,
  useNavigationLayout,
} from './navigation-layout';
export {
  ResponsiveDialog,
  ResponsiveDialogTrigger,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogClose,
  ResponsiveDialogBody,
  ResponsiveDialogFullscreenToggle,
  useResponsiveDialog,
} from './responsive-dialog';
export { ScanLine } from './ScanLine';
export { ScrollArea, ScrollBar } from './scroll-area';
export {
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuTrigger,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuLabel,
  ResponsiveDropdownMenuRadioGroup,
  ResponsiveDropdownMenuRadioItem,
} from './responsive-dropdown-menu';
export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from './select';
export type { SelectTriggerProps, SelectItemProps } from './select';
export { Separator } from './separator';
export { Switch } from './switch';
export type { SwitchSize, SwitchProps } from './switch';
export { Tabs, TabsList, TabsTrigger, TabsContent } from './tabs';
export type { TabsListProps } from './tabs';
export { DirectoryPicker } from './DirectoryPicker';
export { Skeleton } from './skeleton';
export { Textarea } from './textarea';
export { Toaster } from './sonner';
export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from './tooltip';
export { FeatureDisabledState } from './FeatureDisabledState';
export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
} from './sheet';
export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
  SidebarContext,
} from './sidebar';
