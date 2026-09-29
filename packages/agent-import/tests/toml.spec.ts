import { describe, expect, it } from 'vitest'
import { scanTomlSections } from '../src/toml.ts'

/** Read one section's value map, failing the test when the section is absent. */
function valuesOf(text: string, index = 0): Map<string, unknown> {
  const section = scanTomlSections(text).sections[index]
  expect(section).toBeDefined()
  return section?.values ?? new Map<string, unknown>()
}

describe('scanTomlSections — structure', () => {
  it('splits table headers on dots and keeps the values that follow them', () => {
    const document = scanTomlSections([
      '[mcp_servers.alpha]',
      'command = "node"',
      '[mcp_servers.alpha.env]',
      'TOKEN = "secret"',
      '[other]',
      'key = 1',
    ].join('\n'))
    expect(document.sections.map(section => section.path)).toEqual([
      ['mcp_servers', 'alpha'],
      ['mcp_servers', 'alpha', 'env'],
      ['other'],
    ])
    expect(document.sections[1]?.values.get('TOKEN')).toBe('secret')
    expect(document.skipped).toEqual([])
  })

  it('honors bare, quoted, and literal-quoted keys in headers', () => {
    const document = scanTomlSections([
      '[mcp_servers."with space".env]',
      'A = "1"',
      "[projects.'c:\\users\\me']",
      'trust_level = "trusted"',
      '[hooks.state."plugin@market:hooks/a.json:0:0"]',
      'seen = true',
    ].join('\n'))
    expect(document.sections[0]?.path).toEqual(['mcp_servers', 'with space', 'env'])
    expect(document.sections[1]?.path).toEqual(['projects', 'c:\\users\\me'])
    expect(document.sections[2]?.path).toEqual(['hooks', 'state', 'plugin@market:hooks/a.json:0:0'])
  })

  it('collects keys written before any header into a path-less section', () => {
    const document = scanTomlSections('model = "gpt"\n[table]\nkey = "value"')
    expect(document.sections[0]?.path).toEqual([])
    expect(document.sections[0]?.values.get('model')).toBe('gpt')
  })

  it('omits a path-less section that has no keys', () => {
    const document = scanTomlSections('# only a comment\n[table]\nkey = "value"')
    expect(document.sections.map(section => section.path)).toEqual([['table']])
  })

  it('keeps an empty table header as a section with no values', () => {
    const document = scanTomlSections('[mcp_servers]\n[after]\nkey = 1')
    expect(document.sections[0]?.path).toEqual(['mcp_servers'])
    expect(document.sections[0]?.values.size).toBe(0)
  })

  it('reads array-of-table headers as their own sections', () => {
    const document = scanTomlSections('[[skills]]\nname = "one"\n[[skills]]\nname = "two"')
    expect(document.sections.map(section => section.path)).toEqual([['skills'], ['skills']])
    expect(document.sections[1]?.values.get('name')).toBe('two')
  })

  it('accepts a dotted key inside a table', () => {
    expect(valuesOf('[table]\na.b = 1').get('a.b')).toBe(1)
  })

  it('ignores comments, blank lines, and trailing comment text', () => {
    expect(valuesOf('# lead\n\nkey = "value" # trailing\n# after').get('key')).toBe('value')
  })

  it('reads a statement that ends at end of file without a newline', () => {
    expect(valuesOf('[t]\nkey = "value"').get('key')).toBe('value')
  })

  it('records content that follows a header on the same line', () => {
    const document = scanTomlSections('[first] value = 1\n[second]\nkey = "x"')
    expect(document.sections.map(section => section.path)).toEqual([['first'], ['second']])
    expect(document.sections[0]?.values.size).toBe(0)
    expect(document.sections[1]?.values.get('key')).toBe('x')
    expect(document.skipped).toEqual(['value = 1'])
  })
})

describe('scanTomlSections — strings', () => {
  it('keeps literal strings verbatim, including backslashes', () => {
    const text = String.raw`[s]
command = 'C:\Users\me\.codex\mcp\python.exe'`
    expect(valuesOf(text).get('command')).toBe(String.raw`C:\Users\me\.codex\mcp\python.exe`)
  })

  it('expands every supported escape in a basic string', () => {
    const text = '[s]\nkey = "a\\tb\\nc\\rd\\be\\ff\\\\g\\"h\\u0041i\\U0001F600"'
    expect(valuesOf(text).get('key')).toBe('a\tb\nc\rd\be\ff\\g"hAi😀')
  })

  it('reports an unsupported escape instead of inventing a value', () => {
    const document = scanTomlSections('[s]\nkey = "bad \\q escape"\n[after]\nok = 1')
    expect(document.skipped).toEqual(['key = "bad \\q escape"'])
    expect(document.sections.map(section => section.path)).toEqual([['s'], ['after']])
    expect(document.sections[1]?.values.get('ok')).toBe(1)
  })

  it('rejects an invalid unicode escape', () => {
    const document = scanTomlSections('[s]\nkey = "\\uZZZZ"')
    expect(document.skipped).toHaveLength(1)
  })

  it('rejects a unicode escape beyond the Unicode range and keeps scanning', () => {
    const document = scanTomlSections('[s]\nkey = "\\U00110000"\nother = 1')
    expect(document.skipped).toEqual(['key = "\\U00110000"'])
    expect(document.sections[0]?.values.get('other')).toBe(1)
  })

  it('rejects an escape sequence cut off by end of file', () => {
    const document = scanTomlSections('[s]\nkey = "abc\\')
    expect(document.skipped).toHaveLength(1)
  })

  it('rejects a basic string that spans a line break', () => {
    const document = scanTomlSections('[s]\nkey = "abc\ndef = 1"')
    expect(document.skipped).toHaveLength(1)
    expect(document.sections[0]?.values.has('key')).toBe(false)
  })

  it('rejects a literal string that spans a line break', () => {
    const document = scanTomlSections("[s]\nkey = 'abc\ndef = 1'")
    expect(document.skipped).toHaveLength(1)
  })

  it('rejects a literal string with no closing quote', () => {
    expect(scanTomlSections("[s]\nkey = 'abc").skipped).toHaveLength(1)
  })

  it('reads a multi-line basic string, trimming its first line break and joining an escaped one', () => {
    const text = '[s]\nkey = """\nfirst \\\n   second\nthird"""'
    expect(valuesOf(text).get('key')).toBe('first second\nthird')
  })

  it('expands a unicode escape inside a multi-line basic string', () => {
    expect(valuesOf('[s]\nkey = """a\\u0041b"""').get('key')).toBe('aAb')
  })

  it('rejects a multi-line basic string that never closes', () => {
    expect(scanTomlSections('[s]\nkey = """abc').skipped).toHaveLength(1)
  })

  it('joins an escaped line break written with CRLF', () => {
    expect(valuesOf('[s]\nkey = """a\\\r\n   b"""').get('key')).toBe('ab')
  })

  it('rejects an escaped line break cut off by end of file', () => {
    expect(scanTomlSections('[s]\nkey = """a\\\n').skipped).toHaveLength(1)
  })

  it('reads a multi-line literal string with CRLF, preserving inner content', () => {
    expect(valuesOf('[s]\r\nkey = """\r\nline1\r\nline2"""').get('key')).toBe('line1\r\nline2')
  })

  it('reads a multi-line literal string and trims its first line break', () => {
    expect(valuesOf("[s]\nkey = '''\nraw \\n text'''").get('key')).toBe('raw \\n text')
  })

  it('rejects a multi-line literal string that never closes', () => {
    expect(scanTomlSections("[s]\nkey = '''abc").skipped).toHaveLength(1)
  })
})

describe('scanTomlSections — arrays, inline tables, and scalars', () => {
  it('reads a multi-line array with a trailing comma and mixed element kinds', () => {
    expect(valuesOf('[s]\nkey = [\n  "a",\n  2,\n  true,\n]').get('key')).toEqual(['a', 2, true])
  })

  it('reads an empty array', () => {
    expect(valuesOf('[s]\nkey = []').get('key')).toEqual([])
  })

  it('reads nested arrays', () => {
    expect(valuesOf('[s]\nkey = [[1, 2], ["a"]]').get('key')).toEqual([[1, 2], ['a']])
  })

  it('rejects an array whose separator is missing', () => {
    expect(scanTomlSections('[s]\nkey = ["a" "b"]').skipped).toHaveLength(1)
  })

  it('rejects an array that never closes', () => {
    expect(scanTomlSections('[s]\nkey = ["a"').skipped).toHaveLength(1)
  })

  it('reads an inline table with dotted and quoted keys', () => {
    const text = '[s]\nkey = { a = 1, "b-c" = "d", nested.e = true }'
    expect(valuesOf(text).get('key')).toEqual({ a: 1, 'b-c': 'd', nested: { e: true } })
  })

  it('reads an empty inline table', () => {
    expect(valuesOf('[s]\nkey = {}').get('key')).toEqual({})
  })

  it('rejects an inline table whose entry has no value assignment', () => {
    expect(scanTomlSections('[s]\nkey = { a 1 }').skipped).toHaveLength(1)
  })

  it('rejects an inline table whose key conflicts with a scalar', () => {
    expect(scanTomlSections('[s]\nkey = { a = 1, a.b = 2 }').skipped).toHaveLength(1)
  })

  it('rejects an inline table whose key conflicts with an array', () => {
    expect(scanTomlSections('[s]\nkey = { a = [1], a.b = 2 }').skipped).toHaveLength(1)
  })

  it('extends an inline table key that is already a table', () => {
    expect(valuesOf('[s]\nkey = { a.b = 1, a.c = 2 }').get('key')).toEqual({ a: { b: 1, c: 2 } })
  })

  it('rejects an inline table entry with no key', () => {
    expect(scanTomlSections('[s]\nkey = { . = 1 }').skipped).toHaveLength(1)
  })

  it('rejects an inline table with a missing separator', () => {
    expect(scanTomlSections('[s]\nkey = { a = 1 b = 2 }').skipped).toHaveLength(1)
  })

  it('reads booleans, integers, floats, and exponents', () => {
    const values = valuesOf('[s]\nkey = [true, false, 42, -7, 1_000, 3.5, 1e3, 0x1F, 0o17, 0b1010]')
    expect(values.get('key')).toEqual([true, false, 42, -7, 1000, 3.5, 1000, 31, 15, 10])
  })

  it('keeps an unrecognized bare token as its own text', () => {
    expect(valuesOf('[s]\nkey = 2026-08-31T10:00:00Z').get('key')).toBe('2026-08-31T10:00:00Z')
  })

  it('rejects a value that is missing entirely', () => {
    const document = scanTomlSections('[s]\nkey =\nother = 1')
    expect(document.skipped).toEqual(['key ='])
    expect(document.sections[0]?.values.get('other')).toBe(1)
  })

  it('rejects a value that starts with a character no value can start with', () => {
    expect(scanTomlSections('[s]\nkey = ]').skipped).toHaveLength(1)
  })
})

describe('scanTomlSections — unreadable statements', () => {
  it('records a statement with no assignment and keeps scanning', () => {
    const document = scanTomlSections('[s]\nnot an assignment\nkey = "value"')
    expect(document.skipped).toEqual(['not an assignment'])
    expect(document.sections[0]?.values.get('key')).toBe('value')
  })

  it('records an unterminated header', () => {
    const document = scanTomlSections('[unterminated\nkey = 1')
    expect(document.skipped).toEqual(['[unterminated'])
  })

  it('records an unterminated array-of-tables header', () => {
    expect(scanTomlSections('[[unterminated]\nkey = 1').skipped).toEqual(['[[unterminated]'])
  })

  it('records a header with no key', () => {
    expect(scanTomlSections('[ ]\n').skipped).toHaveLength(1)
  })

  it('records a key that cannot be written', () => {
    expect(scanTomlSections('[s]\n= 1').skipped).toHaveLength(1)
  })

  it('records an empty quoted key', () => {
    expect(scanTomlSections('[s]\n"" = 1').skipped).toEqual(['"" = 1'])
  })

  it('never throws on hostile input', () => {
    const hostile = ['[', ']', '=', '.', '""', "''", '[[[', 'a..b = 1', '{', '}', '[a]\nb = [', '"""']
    for (const text of hostile) expect(() => scanTomlSections(text)).not.toThrow()
  })
})
