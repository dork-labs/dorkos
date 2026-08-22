import type { ReactNode } from 'react';
import { BarTitle, OneBar } from './OneBar';

interface TitleBarProps {
  /** The page's name. The bar owns it, so the page below does not repeat it. */
  title: string;
  /** Page actions, if this page has any. */
  actions?: ReactNode;
}

/**
 * The bar for a page whose identity is just its name.
 *
 * Most routes are this: Workspaces, Connections, Marketplace, Product feedback.
 * They used to be a one-line component file each, all saying the same sentence
 * with a different string in it — so they are a declaration in `router.tsx` now
 * (`header: () => <TitleBar title="Workspaces" />`) and the files are gone.
 */
export function TitleBar({ title, actions }: TitleBarProps) {
  return <OneBar identity={<BarTitle>{title}</BarTitle>} actions={actions} />;
}
