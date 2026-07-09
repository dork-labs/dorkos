import defaultMdxComponents from 'fumadocs-ui/mdx';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { File, Files, Folder } from 'fumadocs-ui/components/files';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import type { MDXComponents } from 'mdx/types';
import { ProductShot } from '@/layers/features/marketing';

/**
 * MDX component overrides for documentation pages.
 *
 * Extends Fumadocs default components (code blocks, headings, tables, cards, callouts)
 * with Steps, Tabs, Files, TypeTable, ProductShot (real product media embeds), and
 * any project-specific overrides.
 */
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Step,
    Steps,
    Tab,
    Tabs,
    File,
    Files,
    Folder,
    TypeTable,
    ProductShot,
    ...components,
  };
}
