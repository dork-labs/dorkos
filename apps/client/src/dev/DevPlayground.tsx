import { useState, useEffect, useCallback, useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import {
  TooltipProvider,
  Button,
  Sidebar,
  SidebarProvider,
  SidebarInset,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarTrigger,
  Separator,
} from '@/layers/shared/ui';
import { TransportProvider, useTheme } from '@/layers/shared/model';
import { ChevronLeft, LayoutDashboard, Sun, Monitor, Moon, Search } from 'lucide-react';
import { createPlaygroundTransport } from './playground-transport';
import { ChatPage } from './pages/ChatPage';
import { FeaturesPage } from './pages/FeaturesPage';
import { TokensPage } from './pages/TokensPage';
import { FormsPage } from './pages/FormsPage';
import { ComponentsPage } from './pages/ComponentsPage';
import { OverviewPage } from './pages/OverviewPage';
import { PromosPage } from './pages/PromosPage';
import { CommandPalettePage } from './pages/CommandPalettePage';
import { SimulatorPage } from './pages/SimulatorPage';
import { TopologyPage } from './pages/TopologyPage';
import { ErrorStatesPage } from './pages/ErrorStatesPage';
import { FilterBarPage } from './pages/FilterBarPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { TablesPage } from './pages/TablesPage';
import { PlaygroundSearch } from './PlaygroundSearch';
import {
  DESIGN_SYSTEM_NAV,
  SESSION_NAV,
  AGENTS_NAV,
  APP_SHELL_NAV,
  getPageFromPath,
} from './playground-config';
import type { Page, PlaygroundSection } from './playground-registry';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
  },
});

const transport = createPlaygroundTransport();

// Minimal router providing TanStack Router context for hooks (useSearch, useNavigate)
// that are called transitively by showcase components. Uses memory history so it
// doesn't interfere with the playground's own URL-based routing.
const devRootRoute = createRootRoute({ component: DevPlaygroundShell });
const devRouter = createRouter({
  routeTree: devRootRoute,
  history: createMemoryHistory({ initialEntries: ['/dev'] }),
});

/** Platform-aware modifier key symbol. */
const MOD_KEY =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl+';

/** Props shared by all playground page components. Only OverviewPage uses `onNavigate`. */
interface PlaygroundPageProps {
  onNavigate?: (page: Page) => void;
}

/** Page component lookup — maps page IDs to their React components. */
const PAGE_COMPONENTS: Record<string, React.ComponentType<PlaygroundPageProps>> = {
  overview: OverviewPage as React.ComponentType<PlaygroundPageProps>,
  tokens: TokensPage,
  forms: FormsPage,
  components: ComponentsPage,
  chat: ChatPage,
  features: FeaturesPage,
  topology: TopologyPage,
  promos: PromosPage,
  'command-palette': CommandPalettePage,
  simulator: SimulatorPage,
  'filter-bar': FilterBarPage,
  'error-states': ErrorStatesPage,
  onboarding: OnboardingPage,
  tables: TablesPage,
};

/**
 * Scroll the SidebarInset scroll container to the element with the given id.
 *
 * Uses `scrollIntoView` with smooth behavior; falls back silently if the
 * element is not yet in the DOM.
 */
function scrollToSection(id: string): void {
  // Give React a tick to render the target page before scrolling
  requestAnimationFrame(() => {
    const el = document.getElementById(id);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <SidebarFooter className="border-t p-2">
      <div className="flex items-center justify-between px-2">
        <span className="text-muted-foreground text-xs">Theme</span>
        <div className="flex gap-0.5">
          <Button
            variant={theme === 'light' ? 'secondary' : 'ghost'}
            size="icon-sm"
            onClick={() => setTheme('light')}
            aria-label="Light theme"
          >
            <Sun className="size-4" />
          </Button>
          <Button
            variant={theme === 'system' ? 'secondary' : 'ghost'}
            size="icon-sm"
            onClick={() => setTheme('system')}
            aria-label="System theme"
          >
            <Monitor className="size-4" />
          </Button>
          <Button
            variant={theme === 'dark' ? 'secondary' : 'ghost'}
            size="icon-sm"
            onClick={() => setTheme('dark')}
            aria-label="Dark theme"
          >
            <Moon className="size-4" />
          </Button>
        </div>
      </div>
    </SidebarFooter>
  );
}

/**
 * Inner shell rendered as the root route component of the dev router.
 * Separated from the default export so that providers (QueryClient, Transport,
 * Router) wrap it from outside.
 */
function DevPlaygroundShell() {
  const [page, setPage] = useState<Page>(() => getPageFromPath(window.location.pathname) as Page);
  const [searchOpen, setSearchOpen] = useState(false);

  // Use `/dev` for the overview page; all other pages use `/dev/<id>`.
  const navigateTo = useCallback((id: Page) => {
    setPage(id);
    history.pushState(null, '', id === 'overview' ? '/dev' : `/dev/${id}`);
  }, []);

  const handleSelect = useCallback((section: PlaygroundSection) => {
    const url = section.page === 'overview' ? '/dev' : `/dev/${section.page}`;
    setPage(section.page);
    history.pushState(null, '', `${url}#${section.id}`);
    scrollToSection(section.id);
  }, []);

  // Sync page state when the user navigates with browser back/forward.
  useEffect(() => {
    const onPopState = () => setPage(getPageFromPath(window.location.pathname) as Page);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Scroll to any hash anchor after the page has rendered.
  useEffect(() => {
    const anchor = window.location.hash.slice(1) || null;
    if (anchor) {
      scrollToSection(anchor);
    }
  }, [page]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const ActivePage = useMemo(() => PAGE_COMPONENTS[page], [page]);

  return (
    <TooltipProvider>
      <div className="bg-background text-foreground h-dvh">
        <SidebarProvider defaultOpen className="h-full min-h-0">
          <Sidebar variant="inset">
            <SidebarHeader className="border-b p-3">
              <div className="flex items-center gap-2 py-1">
                <SidebarMenuButton
                  data-slot="app-link"
                  type="button"
                  size="sm"
                  tooltip="Back to app"
                  aria-label="Back to app"
                  onClick={() => {
                    window.location.href = '/';
                  }}
                  className="text-muted-foreground hover:bg-accent hover:text-foreground h-7! w-7! shrink-0 justify-center p-0 transition-all duration-100 active:scale-[0.98]"
                >
                  <ChevronLeft className="size-(--size-icon-sm)" />
                </SidebarMenuButton>
                <h2 className="text-sm font-semibold">DorkOS Dev</h2>
              </div>
            </SidebarHeader>
            <SidebarContent>
              <SidebarGroup>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      isActive={page === 'overview'}
                      onClick={() => navigateTo('overview')}
                    >
                      <LayoutDashboard className="size-4" />
                      Overview
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroup>
              <SidebarGroup>
                <SidebarGroupLabel>Design System</SidebarGroupLabel>
                <SidebarMenu>
                  {DESIGN_SYSTEM_NAV.map((item) => (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        isActive={page === item.id}
                        onClick={() => navigateTo(item.id as Page)}
                      >
                        <item.icon className="size-4" />
                        {item.label}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroup>
              <SidebarGroup>
                <SidebarGroupLabel>Session</SidebarGroupLabel>
                <SidebarMenu>
                  {SESSION_NAV.map((item) => (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        isActive={page === item.id}
                        onClick={() => navigateTo(item.id as Page)}
                      >
                        <item.icon className="size-4" />
                        {item.label}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroup>
              <SidebarGroup>
                <SidebarGroupLabel>Agents</SidebarGroupLabel>
                <SidebarMenu>
                  {AGENTS_NAV.map((item) => (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        isActive={page === item.id}
                        onClick={() => navigateTo(item.id as Page)}
                      >
                        <item.icon className="size-4" />
                        {item.label}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroup>
              <SidebarGroup>
                <SidebarGroupLabel>App Shell</SidebarGroupLabel>
                <SidebarMenu>
                  {APP_SHELL_NAV.map((item) => (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        isActive={page === item.id}
                        onClick={() => navigateTo(item.id as Page)}
                      >
                        <item.icon className="size-4" />
                        {item.label}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroup>
            </SidebarContent>
            <ThemeToggle />
          </Sidebar>

          <SidebarInset className="overflow-y-auto">
            <header className="flex h-9 shrink-0 items-center gap-2 border-b px-2">
              <SidebarTrigger className="-ml-0.5" />
              <Separator orientation="vertical" className="mr-1 h-4" />
              <span className="text-muted-foreground text-xs">Dev Playground</span>
              <div className="ml-auto flex items-center">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSearchOpen(true)}
                  className="text-muted-foreground h-7 gap-1.5 px-2 text-xs"
                  aria-label={`Search sections (${MOD_KEY}K)`}
                >
                  <Search className="size-3.5" />
                  Search
                  <kbd className="bg-muted rounded px-1 py-0.5 font-mono text-[10px]">
                    {MOD_KEY}K
                  </kbd>
                </Button>
              </div>
            </header>
            {ActivePage && <ActivePage onNavigate={navigateTo} />}
          </SidebarInset>

          <PlaygroundSearch
            open={searchOpen}
            onOpenChange={setSearchOpen}
            onSelect={handleSelect}
          />
        </SidebarProvider>
      </div>
    </TooltipProvider>
  );
}

/** Dev-only playground shell with sidebar navigation, rendered at `/dev`. */
export default function DevPlayground() {
  return (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <RouterProvider router={devRouter} />
      </TransportProvider>
    </QueryClientProvider>
  );
}
