import { isV14Available } from '../../lib/deployment'

interface V14NoteProps {
  /** What the part covers once launchpad v1.4 is live on this network. */
  live: string
  /** What it covers until then. */
  pending: string
}

/** Marks a part of the docs that is about launchpad v1.4: a quiet sentence, worded by whether v1.4 is live yet. */
export function V14Note({ live, pending }: V14NoteProps) {
  return <p className="text-sm leading-6 text-g700">{isV14Available ? live : pending}</p>
}

/** The note most v1.4 parts open with. */
export const V14_NOTE = {
  live: 'This part is about tokens launched on launchpad v1.4. Tokens launched on v1.3 keep working as described above.',
  pending: 'This part is about launchpad v1.4, which is not live yet. Until it is, new launches use v1.3, as described above.',
} as const
