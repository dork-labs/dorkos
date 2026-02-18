'use client'

import { useEffect, useState } from 'react'
import type { TOCItemType } from 'fumadocs-core/toc'

/**
 * Sticky sidebar table of contents for blog posts.
 *
 * Tracks the active heading via IntersectionObserver and highlights it.
 * Hidden on screens smaller than xl.
 */
export function BlogTOCSidebar({ toc }: { toc: TOCItemType[] }) {
  const [activeId, setActiveId] = useState<string>('')

  useEffect(() => {
    const headingIds = toc.map((item) => item.url.slice(1))
    const elements = headingIds
      .map((id) => document.getElementById(id))
      .filter(Boolean) as HTMLElement[]

    if (elements.length === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id)
          }
        }
      },
      { rootMargin: '-80px 0px -80% 0px' }
    )

    for (const el of elements) observer.observe(el)
    return () => observer.disconnect()
  }, [toc])

  return (
    <aside className="sticky top-24 hidden h-fit w-56 shrink-0 xl:block">
      <p className="mb-3 text-sm font-semibold text-charcoal">On this page</p>
      <nav>
        <ul className="space-y-1.5 border-l border-warm-gray-light/30">
          {toc.map((item) => {
            const id = item.url.slice(1)
            const isActive = activeId === id
            return (
              <li
                key={item.url}
                style={{ paddingLeft: `${(item.depth - 2) * 12 + 12}px` }}
              >
                <a
                  href={item.url}
                  className={`block text-[13px] leading-snug transition-colors ${
                    isActive
                      ? 'font-medium text-charcoal'
                      : 'text-warm-gray hover:text-charcoal'
                  }`}
                >
                  {item.title}
                </a>
              </li>
            )
          })}
        </ul>
      </nav>
    </aside>
  )
}
