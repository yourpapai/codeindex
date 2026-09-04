import type { Node as SyntaxNode, Tree } from 'web-tree-sitter'

import {
  collectExportCandidates,
  normalizeSpecifier,
  type ModuleExportCandidate,
  type ReferenceCandidate,
} from './collect-export-candidates.js'
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

const collectImportReference = (node: SyntaxNode, references: ReferenceCandidate[]): void => {
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
  references: ReferenceCandidate[],
): void => {
  const functionNode = node.childForFieldName('function')
  // this.m() — a member call whose receiver is `this` resolves to the enclosing class's method (B2).
  // Emit the bare property name plus a `this` receiver marker so the resolver can bind it to
  // <enclosingClass>>m. Non-`this` receivers (obj.m()) are left as the whole member-expression text
  // (unresolved) — deferred.
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
  references: ReferenceCandidate[],
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

// Parent node types under which a bare `identifier` is NOT a value reference to a symbol: the
// callee of a call/new (calls handles it / construct is intentionally unresolved), import & export
// bindings, parameter and destructuring binders, and JSX-tag / heritage identifiers (their own
// handlers emit the edge). Object-literal keys and member property names are `property_identifier`
// / `shorthand_property_identifier`, a different node type, so they never reach this path.
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

const occupiesNameField = (parent: SyntaxNode, node: SyntaxNode): boolean => {
  const nameField = parent.childForFieldName('name')
  return nameField !== null && nameField.startIndex === node.startIndex && nameField.endIndex === node.endIndex
}

// A bare value identifier used AS a value — an argument (`f(target)`), initializer (`const g = target`),
// array/return/assignment operand, or member-expression object (`target.foo`). This is the "used as a
// value, not called" reference form the graph missed entirely (B6): the indexer only emitted edges for
// calls / JSX / heritage / imports. Emitted as a `references` edge with NO module specifier, so the
// resolver binds it through the same import map / same-module path as a bare call — and because
// findIncomingReferences only surfaces edges with a resolved target, an unresolved bare identifier
// (a local, a parameter, a non-imported name) is inserted with a null target and never appears as a
// false incoming reference. Shorthand `{ target }` (a `shorthand_property_identifier`) is a known
// recall gap, not handled here.
const collectValueReference = (
  node: SyntaxNode,
  enclosingSymbol: string | null,
  references: ReferenceCandidate[],
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
  references: ReferenceCandidate[],
): void => {
  // Only class heritage reaches here: a class's `extends` is an `extends_clause`, its
  // `implements` an `implements_clause`. An interface's `extends` is a separate
  // `extends_type_clause` node (type position) that this slice does NOT handle — those
  // type-position edges are deferred (they show up as typeFN in the bench, the B7 gap).
  if (node.type === 'extends_clause') {
    // Class `extends` — value position. `value` is the base identifier; type arguments
    // (`extends Base<T>`) hang off a sibling `type_arguments` node, so the base is still
    // captured. Member-expression bases (`extends Foo.Bar`) are skipped — namespaces (B5).
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
  // implements_clause — type position; one edge per BARE implemented interface identifier.
  // Generic (`implements Foo<X>` → `generic_type`) and qualified (`implements ns.Bar` →
  // `nested_type_identifier`) forms are intentionally skipped here: the generic case waits on
  // the type-argument slice and the qualified case on namespaces (B5). Both are deferred.
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

// Residue #7: a no-from `export { x }` re-exports an imported binding — x has no local symbol
// row, so the row lands with a null symbol AND null specifier and the B4 chain dead-ends. Link
// it to the module x was imported from (order-independent: applied after the whole walk).
const linkImportedSpecifiers = (
  rawModuleExports: readonly ModuleExportCandidate[],
  references: readonly ReferenceCandidate[],
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
  const references: ReferenceCandidate[] = []
  const visit = (node: SyntaxNode, enclosingSymbol: string | null, pending: readonly string[] = []): void => {
    if (node.type === 'export_statement') {
      collectExportCandidates(node, enclosingSymbol, input.moduleKey, rawModuleExports, references, visit)
      return
    }
    if (node.type === 'import_specifier') collectImportReference(node, references)
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
    visitChildren(node, enclosingSymbol, pendingSegmentsFor(node, pending), visit)
  }

  visit(input.tree.rootNode, null)

  const moduleExports = linkImportedSpecifiers(rawModuleExports, references)
  return { moduleExports, references }
}
