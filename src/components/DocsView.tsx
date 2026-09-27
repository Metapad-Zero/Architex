import { useEffect, useRef, type ComponentType } from 'react'
import { DEFAULT_DOC_SECTION, DOC_SECTIONS, type DocSection } from '../lib/docs'
import { DocsCurve } from '../content/docs/Curve'
import { DocsFaq } from '../content/docs/Faq'
import { DocsFees } from '../content/docs/Fees'
import { DocsGraduation } from '../content/docs/Graduation'
import { DocsIntegrate } from '../content/docs/Integrate'
import { DocsLaunching } from '../content/docs/Launching'
import { DocsMetadata } from '../content/docs/Metadata'
import { DocsOverview } from '../content/docs/Overview'
import { DocsRisks } from '../content/docs/Risks'
import { DocsTrading } from '../content/docs/Trading'

const CONTENT: Record<DocSection, ComponentType> = {
  overview: DocsOverview,
  curve: DocsCurve,
  launching: DocsLaunching,
  fees: DocsFees,
  trading: DocsTrading,
  graduation: DocsGraduation,
  metadata: DocsMetadata,
  risks: DocsRisks,
  faq: DocsFaq,
  integrate: DocsIntegrate,
}

interface DocsViewProps {
  section?: DocSection
  onSection: (section: DocSection) => void
}

export function DocsView({ section = DEFAULT_DOC_SECTION, onSection }: DocsViewProps) {
  const active = DOC_SECTIONS.find((entry) => entry.slug === section) ?? DOC_SECTIONS[0]
  const activeIndex = DOC_SECTIONS.findIndex((entry) => entry.slug === active.slug)
  const previous = activeIndex > 0 ? DOC_SECTIONS[activeIndex - 1] : undefined
  const next = activeIndex < DOC_SECTIONS.length - 1 ? DOC_SECTIONS[activeIndex + 1] : undefined
  const Content = CONTENT[active.slug]
  const navRef = useRef<HTMLUListElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const requestedSection = useRef<DocSection>()

  const selectSection = (slug: DocSection) => {
    requestedSection.current = slug
    if (slug === active.slug) {
      headingRef.current?.focus({ preventScroll: true })
      headingRef.current?.scrollIntoView({ block: 'start' })
      requestedSection.current = undefined
    } else onSection(slug)
  }

  useEffect(() => {
    const nav = navRef.current
    const link = nav?.querySelector<HTMLElement>('[aria-current="page"]')
    if (nav && link && nav.scrollWidth > nav.clientWidth) {
      const offset = link.getBoundingClientRect().left - nav.getBoundingClientRect().left
      nav.scrollLeft += offset - (nav.clientWidth - link.offsetWidth) / 2
    }
    if (requestedSection.current === active.slug) {
      headingRef.current?.focus({ preventScroll: true })
      headingRef.current?.scrollIntoView({ block: 'start' })
      requestedSection.current = undefined
    }
  }, [active.slug])

  return (
    <div className="docs-page mx-auto w-full max-w-[1008px] px-4 pb-24 pt-10 sm:px-6 sm:pt-12">
      <h1 className="text-xl font-semibold">Documentation</h1>
      <p className="mt-2 max-w-[640px] text-g700">How Architex's launchpad works, what's permanent, and what to check before you use it.</p>

      <div className="mt-8 grid gap-6 sm:grid-cols-[200px_minmax(0,1fr)] sm:gap-10">
        <nav aria-label="Documentation sections" className="min-w-0 border-b border-g300 sm:border-b-0">
          <ul ref={navRef} className="flex gap-1 overflow-x-auto sm:flex-col sm:gap-0 sm:overflow-visible">
            {DOC_SECTIONS.map((entry) => (
              <li key={entry.slug} className="shrink-0 sm:shrink">
                <button
                  type="button"
                  className="doc-nav-link"
                  data-active={entry.slug === active.slug}
                  aria-current={entry.slug === active.slug ? 'page' : undefined}
                  onClick={() => selectSection(entry.slug)}
                >
                  {entry.title}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <article className="min-w-0 max-w-[640px]">
          <h2 ref={headingRef} tabIndex={-1} className="scroll-mt-20 text-lg font-semibold">{active.title}</h2>
          <div className="mt-3 h-px bg-ink" />
          <div className="mt-6 text-base leading-6">
            <Content />
          </div>

          <div className="mt-10 flex items-center justify-between gap-6 border-t border-g300 pt-6 text-sm font-semibold">
            {previous ? (
              <button type="button" className="min-h-11 text-left text-ink underline decoration-1 underline-offset-[3px] hover:text-g700" onClick={() => selectSection(previous.slug)}>
                ← {previous.title}
              </button>
            ) : (
              <span />
            )}
            {next ? (
              <button type="button" className="min-h-11 text-right text-ink underline decoration-1 underline-offset-[3px] hover:text-g700" onClick={() => selectSection(next.slug)}>
                {next.title} →
              </button>
            ) : (
              <span />
            )}
          </div>
        </article>
      </div>
    </div>
  )
}
