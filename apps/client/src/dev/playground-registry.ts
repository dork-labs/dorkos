/** Page identifiers for the dev playground. */
export type Page = 'overview' | 'tokens' | 'components' | 'chat';

/** A single searchable/navigable section in the playground. */
export interface PlaygroundSection {
  /** Anchor ID matching the section element's id attribute. */
  id: string;
  /** Display name shown in TOC and search. */
  title: string;
  /** Which page this section lives on. */
  page: Page;
  /** Showcase group for search grouping. */
  category: string;
  /** Alias keywords for fuzzy search matching. */
  keywords: string[];
}

/**
 * Design token sections from TokensPage.
 *
 * IDs must match `slugify(title)` from `lib/slugify.ts`.
 */
export const TOKENS_SECTIONS: PlaygroundSection[] = [
  {
    id: 'semantic-colors',
    title: 'Semantic Colors',
    page: 'tokens',
    category: 'Colors',
    keywords: ['color', 'palette', 'theme', 'background', 'foreground', 'primary', 'secondary', 'destructive', 'muted', 'accent', 'brand'],
  },
  {
    id: 'status-colors',
    title: 'Status Colors',
    page: 'tokens',
    category: 'Colors',
    keywords: ['color', 'status', 'success', 'error', 'warning', 'info', 'pending', 'semantic'],
  },
  {
    id: 'sidebar-colors',
    title: 'Sidebar Colors',
    page: 'tokens',
    category: 'Colors',
    keywords: ['color', 'sidebar', 'navigation', 'panel'],
  },
  {
    id: 'typography',
    title: 'Typography',
    page: 'tokens',
    category: 'Typography',
    keywords: ['type', 'font', 'text', 'scale', 'weight', 'family', 'sans', 'mono', 'size'],
  },
  {
    id: 'spacing',
    title: 'Spacing',
    page: 'tokens',
    category: 'Layout',
    keywords: ['space', 'gap', 'padding', 'margin', 'grid', '8pt'],
  },
  {
    id: 'border-radius',
    title: 'Border Radius',
    page: 'tokens',
    category: 'Shape',
    keywords: ['radius', 'rounded', 'corner', 'shape', 'border'],
  },
  {
    id: 'shadows',
    title: 'Shadows',
    page: 'tokens',
    category: 'Shape',
    keywords: ['shadow', 'elevation', 'depth', 'box-shadow'],
  },
  {
    id: 'icon-and-button-sizes',
    title: 'Icon & Button Sizes',
    page: 'tokens',
    category: 'Layout',
    keywords: ['icon', 'button', 'size', 'height', 'width', 'dimension'],
  },
];

/**
 * Component sections from ComponentsPage.
 *
 * Sources: ButtonShowcases, FormShowcases, FeedbackShowcases,
 * NavigationShowcases, SidebarShowcases, OverlayShowcases, DataDisplayShowcases.
 */
export const COMPONENTS_SECTIONS: PlaygroundSection[] = [
  // ButtonShowcases
  {
    id: 'button',
    title: 'Button',
    page: 'components',
    category: 'Buttons',
    keywords: ['btn', 'click', 'action', 'variant', 'destructive', 'ghost', 'outline', 'brand', 'link'],
  },
  {
    id: 'badge',
    title: 'Badge',
    page: 'components',
    category: 'Buttons',
    keywords: ['label', 'tag', 'chip', 'status', 'pill'],
  },
  {
    id: 'hoverbordergradient',
    title: 'HoverBorderGradient',
    page: 'components',
    category: 'Buttons',
    keywords: ['gradient', 'animated', 'border', 'hover', 'aceternity'],
  },
  {
    id: 'kbd',
    title: 'Kbd',
    page: 'components',
    category: 'Buttons',
    keywords: ['keyboard', 'shortcut', 'key', 'hotkey', 'hint'],
  },
  // FormShowcases
  {
    id: 'input',
    title: 'Input',
    page: 'components',
    category: 'Forms',
    keywords: ['text', 'field', 'form', 'type', 'placeholder', 'disabled'],
  },
  {
    id: 'textarea',
    title: 'Textarea',
    page: 'components',
    category: 'Forms',
    keywords: ['text', 'multiline', 'form', 'input', 'field'],
  },
  {
    id: 'switch',
    title: 'Switch',
    page: 'components',
    category: 'Forms',
    keywords: ['toggle', 'checkbox', 'boolean', 'on', 'off', 'setting'],
  },
  {
    id: 'select',
    title: 'Select',
    page: 'components',
    category: 'Forms',
    keywords: ['dropdown', 'picker', 'option', 'choice', 'form'],
  },
  {
    id: 'tabs',
    title: 'Tabs',
    page: 'components',
    category: 'Forms',
    keywords: ['tab', 'navigation', 'panel', 'switch', 'content'],
  },
  {
    id: 'checkbox',
    title: 'Checkbox',
    page: 'components',
    category: 'Forms',
    keywords: ['check', 'tick', 'multi-select', 'boolean', 'form', 'toggle'],
  },
  {
    id: 'radiogroup',
    title: 'RadioGroup',
    page: 'components',
    category: 'Forms',
    keywords: ['radio', 'single-select', 'option', 'choice', 'form', 'group'],
  },
  {
    id: 'label',
    title: 'Label',
    page: 'components',
    category: 'Forms',
    keywords: ['label', 'form', 'accessibility', 'input', 'htmlfor'],
  },
  {
    id: 'command',
    title: 'Command',
    page: 'components',
    category: 'Forms',
    keywords: ['search', 'autocomplete', 'combobox', 'filter', 'cmdk', 'palette'],
  },
  // FeedbackShowcases
  {
    id: 'skeleton',
    title: 'Skeleton',
    page: 'components',
    category: 'Feedback',
    keywords: ['loading', 'placeholder', 'pulse', 'shimmer', 'spinner'],
  },
  {
    id: 'separator',
    title: 'Separator',
    page: 'components',
    category: 'Feedback',
    keywords: ['divider', 'line', 'horizontal', 'vertical', 'hr'],
  },
  {
    id: 'tooltip',
    title: 'Tooltip',
    page: 'components',
    category: 'Feedback',
    keywords: ['hover', 'popover', 'hint', 'label', 'info'],
  },
  {
    id: 'hovercard',
    title: 'HoverCard',
    page: 'components',
    category: 'Feedback',
    keywords: ['hover', 'card', 'preview', 'popover', 'trigger'],
  },
  {
    id: 'collapsible',
    title: 'Collapsible',
    page: 'components',
    category: 'Feedback',
    keywords: ['collapse', 'expand', 'toggle', 'accordion', 'disclosure'],
  },
  {
    id: 'toaster',
    title: 'Toaster',
    page: 'components',
    category: 'Feedback',
    keywords: ['toast', 'notification', 'sonner', 'success', 'error', 'info', 'warning'],
  },
  // NavigationShowcases
  {
    id: 'navigationlayout',
    title: 'NavigationLayout',
    page: 'components',
    category: 'Navigation',
    keywords: ['nav', 'sidebar', 'settings', 'panel', 'layout', 'menu', 'item'],
  },
  // SidebarShowcases
  {
    id: 'sessionitem',
    title: 'SessionItem',
    page: 'components',
    category: 'Sidebar',
    keywords: ['session', 'item', 'row', 'active', 'permission', 'expand', 'entrance'],
  },
  {
    id: 'sessionsview',
    title: 'SessionsView',
    page: 'components',
    category: 'Sidebar',
    keywords: ['session', 'list', 'group', 'today', 'yesterday', 'empty', 'scroll'],
  },
  {
    id: 'sidebartabrow',
    title: 'SidebarTabRow',
    page: 'components',
    category: 'Sidebar',
    keywords: ['tab', 'sidebar', 'sessions', 'schedules', 'connections', 'badge', 'status', 'indicator'],
  },
  {
    id: 'sidebarfooterbar',
    title: 'SidebarFooterBar',
    page: 'components',
    category: 'Sidebar',
    keywords: ['footer', 'sidebar', 'theme', 'settings', 'branding', 'logo', 'agent'],
  },
  // OverlayShowcases
  {
    id: 'dialog',
    title: 'Dialog',
    page: 'components',
    category: 'Overlays',
    keywords: ['modal', 'overlay', 'popup', 'confirm', 'alert'],
  },
  {
    id: 'alertdialog',
    title: 'AlertDialog',
    page: 'components',
    category: 'Overlays',
    keywords: ['modal', 'confirm', 'destructive', 'delete', 'danger', 'alert'],
  },
  {
    id: 'popover',
    title: 'Popover',
    page: 'components',
    category: 'Overlays',
    keywords: ['floating', 'overlay', 'panel', 'anchor', 'tooltip'],
  },
  {
    id: 'dropdownmenu',
    title: 'DropdownMenu',
    page: 'components',
    category: 'Overlays',
    keywords: ['menu', 'context', 'dropdown', 'action', 'item'],
  },
  {
    id: 'sheet',
    title: 'Sheet',
    page: 'components',
    category: 'Overlays',
    keywords: ['sheet', 'panel', 'slide', 'side', 'drawer', 'left', 'right'],
  },
  {
    id: 'responsivedialog',
    title: 'ResponsiveDialog',
    page: 'components',
    category: 'Overlays',
    keywords: ['responsive', 'dialog', 'drawer', 'mobile', 'desktop', 'fullscreen'],
  },
  // DataDisplayShowcases
  {
    id: 'pathbreadcrumb',
    title: 'PathBreadcrumb',
    page: 'components',
    category: 'Data Display',
    keywords: ['path', 'breadcrumb', 'filesystem', 'directory', 'segment', 'truncate'],
  },
  {
    id: 'scanline',
    title: 'ScanLine',
    page: 'components',
    category: 'Data Display',
    keywords: ['scan', 'line', 'animation', 'streaming', 'beam', 'glow', 'agent'],
  },
  {
    id: 'markdowncontent',
    title: 'MarkdownContent',
    page: 'components',
    category: 'Data Display',
    keywords: ['markdown', 'prose', 'render', 'static', 'streamdown', 'content'],
  },
  {
    id: 'featuredisabledstate',
    title: 'FeatureDisabledState',
    page: 'components',
    category: 'Data Display',
    keywords: ['feature', 'disabled', 'empty', 'state', 'placeholder', 'subsystem'],
  },
  {
    id: 'scrollarea',
    title: 'ScrollArea',
    page: 'components',
    category: 'Data Display',
    keywords: ['scroll', 'area', 'overflow', 'scrollbar', 'custom', 'vertical', 'horizontal'],
  },
];

/**
 * Chat component sections from ChatPage.
 *
 * Sources: MessageShowcases, ToolShowcases, InputShowcases,
 * StatusShowcases, MiscShowcases.
 */
export const CHAT_SECTIONS: PlaygroundSection[] = [
  // MessageShowcases
  {
    id: 'usermessagecontent',
    title: 'UserMessageContent',
    page: 'chat',
    category: 'Messages',
    keywords: ['user', 'message', 'content', 'text', 'command', 'compaction'],
  },
  {
    id: 'assistantmessagecontent',
    title: 'AssistantMessageContent',
    page: 'chat',
    category: 'Messages',
    keywords: ['assistant', 'message', 'content', 'markdown', 'code', 'tool', 'approval'],
  },
  {
    id: 'messageitem',
    title: 'MessageItem',
    page: 'chat',
    category: 'Messages',
    keywords: ['message', 'item', 'grouping', 'position', 'bubble'],
  },
  // ToolShowcases
  {
    id: 'toolcallcard',
    title: 'ToolCallCard',
    page: 'chat',
    category: 'Tools',
    keywords: ['tool', 'call', 'card', 'status', 'running', 'complete', 'error', 'pending'],
  },
  {
    id: 'toolcallcard-extended-labels',
    title: 'ToolCallCard — Extended Labels',
    page: 'chat',
    category: 'Tools',
    keywords: ['tool', 'call', 'label', 'task', 'notebook', 'mcp', 'plan'],
  },
  {
    id: 'toolcallcard-hook-lifecycle',
    title: 'ToolCallCard — Hook Lifecycle',
    page: 'chat',
    category: 'Tools',
    keywords: ['tool', 'hook', 'lifecycle', 'running', 'success', 'error', 'cancelled'],
  },
  {
    id: 'subagentblock',
    title: 'SubagentBlock',
    page: 'chat',
    category: 'Tools',
    keywords: ['subagent', 'agent', 'block', 'lifecycle', 'spawned'],
  },
  {
    id: 'errormessageblock',
    title: 'ErrorMessageBlock',
    page: 'chat',
    category: 'Tools',
    keywords: ['error', 'message', 'block', 'failure', 'category', 'execution'],
  },
  {
    id: 'thinkingblock',
    title: 'ThinkingBlock',
    page: 'chat',
    category: 'Tools',
    keywords: ['thinking', 'reasoning', 'extended', 'streaming', 'collapsed', 'chain of thought'],
  },
  {
    id: 'toolapproval',
    title: 'ToolApproval',
    page: 'chat',
    category: 'Tools',
    keywords: ['approval', 'tool', 'approve', 'deny', 'pending', 'interactive', 'timeout'],
  },
  // InputShowcases
  {
    id: 'chatinput',
    title: 'ChatInput',
    page: 'chat',
    category: 'Input',
    keywords: ['input', 'textarea', 'chat', 'send', 'streaming', 'stop', 'queue'],
  },
  {
    id: 'filechipbar',
    title: 'FileChipBar',
    page: 'chat',
    category: 'Input',
    keywords: ['file', 'attachment', 'chip', 'upload', 'remove'],
  },
  {
    id: 'queuepanel',
    title: 'QueuePanel',
    page: 'chat',
    category: 'Input',
    keywords: ['queue', 'message', 'panel', 'pending', 'edit'],
  },
  {
    id: 'shortcutchips',
    title: 'ShortcutChips',
    page: 'chat',
    category: 'Input',
    keywords: ['shortcut', 'chip', 'command', 'mention', 'file', 'slash'],
  },
  {
    id: 'promptsuggestionchips',
    title: 'PromptSuggestionChips',
    page: 'chat',
    category: 'Input',
    keywords: ['prompt', 'suggestion', 'chip', 'follow-up', 'sdk', 'autocomplete'],
  },
  {
    id: 'questionprompt',
    title: 'QuestionPrompt',
    page: 'chat',
    category: 'Input',
    keywords: ['question', 'prompt', 'radio', 'checkbox', 'multi-select', 'tabs', 'form', 'interactive'],
  },
  // StatusShowcases
  {
    id: 'streamingtext',
    title: 'StreamingText',
    page: 'chat',
    category: 'Status',
    keywords: ['streaming', 'text', 'markdown', 'cursor', 'render'],
  },
  {
    id: 'inferenceindicator',
    title: 'InferenceIndicator',
    page: 'chat',
    category: 'Status',
    keywords: ['inference', 'indicator', 'streaming', 'waiting', 'rate limit', 'timer'],
  },
  {
    id: 'systemstatuszone',
    title: 'SystemStatusZone',
    page: 'chat',
    category: 'Status',
    keywords: ['system', 'status', 'banner', 'compaction', 'permission', 'ephemeral'],
  },
  {
    id: 'transporterrorbanner',
    title: 'TransportErrorBanner',
    page: 'chat',
    category: 'Status',
    keywords: ['transport', 'error', 'banner', 'connection', 'retry', 'network', 'timeout', 'session lock'],
  },
  {
    id: 'tasklistpanel',
    title: 'TaskListPanel',
    page: 'chat',
    category: 'Status',
    keywords: ['task', 'list', 'panel', 'progress', 'collapse', 'checklist'],
  },
  {
    id: 'clientsitem',
    title: 'ClientsItem',
    page: 'chat',
    category: 'Status',
    keywords: ['clients', 'session', 'presence', 'connected', 'multi-client', 'lock', 'obsidian', 'web', 'mcp'],
  },
  // MiscShowcases
  {
    id: 'celebrationoverlay',
    title: 'CelebrationOverlay',
    page: 'chat',
    category: 'Misc',
    keywords: ['celebration', 'confetti', 'overlay', 'task', 'complete', 'fireworks'],
  },
  {
    id: 'draghandle',
    title: 'DragHandle',
    page: 'chat',
    category: 'Misc',
    keywords: ['drag', 'handle', 'collapse', 'expand', 'toggle', 'pill'],
  },
];

/**
 * Full playground registry combining all page-level section arrays.
 *
 * Used as the data source for the TOC sidebar and Cmd+K search.
 */
export const PLAYGROUND_REGISTRY: PlaygroundSection[] = [
  ...TOKENS_SECTIONS,
  ...COMPONENTS_SECTIONS,
  ...CHAT_SECTIONS,
];
