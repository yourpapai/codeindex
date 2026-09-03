import path from 'node:path'

type SymbolSummary = {
  readonly id: number
  readonly qualifiedName: string
  readonly localName: string
  readonly moduleKey: string
  readonly exportNames: readonly string[]
}

type ModuleAliasSummary = {
  readonly aliasKey: string
  readonly fileId: number
}

type FileSummary = {
  readonly id: number
  readonly moduleKey: string
}

type ModuleExportSummary = {
  readonly moduleKey: string
  readonly exportName: string
  readonly symbolId: number | null
  readonly targetModuleSpecifier: string | null
}

type ReferenceCandidate = {
  readonly sourceQualifiedName: string | null
  readonly edgeType: 'imports' | 'reexports' | 'calls' | 'extends' | 'implements' | 'references'
  readonly targetName: string
  readonly targetExportName: string | null
  readonly targetModuleSpecifier: string | null
  readonly receiver?: 'this'
  readonly lineNumber: number
}

export interface ResolveReferenceCandidatesInput {
  readonly symbols: readonly SymbolSummary[]
  readonly moduleAliases: readonly ModuleAliasSummary[]
  readonly files: readonly FileSummary[]
  readonly references: readonly ReferenceCandidate[]
  readonly currentModuleKey: string
  // Every module's exports (see selectAllModuleExports), used to bridge barrel re-exports (B4).
  // Optional so existing callers/tests that don't exercise barrels need not supply it.
  readonly moduleExports?: readonly ModuleExportSummary[]
}

export interface ResolvedReference {
  readonly sourceSymbolId: number | null
  readonly sourceQualifiedName: string | null
  readonly edgeType: ReferenceCandidate['edgeType']
  readonly targetName: string
  readonly targetExportName: string | null
  readonly targetModuleSpecifier: string | null
  readonly targetSymbolId: number | null
  readonly targetFileId: number | null
  readonly confidence: 'resolved' | 'file_resolved' | 'name_only'
  readonly lineNumber: number
}

const normalizeRelativeModule = (fromModuleKey: string, specifier: string): string => {
  if (!specifier.startsWith('.')) {
    return specifier
  }
  const parentDir = path.posix.dirname(fromModuleKey)
  return path.posix.normalize(path.posix.join(parentDir, specifier)).replace(/\.[^.]+$/, '')
}

// Build a resolver that walks barrel re-export chains: given the module a name is imported from and
// the exported name, follow `export { x } from './y'` hops (a module_exports row with symbolId null
// and a forwarding specifier) until a module exports the name with a real symbol id. Relative
// specifiers are normalized against the module doing the re-export. Depth-capped against import
// cycles. Returns null when the chain dead-ends — a bare `export { x }` re-export of a non-local
// binding, or an `export *` star, records no forwarding symbol; B4 covers the direct
// `export { x } from './y'` form (5 of papai's 6 barrel misses).
const buildReexportResolver = (
  moduleExports: readonly ModuleExportSummary[],
): ((moduleKey: string, exportName: string) => number | null) => {
  const byModule = new Map<string, Map<string, ModuleExportSummary>>()
  for (const moduleExport of moduleExports) {
    const forModule = byModule.get(moduleExport.moduleKey) ?? new Map<string, ModuleExportSummary>()
    forModule.set(moduleExport.exportName, moduleExport)
    byModule.set(moduleExport.moduleKey, forModule)
  }
  const resolve = (moduleKey: string, exportName: string, depth: number): number | null => {
    if (depth > 8) return null
    const entry = byModule.get(moduleKey)?.get(exportName)
    if (entry === undefined) return null
    if (entry.symbolId !== null) return entry.symbolId
    if (entry.targetModuleSpecifier === null) return null
    return resolve(normalizeRelativeModule(moduleKey, entry.targetModuleSpecifier), exportName, depth + 1)
  }
  return (moduleKey, exportName) => resolve(moduleKey, exportName, 0)
}

const findMatchedFileId = (
  input: Readonly<ResolveReferenceCandidatesInput>,
  targetModuleSpecifier: string | null,
): number | null => {
  if (targetModuleSpecifier === null) {
    return null
  }
  const normalizedSpecifier = normalizeRelativeModule(input.currentModuleKey, targetModuleSpecifier)
  return (
    input.moduleAliases.find((alias) => alias.aliasKey === normalizedSpecifier)?.fileId ??
    input.files.find((file) => file.moduleKey === normalizedSpecifier)?.id ??
    null
  )
}

// Last-resort resolution: a symbol whose local name matches, scoped to the matched module (or, for
// a bare reference with no module specifier, the current module). A specified-but-unmatched import
// (bare npm specifier, out-of-root path, typo'd relative) resolves to NOTHING here: the old
// codebase-wide fallback bound `import { eq } from 'drizzle-orm'` to an unrelated local
// `const eq` — measured at 157 false papai edges before C2 suppression (Slice 7). Confidence
// reflects whether the import specifier at least resolved to a file.
const resolveByLocalName = (
  input: Readonly<ResolveReferenceCandidatesInput>,
  matchedFileId: number | null,
  matchedModuleKey: string | null,
  reference: Readonly<ReferenceCandidate>,
): Readonly<{ targetSymbolId: number | null; confidence: ResolvedReference['confidence'] }> => {
  const scopeModuleKey = matchedModuleKey ?? (reference.targetModuleSpecifier === null ? input.currentModuleKey : null)
  const resolvedByName =
    scopeModuleKey === null
      ? undefined
      : input.symbols.find((symbol) => symbol.localName === reference.targetName && symbol.moduleKey === scopeModuleKey)
  return {
    targetSymbolId: resolvedByName?.id ?? null,
    confidence: matchedFileId === null ? 'name_only' : 'file_resolved',
  }
}

const findResolvedSymbol = (
  input: Readonly<ResolveReferenceCandidatesInput>,
  matchedFileId: number | null,
  reference: Readonly<ReferenceCandidate>,
  importMap: ReadonlyMap<string, number>,
  resolveReexport: (moduleKey: string, exportName: string) => number | null,
): Readonly<{ targetSymbolId: number | null; confidence: ResolvedReference['confidence'] }> => {
  const resolvedFromImport = matchedFileId === null ? importMap.get(reference.targetName) : undefined
  if (resolvedFromImport !== undefined) {
    return { targetSymbolId: resolvedFromImport, confidence: 'resolved' }
  }

  const matchedModuleKeyForFile =
    matchedFileId === null ? null : (input.files.find((file) => file.id === matchedFileId)?.moduleKey ?? null)

  const resolvedByExport =
    matchedModuleKeyForFile === null
      ? undefined
      : input.symbols.find(
          (symbol) =>
            symbol.exportNames.includes(reference.targetExportName ?? reference.targetName) &&
            matchedModuleKeyForFile === symbol.moduleKey,
        )
  if (resolvedByExport !== undefined) {
    return { targetSymbolId: resolvedByExport.id, confidence: 'resolved' }
  }

  // B4: the import resolved to a barrel module but the name isn't declared there — follow its
  // re-export chain to the real declaration. High precision (explicit export edges, no guessing).
  if (matchedModuleKeyForFile !== null) {
    const bridged = resolveReexport(matchedModuleKeyForFile, reference.targetExportName ?? reference.targetName)
    if (bridged !== null) return { targetSymbolId: bridged, confidence: 'resolved' }
  }

  return resolveByLocalName(input, matchedFileId, matchedModuleKeyForFile, reference)
}

// this.m() → the enclosing class's method. The reference's source is the calling method/scope; its
// enclosing class is any ancestor prefix of that qualified name. Match a symbol `<class>>m` whose
// class prefix is an ancestor of the source, so only the enclosing class chain matches (deterministic,
// near-zero FP). obj.m() never reaches here (no `this` receiver) and stays unresolved — deferred.
// Scope note: resolution is limited to the enclosing class chain only — it does NOT resolve methods
// inherited from a base class (a recall gap, not an FP risk; inheritance resolution needs
// class-hierarchy data outside this scope).
const resolveThisMemberCall = (
  symbols: readonly SymbolSummary[],
  source: string,
  methodName: string,
): number | null => {
  const suffix = `>${methodName}`
  const match = symbols.find((symbol) => {
    if (symbol.localName !== methodName || !symbol.qualifiedName.endsWith(suffix)) return false
    const classPrefix = symbol.qualifiedName.slice(0, symbol.qualifiedName.length - suffix.length)
    return source === classPrefix || source.startsWith(`${classPrefix}>`)
  })
  return match?.id ?? null
}

// this.m() → the enclosing class's method (B2). Split out of the main map to keep it under the
// max-lines cap; behaviour is identical to inlining.
const resolveThisReference = (
  input: Readonly<ResolveReferenceCandidatesInput>,
  reference: Readonly<ReferenceCandidate>,
  sourceSymbols: ReadonlyMap<string, number>,
): ResolvedReference => {
  const targetSymbolId =
    reference.sourceQualifiedName === null
      ? null
      : resolveThisMemberCall(input.symbols, reference.sourceQualifiedName, reference.targetName)
  return {
    sourceSymbolId:
      reference.sourceQualifiedName === null ? null : (sourceSymbols.get(reference.sourceQualifiedName) ?? null),
    ...reference,
    targetSymbolId,
    targetFileId: null,
    confidence: targetSymbolId === null ? 'name_only' : 'resolved',
  }
}

export const resolveReferenceCandidates = (
  input: Readonly<ResolveReferenceCandidatesInput>,
): readonly ResolvedReference[] => {
  const sourceSymbols = new Map(input.symbols.map((symbol) => [symbol.qualifiedName, symbol.id]))
  const importMap = new Map<string, number>()
  const resolveReexport = buildReexportResolver(input.moduleExports ?? [])

  return input.references.map((reference) => {
    if (reference.receiver === 'this') return resolveThisReference(input, reference, sourceSymbols)

    const matchedFileId = findMatchedFileId(input, reference.targetModuleSpecifier)
    const { targetSymbolId, confidence } = findResolvedSymbol(
      input,
      matchedFileId,
      reference,
      importMap,
      resolveReexport,
    )

    if (reference.edgeType === 'imports' && targetSymbolId !== null) {
      importMap.set(reference.targetName, targetSymbolId)
    }

    // B6 false-positive guard: a bare value `references` edge that resolves ONLY by same-module name
    // (name_only) is the shadowing-prone case — a local or parameter sharing a top-level symbol's
    // name, which scope-free resolution cannot tell apart from a real use. Keep only import- or
    // file-backed resolutions (resolved / file_resolved); drop the name-only guess to a null target,
    // which findIncomingReferences never surfaces. Calls keep their same-module name_only resolution
    // (measured FP-free); the risk is specific to identifiers used as values.
    const guardedTargetSymbolId =
      reference.edgeType === 'references' && confidence === 'name_only' ? null : targetSymbolId

    return {
      sourceSymbolId:
        reference.sourceQualifiedName === null ? null : (sourceSymbols.get(reference.sourceQualifiedName) ?? null),
      ...reference,
      targetSymbolId: guardedTargetSymbolId,
      targetFileId: matchedFileId,
      confidence,
    }
  })
}
