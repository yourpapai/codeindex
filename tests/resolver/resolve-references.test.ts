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
})
