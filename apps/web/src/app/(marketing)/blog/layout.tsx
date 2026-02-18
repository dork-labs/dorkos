import { RootProvider } from 'fumadocs-ui/provider/next'
import type { ReactNode } from 'react'
import 'fumadocs-ui/style.css'

/**
 * Layout for blog pages within the marketing route group.
 *
 * Imports fumadocs-ui styles for InlineTOC and MDX component rendering,
 * and wraps content in RootProvider for theme integration.
 */
export default function BlogLayout({ children }: { children: ReactNode }) {
  return <RootProvider>{children}</RootProvider>
}
