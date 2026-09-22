export type DocSection = 'overview' | 'curve' | 'launching' | 'fees' | 'trading' | 'graduation' | 'metadata' | 'risks' | 'faq' | 'integrate'

export const DEFAULT_DOC_SECTION: DocSection = 'overview'

export const DOC_SECTIONS: ReadonlyArray<{ slug: DocSection; title: string }> = [
  { slug: 'overview', title: 'Overview' },
  { slug: 'curve', title: 'How the curve works' },
  { slug: 'launching', title: 'Launching a token' },
  { slug: 'fees', title: 'Creator fees & plugins' },
  { slug: 'trading', title: 'Trading a launch token' },
  { slug: 'graduation', title: 'Graduation' },
  { slug: 'metadata', title: 'Token details & trust' },
  { slug: 'risks', title: 'Risks' },
  { slug: 'faq', title: 'FAQ & glossary' },
  { slug: 'integrate', title: 'Listing & integration' },
]

export function isDocSection(value: string): value is DocSection {
  return DOC_SECTIONS.some((section) => section.slug === value)
}
