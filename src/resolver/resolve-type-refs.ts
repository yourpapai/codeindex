// B7: the type-ref arm of reference resolution, extracted to its own module (resolve-references.ts
// is near its line budget). A bare `type_identifier` reference (no module specifier) binds ONLY to
// a type-shaped symbol in the current module — interface/type-alias/enum/class declarations —
// never to a same-named function or variable (the kind filter is the FP defense for same-module
// type binds). Import-backed type refs resolve earlier via the import map and never reach here.
// C2 composes upstream: a reference carrying a specifier that matched no file already binds
// nothing; this arm keeps that contract by refusing any reference that still carries a specifier.
const TYPE_SHAPED_KINDS: ReadonlySet<string> = new Set([
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'class_declaration',
  'abstract_class_declaration',
])

type TypeRefInput = {
  readonly symbols: readonly {
    readonly id: number
    readonly localName: string
    readonly moduleKey: string
    readonly kind?: string
  }[]
  readonly currentModuleKey: string
}

type TypeRefCandidate = {
  readonly targetName: string
  readonly targetModuleSpecifier: string | null
}

export const resolveTypeReference = (
  input: Readonly<TypeRefInput>,
  reference: Readonly<TypeRefCandidate>,
): Readonly<{ targetSymbolId: number | null; confidence: 'name_only' }> => {
  if (reference.targetModuleSpecifier !== null) {
    return { targetSymbolId: null, confidence: 'name_only' }
  }
  const resolvedByKind = input.symbols.find(
    (symbol) =>
      symbol.localName === reference.targetName &&
      symbol.moduleKey === input.currentModuleKey &&
      symbol.kind !== undefined &&
      TYPE_SHAPED_KINDS.has(symbol.kind),
  )
  return { targetSymbolId: resolvedByKind?.id ?? null, confidence: 'name_only' }
}
