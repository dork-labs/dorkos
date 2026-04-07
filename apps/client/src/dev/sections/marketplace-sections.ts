import type { PlaygroundSection } from '../playground-registry';

/**
 * Marketplace component sections for the dev playground TOC and Cmd+K search.
 *
 * Section IDs must equal `slugify(title)` — verified by the playground-registry test suite.
 * Slugify collapses camelCase component names to a single lowercase string with no hyphens,
 * and converts spaces to hyphens (e.g. "Package Primitives" → "package-primitives").
 *
 * Sources: MarketplaceShowcases — PackageCard, PackageTypeBadge, PackageGrid,
 * FeaturedAgentsRail, PackageDetailSheet, InstallConfirmationDialog,
 * PermissionPreviewSection, InstalledPackagesView, MarketplaceSourcesView,
 * DorkHubHeader, Package Primitives.
 */
export const MARKETPLACE_SECTIONS: PlaygroundSection[] = [
  {
    id: 'packagecard',
    title: 'PackageCard',
    page: 'marketplace',
    category: 'Marketplace',
    keywords: ['package', 'card', 'featured', 'installed', 'marketplace', 'browse'],
  },
  {
    id: 'packagetypebadge',
    title: 'PackageTypeBadge',
    page: 'marketplace',
    category: 'Marketplace',
    keywords: ['package', 'type', 'badge', 'agent', 'plugin', 'skill-pack', 'adapter'],
  },
  {
    id: 'packagegrid',
    title: 'PackageGrid',
    page: 'marketplace',
    category: 'Marketplace',
    keywords: ['package', 'grid', 'browse', 'loading', 'error', 'empty', 'catalog'],
  },
  {
    id: 'featuredagentsrail',
    title: 'FeaturedAgentsRail',
    page: 'marketplace',
    category: 'Marketplace',
    keywords: ['featured', 'agents', 'rail', 'hero', 'carousel', 'marketplace'],
  },
  {
    id: 'packagedetailsheet',
    title: 'PackageDetailSheet',
    page: 'marketplace',
    category: 'Marketplace',
    keywords: ['package', 'detail', 'sheet', 'slide-over', 'install', 'uninstall', 'permissions'],
  },
  {
    id: 'installconfirmationdialog',
    title: 'InstallConfirmationDialog',
    page: 'marketplace',
    category: 'Marketplace',
    keywords: ['install', 'confirmation', 'dialog', 'modal', 'conflicts', 'permissions', 'preview'],
  },
  {
    id: 'permissionpreviewsection',
    title: 'PermissionPreviewSection',
    page: 'marketplace',
    category: 'Marketplace',
    keywords: ['permission', 'preview', 'section', 'conflicts', 'secrets', 'hosts', 'install'],
  },
  {
    id: 'installedpackagesview',
    title: 'InstalledPackagesView',
    page: 'marketplace',
    category: 'Marketplace',
    keywords: ['installed', 'packages', 'view', 'uninstall', 'update', 'manage'],
  },
  {
    id: 'marketplacesourcesview',
    title: 'MarketplaceSourcesView',
    page: 'marketplace',
    category: 'Marketplace',
    keywords: ['marketplace', 'sources', 'registry', 'git', 'add', 'remove', 'manage'],
  },
  {
    id: 'dorkhubheader',
    title: 'DorkHubHeader',
    page: 'marketplace',
    category: 'Marketplace',
    keywords: ['dork', 'hub', 'header', 'search', 'filter', 'tabs', 'type'],
  },
  {
    id: 'package-primitives',
    title: 'Package Primitives',
    page: 'marketplace',
    category: 'Marketplace',
    keywords: [
      'package',
      'loading',
      'skeleton',
      'empty',
      'error',
      'state',
      'primitive',
      'marketplace',
    ],
  },
];
