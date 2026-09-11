import type { ReferenceCandidate, ReferenceCandidateDraft } from './collect-export-candidates.js'

const LINE_TEXT_MAX_CHARS = 160

/** Clip an indexed source line for impact previews: trim end, hard-cap at 160 with ellipsis. */
export const clipSourceLine = (line: string | undefined): string => {
  if (line === undefined) return ''
  const trimmed = line.trimEnd()
  if (trimmed.length <= LINE_TEXT_MAX_CHARS) return trimmed
  return `${trimmed.slice(0, LINE_TEXT_MAX_CHARS - 1)}…`
}

export const withLineText = (
  references: readonly ReferenceCandidateDraft[],
  source: string,
): readonly ReferenceCandidate[] => {
  const sourceLines = source.split('\n')
  return references.map((reference) => ({
    ...reference,
    lineText: clipSourceLine(sourceLines[reference.lineNumber - 1]),
  }))
}
