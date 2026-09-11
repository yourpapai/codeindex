import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import {
  buildStructuredToolResult,
  CodeIndexOutputSchema,
  CodeImpactOutputSchema,
  CodeOutlineInputSchema,
  CodeOutlineOutputSchema,
  CodeSearchOutputSchema,
  CodeSymbolOutputSchema,
} from '../../src/mcp/tools.js'

describe('output schemas', () => {
  test('CodeSearchOutputSchema validates a search envelope', () => {
    const data = {
      query: 'helper',
      resultCount: 1,
      results: [
        {
          symbolKey: 'a',
          qualifiedName: 'src/foo#helper',
          localName: 'helper',
          kind: 'function_declaration',
          scopeTier: 'exported',
          filePath: 'src/foo.ts',
          startLine: 1,
          endLine: 1,
          exportNames: ['helper'],
          matchedBy: 'exact_export',
          confidence: 'resolved',
          snippet: 'export function helper() {}',
          rankScore: 900,
        },
      ],
    }
    expect(CodeSearchOutputSchema.safeParse(data).success).toBe(true)
  })

  test('CodeSearchOutputSchema accepts guidance field', () => {
    const data = {
      query: 'missing',
      resultCount: 0,
      results: [],
      guidance: 'No symbol matches. Retry with broader terms.',
    }
    expect(CodeSearchOutputSchema.safeParse(data).success).toBe(true)
  })

  test('CodeSymbolOutputSchema validates symbol results', () => {
    const data = {
      results: [
        {
          symbolKey: 'a',
          qualifiedName: 'src/foo#helper',
          localName: 'helper',
          kind: 'function_declaration',
          scopeTier: 'exported',
          filePath: 'src/foo.ts',
          startLine: 1,
          endLine: 1,
          exportNames: ['helper'],
          matchedBy: 'exact_export',
          confidence: 'resolved',
          snippet: 'export function helper() {}',
          rankScore: 900,
        },
      ],
    }
    expect(CodeSymbolOutputSchema.safeParse(data).success).toBe(true)
  })

  test('CodeImpactOutputSchema validates impact results', () => {
    const data = {
      results: [
        {
          sourceQualifiedName: 'src/app#main',
          sourceFilePath: 'src/app.ts',
          edgeType: 'imports',
          confidence: 'resolved',
          lineNumber: 1,
          snippet: "import { helper } from './helper.js'",
        },
      ],
    }
    expect(CodeImpactOutputSchema.safeParse(data).success).toBe(true)
  })

  test('CodeIndexOutputSchema validates index summary', () => {
    const data = {
      filesIndexed: 10,
      filesFailed: 0,
      filesPruned: 0,
      skippedFiles: [],
      skippedFilesTotal: 0,
      symbolsIndexed: 50,
      referencesIndexed: 100,
      referencesUnresolved: 2,
      referencesRepaired: 0,
      elapsedMs: 1234,
    }
    expect(CodeIndexOutputSchema.safeParse(data).success).toBe(true)
  })
})

describe('CodeOutlineInputSchema', () => {
  test('requires filePath and mode', () => {
    expect(CodeOutlineInputSchema.safeParse({ filePath: 'src/foo.ts', mode: 'symbols' }).success).toBe(true)
    expect(CodeOutlineInputSchema.safeParse({ mode: 'symbols' }).success).toBe(false)
    expect(CodeOutlineInputSchema.safeParse({ filePath: 'src/foo.ts' }).success).toBe(false)
    expect(CodeOutlineInputSchema.safeParse({ filePath: 'src/foo.ts', mode: 'both' }).success).toBe(false)
  })

  test('defaults limit to 200 and caps at 500', () => {
    const parsed = CodeOutlineInputSchema.parse({ filePath: 'src/foo.ts', mode: 'symbols' })
    expect(parsed.limit).toBe(200)
    expect(CodeOutlineInputSchema.safeParse({ filePath: 'src/foo.ts', mode: 'symbols', limit: 500 }).success).toBe(true)
    expect(CodeOutlineInputSchema.safeParse({ filePath: 'src/foo.ts', mode: 'symbols', limit: 501 }).success).toBe(
      false,
    )
  })

  test('accepts optional scopeTiers and kinds', () => {
    const parsed = CodeOutlineInputSchema.parse({
      filePath: 'src/foo.ts',
      mode: 'symbols',
      scopeTiers: ['exported', 'module'],
      kinds: ['function_declaration'],
    })
    expect(parsed.scopeTiers).toEqual(['exported', 'module'])
    expect(parsed.kinds).toEqual(['function_declaration'])
  })
})

describe('CodeOutlineOutputSchema', () => {
  test('validates symbols-mode envelope without body fields', () => {
    const data = {
      filePath: 'src/foo.ts',
      mode: 'symbols',
      resultCount: 1,
      truncated: false,
      results: [
        {
          symbolKey: 'src/foo.ts#1-3',
          qualifiedName: 'src/foo#helper',
          localName: 'helper',
          kind: 'function_declaration',
          scopeTier: 'exported',
          filePath: 'src/foo.ts',
          startLine: 1,
          endLine: 3,
          signatureText: 'export function helper() {}',
          exportNames: ['helper'],
        },
      ],
    }
    expect(CodeOutlineOutputSchema.safeParse(data).success).toBe(true)
  })

  test('validates exports-mode barrel rows with nullable linkage', () => {
    const data = {
      filePath: 'src/index.ts',
      mode: 'exports',
      resultCount: 1,
      truncated: false,
      results: [
        {
          exportName: 'helper',
          exportKind: 'reexport',
          symbolId: null,
          qualifiedName: null,
          targetModuleSpecifier: './helper',
          filePath: 'src/index.ts',
        },
      ],
    }
    expect(CodeOutlineOutputSchema.safeParse(data).success).toBe(true)
  })
})

describe('buildStructuredToolResult', () => {
  test('returns structuredContent plus a compact text summary (not full JSON)', () => {
    const schema = z.object({ value: z.number() })
    const result = buildStructuredToolResult(schema, { value: 42 }, '1 value')

    expect(result.content[0]!.type).toBe('text')
    expect(result.content[0]!.text).toBe('1 value')
    expect(result.structuredContent).toEqual({ value: 42 })
  })

  test('does not duplicate the full payload into the text channel', () => {
    const schema = z.object({ items: z.array(z.string()) })
    const result = buildStructuredToolResult(schema, { items: ['a', 'b'] }, '2 items')

    expect(result.content[0]!.text).toBe('2 items')
    expect(result.content[0]!.text).not.toContain('[')
    expect(result.structuredContent).toEqual({ items: ['a', 'b'] })
  })
})
