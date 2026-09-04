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
})
