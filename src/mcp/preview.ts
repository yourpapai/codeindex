export type PreviewMode = 'none' | 'short' | 'full'

const ANCHOR_MAX_CHARS = 160
const SHORT_MAX_LINES = 10

const anchorLine = (line: string): string =>
  line.length <= ANCHOR_MAX_CHARS ? line : `${line.slice(0, ANCHOR_MAX_CHARS - 1)}…`

const shortWindow = (lines: readonly string[]): string => {
  if (lines.length <= SHORT_MAX_LINES) {
    return lines.join('\n')
  }
  const head = lines.slice(0, 5)
  const tail = lines.slice(-4)
  return [...head, '…', ...tail].join('\n')
}

const previewSnippet = (snippet: string, preview: Exclude<PreviewMode, 'full'>): string => {
  if (snippet === '') {
    return snippet
  }
  const lines = snippet.split('\n')
  if (preview === 'none') {
    return anchorLine(lines[0] ?? '')
  }
  return shortWindow(lines)
}

/** MCP-layer filter: shrink snippet density only; ranking fields stay untouched. */
export const applyPreview = <T extends { readonly snippet: string }>(result: T, preview: PreviewMode): T => {
  if (preview === 'full') {
    return result
  }
  return { ...result, snippet: previewSnippet(result.snippet, preview) }
}

export const applyPreviewToList = <T extends { readonly snippet: string }>(
  results: readonly T[],
  preview: PreviewMode,
): readonly T[] => {
  if (preview === 'full') {
    return results
  }
  return results.map((result) => applyPreview(result, preview))
}
