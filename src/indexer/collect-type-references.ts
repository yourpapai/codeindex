import type { Node as SyntaxNode } from 'web-tree-sitter'

import type { ReferenceCandidateDraft } from './collect-export-candidates.js'

export const occupiesNameField = (parent: SyntaxNode, node: SyntaxNode): boolean => {
  const nameField = parent.childForFieldName('name')
  return nameField !== null && nameField.startIndex === node.startIndex && nameField.endIndex === node.endIndex
}

// B7: a `type_identifier` in type position is a named type reference (`: Task`, generic heads and arguments,
// as-casts, call/new type args, interface `extends_type_clause`); builtins (`predefined_type`) stay out by
// node type; heritage DIRECT children are excluded (collectHeritageReferences emits them — no double-count;
// B3 takes bare children only, so nested clause type args still emit); exclusion under binder parents hits
// ONLY the NAME field — the declared name (`type T = Q`: `T` stays out, its RHS `Q` occupies the value field
// and emits; a class EXPRESSION's only direct type_identifier is its optional name); `generic_type`'s `name`
// is the generic head, a USE (`Promise<T>` → `Promise`); `nested_type_identifier`'s leaf stays out.
const BINDER_PARENT_TYPE_NAMES =
  'interface_declaration class_declaration abstract_class_declaration type_alias_declaration enum_declaration type_parameter nested_type_identifier class'
const TYPE_NAME_BINDER_PARENTS: ReadonlySet<string> = new Set(BINDER_PARENT_TYPE_NAMES.split(' '))

export const collectTypeReference = (
  node: SyntaxNode,
  enclosingSymbol: string | null,
  references: ReferenceCandidateDraft[],
): void => {
  const parent = node.parent
  if (parent !== null && (parent.type === 'implements_clause' || parent.type === 'extends_clause')) return
  if (parent !== null && TYPE_NAME_BINDER_PARENTS.has(parent.type) && occupiesNameField(parent, node)) return
  references.push({
    sourceQualifiedName: enclosingSymbol,
    edgeType: 'type_refs',
    targetName: node.text,
    targetExportName: null,
    targetModuleSpecifier: null,
    lineNumber: node.startPosition.row + 1,
  })
}
