import type { Node as SyntaxNode, Tree } from 'web-tree-sitter'

import {
  collectExportCandidates,
  collectNamespaceImportReference,
  normalizeSpecifier,
  type ModuleExportCandidate,
  type ReferenceCandidate,
  type ReferenceCandidateDraft,
} from './collect-export-candidates.js'
import { collectTypeReference, occupiesNameField } from './collect-type-references.js'
import { withLineText } from './line-text.js'
import { isNamedScopeBoundary, nextEnclosingSymbol, pendingSegmentsFor } from './scope-path.js'

export type { ModuleExportCandidate, ReferenceCandidate }

export interface ExtractReferenceCandidatesInput {
  readonly source: string
  readonly tree: Tree
  readonly relativeFilePath: string
  readonly moduleKey: string
}

export interface ExtractReferenceCandidatesResult {
  readonly moduleExports: readonly ModuleExportCandidate[]
  readonly references: readonly ReferenceCandidate[]
}

const visitChildren = (
  node: SyntaxNode,
  enclosingSymbol: string | null,
  pending: readonly string[],
  visit: (child: SyntaxNode, childEnclosingSymbol: string | null, childPending: readonly string[]) => void,
): void => {
  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index)
    if (child !== null) visit(child, enclosingSymbol, pending)
  }
}

const collectImportReference = (node: SyntaxNode, references: ReferenceCandidateDraft[]): void => {
  const exportedName = node.childForFieldName('name')?.text ?? node.text
  const localName = node.childForFieldName('alias')?.text ?? exportedName
  const importStatement = node.parent?.parent?.parent
  references.push({
    sourceQualifiedName: null,
    edgeType: 'imports',
    targetName: localName,
    targetExportName: exportedName,
    targetModuleSpecifier: normalizeSpecifier(importStatement?.childForFieldName('source')),
    lineNumber: node.startPosition.row + 1,
  })
}

const collectCallReference = (
  node: SyntaxNode,
  enclosingSymbol: string | null,
  references: ReferenceCandidateDraft[],
): void => {
  const functionNode = node.childForFieldName('function')
  // this.m() — receiver `this` resolves to the enclosing class's method (B2): emit the bare property
  // name plus a `this` receiver marker so the resolver can bind it to <enclosingClass>>m. Non-`this`
  // receivers (obj.m()) are left as the whole member-expression text (unresolved) — deferred.
  if (functionNode?.type === 'member_expression') {
    const object = functionNode.childForFieldName('object')
    const property = functionNode.childForFieldName('property')
    if (object?.type === 'this' && property?.type === 'property_identifier') {
      references.push({
        sourceQualifiedName: enclosingSymbol,
        edgeType: 'calls',
        targetName: property.text,
        targetExportName: null,
        targetModuleSpecifier: null,
        receiver: 'this',
        lineNumber: node.startPosition.row + 1,
      })
      return
    }
  }
  references.push({
    sourceQualifiedName: enclosingSymbol,
    edgeType: 'calls',
    targetName: functionNode?.text ?? node.text,
    targetExportName: null,
    targetModuleSpecifier: null,
    lineNumber: node.startPosition.row + 1,
  })
}

const collectJsxReference = (
  node: SyntaxNode,
  enclosingSymbol: string | null,
  references: ReferenceCandidateDraft[],
): void => {
  const nameNode = node.childForFieldName('name')
  // Only bare, capitalized identifiers are component references: lowercase tags are intrinsic
  // host elements (<div>); member-expression tags (<Foo.Bar/>) are the namespace case, deferred with B5.
  if (nameNode === null || nameNode.type !== 'identifier') return
  const tag = nameNode.text
  const first = tag.charAt(0)
  if (first === '' || first !== first.toUpperCase()) return
  references.push({
    sourceQualifiedName: enclosingSymbol,
    edgeType: 'references',
    targetName: tag,
    targetExportName: null,
    targetModuleSpecifier: null,
    lineNumber: node.startPosition.row + 1,
  })
}

// Parent node types under which a bare `identifier` is NOT a value reference to a symbol: the callee
// of a call/new (calls handles it / construct is intentionally unresolved), import & export bindings,
// parameter and destructuring binders, and JSX-tag / heritage identifiers (their own handlers emit
// the edge); object-literal keys and member properties are `property_identifier`s — never here.
const NON_VALUE_REFERENCE_PARENTS: ReadonlySet<string> = new Set([
  'call_expression',
  'new_expression',
  'import_specifier',
  'import_clause',
  'namespace_import',
  'export_specifier',
  'required_parameter',
  'optional_parameter',
  'object_pattern',
  'array_pattern',
  'rest_pattern',
  'pair_pattern',
  'jsx_opening_element',
  'jsx_self_closing_element',
  'jsx_closing_element',
  'extends_clause',
  'implements_clause',
])

// A bare value identifier used AS a value — argument (`f(target)`), initializer (`const g = target`),
// array/return/assignment operand, member-expression object (`target.foo`): the "used as a value, not
// called" form the graph missed entirely (B6) — the indexer only emitted calls / JSX / heritage /
// imports. Emitted as a `references` edge with NO module specifier — the resolver binds it through
// the same import map / same-module path as a bare call; because findIncomingReferences only surfaces
// edges with a resolved target, an unresolved bare identifier (a local, a parameter, a non-imported
// name) is stored with a null target and never surfaces as false. Shorthand `{ target }` stays a gap.
const collectValueReference = (
  node: SyntaxNode,
  enclosingSymbol: string | null,
  references: ReferenceCandidateDraft[],
): void => {
  const parent = node.parent
  if (parent === null || NON_VALUE_REFERENCE_PARENTS.has(parent.type)) return
  // The name being declared (variable_declarator / function / class / etc.) is a binder, not a use.
  if (occupiesNameField(parent, node)) return
  references.push({
    sourceQualifiedName: enclosingSymbol,
    edgeType: 'references',
    targetName: node.text,
    targetExportName: null,
    targetModuleSpecifier: null,
    lineNumber: node.startPosition.row + 1,
  })
}

const collectHeritageReferences = (
  node: SyntaxNode,
  enclosingSymbol: string | null,
  references: ReferenceCandidateDraft[],
): void => {
  // Only class heritage reaches here: a class's `extends` is an `extends_clause`, its `implements`
  // an `implements_clause`; an interface's `extends` is an `extends_type_clause` (type position) —
  // its bare type identifiers emit as `type_refs` via collectTypeReference (B7).
  if (node.type === 'extends_clause') {
    // Class `extends` — value position. `value` is the base; type arguments (`extends Base<T>`) hang
    // off a sibling `type_arguments` (base still captured); member-expression bases are skipped — B5.
    const base = node.childForFieldName('value')
    if (base !== null && base.type === 'identifier') {
      references.push({
        sourceQualifiedName: enclosingSymbol,
        edgeType: 'extends',
        targetName: base.text,
        targetExportName: null,
        targetModuleSpecifier: null,
        lineNumber: base.startPosition.row + 1,
      })
    }
    return
  }
  // implements_clause — type position; one edge per BARE implemented interface identifier. Generic
  // (`implements Foo<X>` → `generic_type`) and qualified (`implements ns.Bar` →
  // `nested_type_identifier`) forms are intentionally skipped here — deferred (B5 / type-arg slice).
  for (let i = 0; i < node.namedChildCount; i += 1) {
    const child = node.namedChild(i)
    if (child?.type === 'type_identifier') {
      references.push({
        sourceQualifiedName: enclosingSymbol,
        edgeType: 'implements',
        targetName: child.text,
        targetExportName: null,
        targetModuleSpecifier: null,
        lineNumber: child.startPosition.row + 1,
      })
    }
  }
}

// Residue #7: a no-from `export { x }` re-exports an imported binding; x has no local symbol row, so the
// row lands null-symbol AND null-specifier and the B4 chain dead-ends. Link to x's module (order-independent: post-walk).
const linkImportedSpecifiers = (
  rawModuleExports: readonly ModuleExportCandidate[],
  references: readonly ReferenceCandidateDraft[],
): ModuleExportCandidate[] => {
  const specifierByImportedName = new Map<string, string>()
  for (const ref of references) {
    if (ref.edgeType === 'imports' && ref.targetModuleSpecifier !== null) {
      specifierByImportedName.set(ref.targetName, ref.targetModuleSpecifier)
    }
  }
  return rawModuleExports.map((moduleExport) =>
    moduleExport.exportKind === 'named' &&
    moduleExport.targetModuleSpecifier === null &&
    moduleExport.localName !== null &&
    specifierByImportedName.has(moduleExport.localName)
      ? { ...moduleExport, targetModuleSpecifier: specifierByImportedName.get(moduleExport.localName) ?? null }
      : moduleExport,
  )
}

export const extractReferenceCandidates = (
  input: Readonly<ExtractReferenceCandidatesInput>,
): ExtractReferenceCandidatesResult => {
  const rawModuleExports: ModuleExportCandidate[] = []
  const references: ReferenceCandidateDraft[] = []
  const visit = (node: SyntaxNode, enclosingSymbol: string | null, pending: readonly string[] = []): void => {
    if (node.type === 'export_statement') {
      collectExportCandidates(node, enclosingSymbol, input.moduleKey, rawModuleExports, references, visit)
      return
    }
    if (node.type === 'import_specifier') collectImportReference(node, references)
    if (node.type === 'namespace_import') collectNamespaceImportReference(node, references)
    if (node.type === 'identifier' && node.parent?.type === 'import_clause') {
      const importStatement = node.parent.parent
      references.push({
        sourceQualifiedName: null,
        edgeType: 'imports',
        targetName: node.text,
        targetExportName: 'default',
        targetModuleSpecifier: normalizeSpecifier(importStatement?.childForFieldName('source')),
        lineNumber: node.startPosition.row + 1,
      })
    }
    if (isNamedScopeBoundary(node)) {
      visitChildren(node, nextEnclosingSymbol(input.moduleKey, node, enclosingSymbol, pending), [], visit)
      return
    }
    if (node.type === 'call_expression') collectCallReference(node, enclosingSymbol, references)
    if (node.type === 'identifier') collectValueReference(node, enclosingSymbol, references)
    if (node.type === 'jsx_opening_element' || node.type === 'jsx_self_closing_element') {
      collectJsxReference(node, enclosingSymbol, references)
    }
    if (node.type === 'extends_clause' || node.type === 'implements_clause') {
      collectHeritageReferences(node, enclosingSymbol, references)
    }
    if (node.type === 'type_identifier') collectTypeReference(node, enclosingSymbol, references)
    visitChildren(node, enclosingSymbol, pendingSegmentsFor(node, pending), visit)
  }

  visit(input.tree.rootNode, null)

  const moduleExports = linkImportedSpecifiers(rawModuleExports, references)
  return { moduleExports, references: withLineText(references, input.source) }
}
