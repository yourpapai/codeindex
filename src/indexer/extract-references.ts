import type { Node as SyntaxNode, Tree } from 'web-tree-sitter'

import {
  collectExportCandidates,
  normalizeSpecifier,
  type ModuleExportCandidate,
  type ReferenceCandidate,
} from './collect-export-candidates.js'

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
  visit: (child: SyntaxNode, childEnclosingSymbol: string | null) => void,
): void => {
  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index)
    if (child !== null) visit(child, enclosingSymbol)
  }
}

const nextEnclosingSymbol = (moduleKey: string, node: SyntaxNode, enclosingSymbol: string | null): string | null => {
  const functionName = node.childForFieldName('name')?.text
  if (functionName === undefined) return enclosingSymbol
  return enclosingSymbol === null ? `${moduleKey}#${functionName}` : `${enclosingSymbol}>${functionName}`
}

// A boundary is a node that OWNS a symbol row (see extract-symbols' declarationTypes). A named
// function expression used as a bare callback (`register(function inner(){})`) is deliberately NOT
// included: extract-symbols emits no symbol for it, so treating it as a boundary here would attribute
// references to a phantom `outer>inner` source that no symbol backs. Such references belong to the
// nearest REAL enclosing symbol. Function/arrow expressions bound to a variable declarator ARE
// boundaries — the declarator itself is the symbol row.
const isNamedScopeBoundary = (node: SyntaxNode): boolean =>
  node.type === 'function_declaration' ||
  node.type === 'class_declaration' ||
  node.type === 'abstract_class_declaration' ||
  node.type === 'method_definition' ||
  (node.type === 'variable_declarator' &&
    (node.childForFieldName('value')?.type === 'arrow_function' ||
      node.childForFieldName('value')?.type === 'function_expression'))

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

export const extractReferenceCandidates = (
  input: Readonly<ExtractReferenceCandidatesInput>,
): ExtractReferenceCandidatesResult => {
  const moduleExports: ModuleExportCandidate[] = []
  const references: ReferenceCandidate[] = []
  const visit = (node: SyntaxNode, enclosingSymbol: string | null): void => {
    if (node.type === 'export_statement') {
      collectExportCandidates(node, enclosingSymbol, input.moduleKey, moduleExports, references, visit)
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
      visitChildren(node, nextEnclosingSymbol(input.moduleKey, node, enclosingSymbol), visit)
      return
    }
    if (node.type === 'call_expression') collectCallReference(node, enclosingSymbol, references)
    if (node.type === 'jsx_opening_element' || node.type === 'jsx_self_closing_element') {
      collectJsxReference(node, enclosingSymbol, references)
    }
    if (node.type === 'extends_clause' || node.type === 'implements_clause') {
      collectHeritageReferences(node, enclosingSymbol, references)
    }
    visitChildren(node, enclosingSymbol, visit)
  }

  visit(input.tree.rootNode, null)
  return { moduleExports, references }
}
