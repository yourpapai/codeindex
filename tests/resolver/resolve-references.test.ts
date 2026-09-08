import { describe, expect, test } from 'bun:test'

import { resolveReferenceCandidates } from '../../src/resolver/resolve-references.js'

describe('resolveReferenceCandidates', () => {
  test('resolvedByName does not cross to a different file when the target file is identified', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [
        { id: 1, qualifiedName: 'src/aaa#helper', localName: 'helper', moduleKey: 'src/aaa', exportNames: ['helper'] },
        {
          id: 2,
          qualifiedName: 'src/helper#helper',
          localName: 'helper',
          moduleKey: 'src/helper',
          exportNames: ['nope'],
        },
      ],
      moduleAliases: [{ aliasKey: 'src/helper', fileId: 20 }],
      files: [
        { id: 10, moduleKey: 'src/aaa' },
        { id: 20, moduleKey: 'src/helper' },
      ],
      references: [
        {
          sourceQualifiedName: null,
          edgeType: 'imports',
          targetName: 'helper',
          targetExportName: 'unknown',
          targetModuleSpecifier: './helper',
          lineNumber: 1,
        },
      ],
      currentModuleKey: 'src/run-task',
    })

    expect(resolved[0]).toMatchObject({ targetSymbolId: 2, confidence: 'file_resolved' })
  })

  test('unqualified reference does not cross to a foreign module symbol', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [
        { id: 1, qualifiedName: 'src/a#helper', localName: 'helper', moduleKey: 'src/a', exportNames: ['helper'] },
        { id: 2, qualifiedName: 'src/b#localFn', localName: 'localFn', moduleKey: 'src/b', exportNames: [] },
      ],
      moduleAliases: [],
      files: [
        { id: 10, moduleKey: 'src/a' },
        { id: 20, moduleKey: 'src/b' },
      ],
      references: [
        {
          sourceQualifiedName: 'src/b#localFn',
          edgeType: 'calls',
          targetName: 'helper',
          targetExportName: null,
          targetModuleSpecifier: null,
          lineNumber: 5,
        },
      ],
      currentModuleKey: 'src/b',
    })

    expect(resolved[0]).toMatchObject({ targetSymbolId: null, confidence: 'name_only' })
  })

  test('unqualified reference resolves to a same-module symbol', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [
        { id: 1, qualifiedName: 'src/a#helper', localName: 'helper', moduleKey: 'src/a', exportNames: ['helper'] },
        { id: 2, qualifiedName: 'src/b#helper', localName: 'helper', moduleKey: 'src/b', exportNames: [] },
        { id: 3, qualifiedName: 'src/b#caller', localName: 'caller', moduleKey: 'src/b', exportNames: [] },
      ],
      moduleAliases: [],
      files: [
        { id: 10, moduleKey: 'src/a' },
        { id: 20, moduleKey: 'src/b' },
      ],
      references: [
        {
          sourceQualifiedName: 'src/b#caller',
          edgeType: 'calls',
          targetName: 'helper',
          targetExportName: null,
          targetModuleSpecifier: null,
          lineNumber: 10,
        },
      ],
      currentModuleKey: 'src/b',
    })

    expect(resolved[0]).toMatchObject({ targetSymbolId: 2, confidence: 'name_only' })
  })

  test('populates targetFileId when module specifier resolves to a known file even if symbol is absent', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [],
      moduleAliases: [],
      files: [{ id: 10, moduleKey: 'src/helper' }],
      references: [
        {
          sourceQualifiedName: null,
          edgeType: 'imports',
          targetName: 'myFunc',
          targetExportName: 'myFunc',
          targetModuleSpecifier: './helper',
          lineNumber: 1,
        },
      ],
      currentModuleKey: 'src/main',
    })

    expect(resolved).toEqual([expect.objectContaining({ targetSymbolId: null, targetFileId: 10 })])
  })

  test('this.m() resolves to the enclosing class method, not a same-named method of another class', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [
        { id: 1, qualifiedName: 'src/c#C>foo', localName: 'foo', moduleKey: 'src/c', exportNames: [] },
        { id: 2, qualifiedName: 'src/c#C>bar', localName: 'bar', moduleKey: 'src/c', exportNames: [] },
        { id: 3, qualifiedName: 'src/c#D>bar', localName: 'bar', moduleKey: 'src/c', exportNames: [] },
      ],
      moduleAliases: [],
      files: [{ id: 10, moduleKey: 'src/c' }],
      references: [
        {
          sourceQualifiedName: 'src/c#C>foo',
          edgeType: 'calls',
          targetName: 'bar',
          targetExportName: null,
          targetModuleSpecifier: null,
          receiver: 'this',
          lineNumber: 2,
        },
      ],
      currentModuleKey: 'src/c',
    })
    expect(resolved[0]).toMatchObject({ targetSymbolId: 2, confidence: 'resolved' })
  })

  test('this.m() resolves through a nested arrow inside the method', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [
        { id: 1, qualifiedName: 'src/c#C>foo>cb', localName: 'cb', moduleKey: 'src/c', exportNames: [] },
        { id: 2, qualifiedName: 'src/c#C>bar', localName: 'bar', moduleKey: 'src/c', exportNames: [] },
      ],
      moduleAliases: [],
      files: [{ id: 10, moduleKey: 'src/c' }],
      references: [
        {
          sourceQualifiedName: 'src/c#C>foo>cb',
          edgeType: 'calls',
          targetName: 'bar',
          targetExportName: null,
          targetModuleSpecifier: null,
          receiver: 'this',
          lineNumber: 3,
        },
      ],
      currentModuleKey: 'src/c',
    })
    expect(resolved[0]).toMatchObject({ targetSymbolId: 2, confidence: 'resolved' })
  })

  test('this.m() with no matching enclosing-class method stays unresolved (no cross-class fallback)', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [
        { id: 1, qualifiedName: 'src/c#C>foo', localName: 'foo', moduleKey: 'src/c', exportNames: [] },
        { id: 3, qualifiedName: 'src/c#D>bar', localName: 'bar', moduleKey: 'src/c', exportNames: [] },
      ],
      moduleAliases: [],
      files: [{ id: 10, moduleKey: 'src/c' }],
      references: [
        {
          sourceQualifiedName: 'src/c#C>foo',
          edgeType: 'calls',
          targetName: 'bar',
          targetExportName: null,
          targetModuleSpecifier: null,
          receiver: 'this',
          lineNumber: 2,
        },
      ],
      currentModuleKey: 'src/c',
    })
    expect(resolved[0]).toMatchObject({ targetSymbolId: null, confidence: 'name_only' })
  })

  test('this.m() with null source (module-scope lexical-this callback) does not fall through to bare-name matching', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [{ id: 5, qualifiedName: 'src/c#helper', localName: 'helper', moduleKey: 'src/c', exportNames: [] }],
      moduleAliases: [],
      files: [{ id: 10, moduleKey: 'src/c' }],
      references: [
        {
          sourceQualifiedName: null,
          edgeType: 'calls',
          targetName: 'helper',
          targetExportName: null,
          targetModuleSpecifier: null,
          receiver: 'this',
          lineNumber: 2,
        },
      ],
      currentModuleKey: 'src/c',
    })
    expect(resolved[0]).toMatchObject({ targetSymbolId: null, confidence: 'name_only' })
  })

  test('specified-but-unmatched import resolves to no symbol (C2 suppression)', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [{ id: 1, qualifiedName: 'src/a#eq', localName: 'eq', moduleKey: 'src/a', exportNames: [] }],
      moduleAliases: [],
      files: [{ id: 10, moduleKey: 'src/a' }],
      references: [
        {
          sourceQualifiedName: null,
          edgeType: 'imports',
          targetName: 'eq',
          targetExportName: 'eq',
          targetModuleSpecifier: 'drizzle-orm',
          lineNumber: 1,
        },
      ],
      currentModuleKey: 'src/b',
    })
    expect(resolved[0]).toMatchObject({ targetSymbolId: null, confidence: 'name_only', targetFileId: null })
  })

  test('B6 guard and C2 suppression compose: value reference with unmatched specifier binds nothing', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [{ id: 1, qualifiedName: 'src/a#target', localName: 'target', moduleKey: 'src/a', exportNames: [] }],
      moduleAliases: [],
      files: [{ id: 10, moduleKey: 'src/a' }],
      references: [
        {
          sourceQualifiedName: 'src/b#caller',
          edgeType: 'references',
          targetName: 'target',
          targetExportName: null,
          targetModuleSpecifier: 'phantom-pkg',
          lineNumber: 2,
        },
      ],
      currentModuleKey: 'src/b',
    })
    expect(resolved[0]).toMatchObject({ targetSymbolId: null, confidence: 'name_only' })
  })

  test('star barrel: caller resolves a star-forwarded name through the chain (B5)', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [
        {
          id: 1,
          qualifiedName: 'src/star-target#starCalled',
          localName: 'starCalled',
          moduleKey: 'src/star-target',
          exportNames: ['starCalled'],
        },
      ],
      moduleAliases: [],
      files: [
        { id: 10, moduleKey: 'src/star-index' },
        { id: 11, moduleKey: 'src/star-target' },
      ],
      moduleExports: [
        {
          moduleKey: 'src/star-index',
          exportName: '*',
          exportKind: 'star',
          symbolId: null,
          targetModuleSpecifier: './star-target',
        },
        {
          moduleKey: 'src/star-target',
          exportName: 'starCalled',
          exportKind: 'named',
          symbolId: 1,
          targetModuleSpecifier: null,
        },
      ],
      references: [
        {
          sourceQualifiedName: null,
          edgeType: 'imports',
          targetName: 'starCalled',
          targetExportName: 'starCalled',
          targetModuleSpecifier: './star-index',
          lineNumber: 1,
        },
      ],
      currentModuleKey: 'src/caller',
    })
    expect(resolved[0]).toMatchObject({ targetSymbolId: 1, confidence: 'resolved' })
  })

  test('namespace import resolves to the file only and never name-matches a same-named local (B5)', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [{ id: 1, qualifiedName: 'src/ns#ns', localName: 'ns', moduleKey: 'src/ns', exportNames: [] }],
      moduleAliases: [],
      files: [{ id: 10, moduleKey: 'src/ns' }],
      moduleExports: [],
      references: [
        {
          sourceQualifiedName: null,
          edgeType: 'imports',
          targetName: 'ns',
          targetExportName: '*',
          targetModuleSpecifier: './ns',
          lineNumber: 1,
        },
      ],
      currentModuleKey: 'src/caller',
    })
    expect(resolved[0]).toMatchObject({ targetSymbolId: null, confidence: 'file_resolved', targetFileId: 10 })
  })

  test('import-backed type reference resolves through the import map (B7)', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [
        {
          id: 1,
          qualifiedName: 'src/task-types#Task',
          localName: 'Task',
          moduleKey: 'src/task-types',
          exportNames: ['Task'],
          kind: 'interface_declaration',
        },
      ],
      moduleAliases: [],
      files: [{ id: 10, moduleKey: 'src/task-types' }],
      references: [
        {
          sourceQualifiedName: null,
          edgeType: 'imports',
          targetName: 'Task',
          targetExportName: 'Task',
          targetModuleSpecifier: './task-types',
          lineNumber: 1,
        },
        {
          sourceQualifiedName: 'src/task-user#process',
          edgeType: 'type_refs',
          targetName: 'Task',
          targetExportName: null,
          targetModuleSpecifier: null,
          lineNumber: 3,
        },
      ],
      currentModuleKey: 'src/task-user',
    })
    expect(resolved[1]).toMatchObject({
      targetSymbolId: 1,
      confidence: 'resolved',
      edgeType: 'type_refs',
      targetFileId: null,
    })
  })

  test('same-module type reference binds to a type-shaped symbol (B7 kind filter)', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [
        {
          id: 1,
          qualifiedName: 'src/mod#Task',
          localName: 'Task',
          moduleKey: 'src/mod',
          exportNames: [],
          kind: 'interface_declaration',
        },
      ],
      moduleAliases: [],
      files: [],
      references: [
        {
          sourceQualifiedName: 'src/mod#process',
          edgeType: 'type_refs',
          targetName: 'Task',
          targetExportName: null,
          targetModuleSpecifier: null,
          lineNumber: 2,
        },
      ],
      currentModuleKey: 'src/mod',
    })
    expect(resolved[0]).toMatchObject({ targetSymbolId: 1, confidence: 'name_only' })
  })

  test('same-module type reference refuses non-type-shaped and kind-less symbols (B7 kind filter)', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [
        {
          id: 1,
          qualifiedName: 'src/mod#Task',
          localName: 'Task',
          moduleKey: 'src/mod',
          exportNames: [],
          kind: 'function_declaration',
        },
        { id: 2, qualifiedName: 'src/mod#Task', localName: 'Task', moduleKey: 'src/mod', exportNames: [] },
      ],
      moduleAliases: [],
      files: [],
      references: [
        {
          sourceQualifiedName: 'src/mod#process',
          edgeType: 'type_refs',
          targetName: 'Task',
          targetExportName: null,
          targetModuleSpecifier: null,
          lineNumber: 2,
        },
      ],
      currentModuleKey: 'src/mod',
    })
    expect(resolved[0]).toMatchObject({ targetSymbolId: null, confidence: 'name_only' })
  })

  test('C2 composes with type refs: an unmatched specifier binds nothing (B7)', () => {
    const resolved = resolveReferenceCandidates({
      symbols: [
        {
          id: 1,
          qualifiedName: 'src/mod#Task',
          localName: 'Task',
          moduleKey: 'src/mod',
          exportNames: [],
          kind: 'interface_declaration',
        },
      ],
      moduleAliases: [],
      files: [],
      references: [
        {
          sourceQualifiedName: 'src/mod#process',
          edgeType: 'type_refs',
          targetName: 'Task',
          targetExportName: null,
          targetModuleSpecifier: 'phantom-pkg',
          lineNumber: 2,
        },
      ],
      currentModuleKey: 'src/mod',
    })
    expect(resolved[0]).toMatchObject({ targetSymbolId: null, confidence: 'name_only', targetFileId: null })
  })

  test.each([
    'interface_declaration',
    'type_alias_declaration',
    'enum_declaration',
    'class_declaration',
    'abstract_class_declaration',
  ])('same-module type ref binds to a %s (B7 kind filter, per-kind pin)', (kind) => {
    const resolved = resolveReferenceCandidates({
      symbols: [
        { id: 1, qualifiedName: 'src/mod#Task', localName: 'Task', moduleKey: 'src/mod', exportNames: [], kind },
      ],
      moduleAliases: [],
      files: [],
      references: [
        {
          sourceQualifiedName: 'src/mod#process',
          edgeType: 'type_refs',
          targetName: 'Task',
          targetExportName: null,
          targetModuleSpecifier: null,
          lineNumber: 2,
        },
      ],
      currentModuleKey: 'src/mod',
    })
    expect(resolved[0]).toMatchObject({ targetSymbolId: 1, confidence: 'name_only' })
  })

  test('multi-star barrel: the FIRST star source wins the name (B5 first-hit-wins pin)', () => {
    // Both star targets export `picked`, so the result discriminates the iteration order: if the
    // star loop ever processed './second' first, symbol 2 would win this pin. targetFileId stays
    // the barrel's own id — it is the specifier-matched file, never a star source's file.
    const resolved = resolveReferenceCandidates({
      symbols: [
        {
          id: 1,
          qualifiedName: 'src/first#picked',
          localName: 'picked',
          moduleKey: 'src/first',
          exportNames: ['picked'],
        },
        {
          id: 2,
          qualifiedName: 'src/second#picked',
          localName: 'picked',
          moduleKey: 'src/second',
          exportNames: ['picked'],
        },
      ],
      moduleAliases: [],
      files: [
        { id: 10, moduleKey: 'src/star-barrel' },
        { id: 11, moduleKey: 'src/first' },
        { id: 12, moduleKey: 'src/second' },
      ],
      moduleExports: [
        {
          moduleKey: 'src/star-barrel',
          exportName: '*',
          exportKind: 'star',
          symbolId: null,
          targetModuleSpecifier: './first',
        },
        {
          moduleKey: 'src/star-barrel',
          exportName: '*',
          exportKind: 'star',
          symbolId: null,
          targetModuleSpecifier: './second',
        },
        { moduleKey: 'src/first', exportName: 'picked', exportKind: 'named', symbolId: 1, targetModuleSpecifier: null },
        {
          moduleKey: 'src/second',
          exportName: 'picked',
          exportKind: 'named',
          symbolId: 2,
          targetModuleSpecifier: null,
        },
      ],
      references: [
        {
          sourceQualifiedName: null,
          edgeType: 'imports',
          targetName: 'picked',
          targetExportName: 'picked',
          targetModuleSpecifier: './star-barrel',
          lineNumber: 1,
        },
      ],
      currentModuleKey: 'src/caller',
    })
    expect(resolved[0]).toMatchObject({ targetSymbolId: 1, confidence: 'resolved', targetFileId: 10 })
  })

  test('namespace import through a parent-level specifier resolves to the same file-only shape (B5)', () => {
    // Parent-level input: the specifier climbs out of a nested module directory (`../ns` from
    // src/feature/caller → src/ns), exercising the parent-dir normalization arm the sibling test's
    // './ns' join never touches. Same resolved shape as the sibling: file only, never name-matched.
    const resolved = resolveReferenceCandidates({
      symbols: [{ id: 1, qualifiedName: 'src/ns#ns', localName: 'ns', moduleKey: 'src/ns', exportNames: [] }],
      moduleAliases: [],
      files: [{ id: 10, moduleKey: 'src/ns' }],
      moduleExports: [],
      references: [
        {
          sourceQualifiedName: null,
          edgeType: 'imports',
          targetName: 'ns',
          targetExportName: '*',
          targetModuleSpecifier: '../ns',
          lineNumber: 1,
        },
      ],
      currentModuleKey: 'src/feature/caller',
    })
    expect(resolved[0]).toMatchObject({ targetSymbolId: null, confidence: 'file_resolved', targetFileId: 10 })
  })
})
