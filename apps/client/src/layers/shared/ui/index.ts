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
export { Banner, bannerVariants } from './banner';
export type { BannerVariant, BannerProps } from './banner';
export { Button, buttonVariants } from './button';
export type { ButtonSize, ButtonProps } from './button';
export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from './card';
export { Checkbox } from './checkbox';
export { Collapsible, CollapsibleTrigger, CollapsibleContent } from './collapsible';
export { Progress } from './progress';
export { PromptSuggestionChips } from './PromptSuggestionChips';
export type { PromptSuggestionChipsProps, PromptSuggestionChipSize } from './PromptSuggestionChips';
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
export { CopyButton } from './copy-button';
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
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from './dropdown-menu';
export { Feed } from './feed';
export {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from './field';
export { FieldCard, FieldCardContent, CollapsibleFieldCard } from './field-card';
export type { CollapsibleFieldCardProps } from './field-card';
export { FloatingPanel, clampGeometry } from './floating-panel';
export type { FloatingPanelProps, FloatingPanelGeometry } from './floating-panel';
export { HoverBorderGradient } from './hover-border-gradient';
export { HoverCard, HoverCardTrigger, HoverCardContent } from './hover-card';
export {
  IdentityAvatar,
  identityAvatarVariants,
  identityMarkRing,
  IDENTITY_MARK_GROUP,
  IDENTITY_BADGE_WAKE,
} from './identity-avatar';
export type { IdentityAvatarProps } from './identity-avatar';
export { AGENT_GLYPH, ORIGIN_GLYPH, platformGlyph } from './identity-glyphs';
export type { IdentityGlyph } from './identity-glyphs';
export {
  STATUS_DOT_COLOR,
  STATUS_DOT_HALO,
  STATUS_DOT_LABEL,
  STATUS_DOT_PULSE,
  statusDotClass,
} from './status-dot';
export type { IdentityStatus, StatusSignal } from './status-dot';
export { IdentityHoverCard } from './identity-hover-card';
export type {
  IdentityHoverCardProps,
  IdentityHoverCardDescriptor,
  IdentityHoverCardAgentInfo,
} from './identity-hover-card';
export { InlineCode } from './inline-code';
export { Kbd } from './kbd';
export { Label } from './label';
export { PasswordInput } from './password-input';
export type { PasswordInputProps } from './password-input';
export { ProvenanceChip } from './provenance-chip';
export type { ProvenanceChipProps } from './provenance-chip';
export { SettingRow, SwitchSettingRow } from './setting-row';
export type { SettingRowProps, SwitchSettingRowProps } from './setting-row';
export { SettingsPanel } from './settings-panel';
export type { SettingsPanelProps } from './settings-panel';
export { TabbedDialog } from './tabbed-dialog';
export type { TabbedDialogProps, TabbedDialogTab } from './tabbed-dialog';
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
export { RadioGroup, RadioGroupItem } from './radio-group';
export { SegmentedControl, SegmentedControlItem } from './segmented-control';
export {
  NavigationLayout,
  NavigationLayoutBody,
  NavigationLayoutSidebar,
  NavigationLayoutSectionHeader,
  NavigationLayoutItem,
  NavigationLayoutContent,
  NavigationLayoutPanel,
  NavigationLayoutPanelHeader,
  NavigationLayoutDialogHeader,
  useNavigationLayout,
} from './navigation-layout';
export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuGroup,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
} from './context-menu';
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
export {
  ResponsivePopover,
  ResponsivePopoverTrigger,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  useResponsivePopover,
} from './responsive-popover';
export {
  ResponsiveSheet,
  ResponsiveSheetTrigger,
  ResponsiveSheetClose,
  ResponsiveSheetContent,
  ResponsiveSheetHeader,
  ResponsiveSheetFooter,
  ResponsiveSheetTitle,
  ResponsiveSheetDescription,
  responsiveSheetContentVariants,
} from './responsive-sheet';
export { ScanLine } from './ScanLine';
export { ScrollArea, ScrollBar } from './scroll-area';
export {
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuTrigger,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuItem,
  ResponsiveDropdownMenuLabel,
  ResponsiveDropdownMenuRadioGroup,
  ResponsiveDropdownMenuRadioItem,
  ResponsiveDropdownMenuSeparator,
} from './responsive-dropdown-menu';
export {
  useResponsiveContextMenu,
  ResponsiveContextMenu,
  ResponsiveContextMenuTrigger,
  ResponsiveContextMenuContent,
  ResponsiveContextMenuItem,
  ResponsiveContextMenuSeparator,
} from './responsive-context-menu';
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
export { Slider } from './slider';
export { PermissionModeScopeNote } from './permission-mode-scope-note';
export type { PermissionModeScopeNoteProps } from './permission-mode-scope-note';
export { Switch } from './switch';
export type { SwitchSize, SwitchProps } from './switch';
export { TrustDial, TrustModeIcon, stopLabel, CANONICAL_TRUST_STOPS } from './trust-dial';
export type { TrustDialProps } from './trust-dial';
export { consentActionLabel, consentAsksNote } from './consent-ritual-copy';
export { UnattendedAutonomyDialog } from './unattended-autonomy-dialog';
export type { UnattendedAutonomyDialogProps } from './unattended-autonomy-dialog';
export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
} from './table';
export { DataTable } from './data-table';
export type { DataTableProps } from './data-table';
export { Tabs, TabsList, TabsTrigger, TabsContent } from './tabs';
export { useRovingTabList } from './use-roving-tab-list';
export type {
  RovingTabProps,
  RovingTabListApi,
  TabActivationSource,
  UseRovingTabListParams,
} from './use-roving-tab-list';
export type { TabsListProps } from './tabs';
export { DirectoryPicker } from './DirectoryPicker';
export { PageContainer } from './page-container';
export type { PageContainerProps } from './page-container';
export { PathInput } from './path-input';
export type { PathInputProps } from './path-input';
export { Skeleton } from './skeleton';
export { Textarea } from './textarea';
export { Toaster } from './sonner';
export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from './tooltip';
export { ConnectionStatusBanner } from './ConnectionStatusBanner';
export { FeatureDisabledState } from './FeatureDisabledState';
export { LinkSafetyModal } from './link-safety-modal';
export { MarkdownContent } from './markdown-content';
export { MarkdownErrorBoundary } from './markdown-error-boundary';
export { MentionPill, mentionPillVariants } from './mention-pill';
export type { MentionPillProps } from './mention-pill';
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
  TextField,
  TextareaField,
  SelectField,
  SwitchField,
  CheckboxField,
  PasswordField,
  SubmitButton,
} from './form-fields';
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
  SidebarMobileNavigationClose,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
  SidebarContext,
} from './sidebar';
export { FilterBar } from './filter-bar';
export { RouteErrorFallback } from './route-error-fallback';
export { NotFoundFallback } from './not-found-fallback';
export { AppCrashFallback } from './app-crash-fallback';
export {
  TourSpotlight,
  type TourSpotlightProps,
  TourCaption,
  type TourCaptionProps,
  useAnchorResolver,
  usePrefersReducedMotion,
  ANCHOR_TIMEOUT_MS,
  ANCHOR_POLL_INTERVAL_MS,
  type AnchorStatus,
  type AnchorResolution,
} from './tour-spotlight';

// ── The sidebar's two shared primitives, and the menu-as-data they both render ──
export { SidebarMenuNodes, SidebarMenuSurface, useGuardedMenuNodes } from './sidebar-menu-node';
export type {
  SidebarMenuActionNode,
  SidebarMenuChoice,
  SidebarMenuNode,
  SidebarMenuNote,
  SidebarMenuRadioSubmenu,
  SidebarMenuSubmenu,
  SidebarMenuVariant,
} from './sidebar-menu-node';
export { SidebarRow, SIDEBAR_ROW_INSET } from './sidebar-row';
export type { RowDragBindings, SidebarRowMenu, SidebarRowProps } from './sidebar-row';
export { SectionHeader } from './section-header';
export type { SectionHeaderProps } from './section-header';
