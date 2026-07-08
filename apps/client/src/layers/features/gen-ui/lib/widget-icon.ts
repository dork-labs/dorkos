/**
 * Resolve a widget's `icon` string to a Lucide component.
 *
 * Widgets reference icons by name (`LucideName`). Importing Lucide's full icon
 * map would defeat tree-shaking, so we resolve against a curated allowlist of
 * common icons and fall back to a neutral dot for anything unknown — keeping the
 * bundle tight while staying forward-compatible (the allowlist can grow).
 *
 * @module features/gen-ui/lib/widget-icon
 */
import {
  AlertCircle,
  AlertTriangle,
  Archive,
  ArrowRight,
  Bell,
  Bookmark,
  Calendar,
  Check,
  CheckCircle,
  Circle,
  Clock,
  Cloud,
  Code,
  Cog,
  Database,
  File,
  FileText,
  Flag,
  Folder,
  GitBranch,
  Globe,
  Heart,
  Home,
  Info,
  Link,
  Lock,
  Mail,
  MapPin,
  MessageSquare,
  Package,
  Play,
  Rocket,
  Search,
  Server,
  Settings,
  Star,
  Tag,
  Terminal,
  ThumbsUp,
  Trash,
  TrendingDown,
  TrendingUp,
  User,
  Users,
  Zap,
  type LucideIcon,
} from 'lucide-react';

/** Curated allowlist of widget icons, keyed by kebab-case Lucide name. */
const WIDGET_ICONS: Record<string, LucideIcon> = {
  'alert-circle': AlertCircle,
  'alert-triangle': AlertTriangle,
  archive: Archive,
  'arrow-right': ArrowRight,
  bell: Bell,
  bookmark: Bookmark,
  calendar: Calendar,
  check: Check,
  'check-circle': CheckCircle,
  circle: Circle,
  clock: Clock,
  cloud: Cloud,
  code: Code,
  cog: Cog,
  database: Database,
  file: File,
  'file-text': FileText,
  flag: Flag,
  folder: Folder,
  'git-branch': GitBranch,
  globe: Globe,
  heart: Heart,
  home: Home,
  info: Info,
  link: Link,
  lock: Lock,
  mail: Mail,
  'map-pin': MapPin,
  'message-square': MessageSquare,
  package: Package,
  play: Play,
  rocket: Rocket,
  search: Search,
  server: Server,
  settings: Settings,
  star: Star,
  tag: Tag,
  terminal: Terminal,
  'thumbs-up': ThumbsUp,
  trash: Trash,
  'trending-down': TrendingDown,
  'trending-up': TrendingUp,
  user: User,
  users: Users,
  zap: Zap,
};

/**
 * Resolve an icon name to a Lucide component, tolerating PascalCase/camelCase by
 * normalizing to kebab-case. Returns `Circle` for unknown or absent names.
 *
 * @param name - The widget-supplied icon name (e.g. `check-circle` or `CheckCircle`)
 */
export function resolveWidgetIcon(name?: string): LucideIcon {
  if (!name) return Circle;
  const kebab = name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/\s+/g, '-')
    .toLowerCase();
  return WIDGET_ICONS[kebab] ?? Circle;
}
