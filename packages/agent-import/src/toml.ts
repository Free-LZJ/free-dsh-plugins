/**
 * Table-section scanner for the TOML documents other agent tools write.
 *
 * A general TOML reader rejects the whole document at the first construct it
 * does not know, and one unfamiliar value in an unrelated table would then hide
 * every MCP server this package imports. This scanner reads the constructs those
 * files use — table headers, array-of-table headers, bare, dotted, and quoted
 * keys, basic (`"…"`), literal (`'…'`), and multi-line strings, arrays, inline
 * tables, booleans, and numbers — never throws on document content, and records
 * each statement it could not read in `TomlDocument.skipped` while continuing.
 *
 * An unquoted token with no recognized literal form (a TOML date-time, for
 * example) keeps its own text. Keys written before any header land in a section
 * whose `path` is empty.
 *
 * @module @deepseek-ai/dsh-agent-import/toml
 */

/** One parsed TOML value: the subset this scanner produces. */
export type TomlValue = string | number | boolean | TomlValue[] | TomlTable

/** One TOML table: keys mapped to their parsed values. */
export interface TomlTable {
  [key: string]: TomlValue
}

/** One `[table]` header and the key/value pairs that follow it. */
export interface TomlSection {
  /** Header path split on `.`; empty for keys written before any header. */
  readonly path: readonly string[]
  /** Key/value pairs in document order; a later duplicate key replaces the earlier one. */
  readonly values: Map<string, TomlValue>
}

/** One scanned document: its sections plus every statement the scanner could not read. */
export interface TomlDocument {
  /** Table sections in document order; a header with no keys still appears. */
  readonly sections: readonly TomlSection[]
  /** Trimmed text of each unreadable statement, in document order. */
  readonly skipped: readonly string[]
}

/** Signals unreadable input at the current position; `scan` catches it per statement. */
class TomlScanError extends Error {}

const BASIC_ESCAPES: Readonly<Record<string, string>> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '"': '"',
  '\\': '\\',
}

const BARE_KEY = /^[A-Za-z0-9_-]+/
const NUMBER = /^[+-]?(?:0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|(?:\d[\d_]*)(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)$/
const BARE_VALUE_END = new Set([' ', '\t', '\r', '\n', ',', ']', '}', '#'])
const WHITESPACE = new Set([' ', '\t', '\r', '\n'])

/** Scans one document in a single forward pass. */
class Scanner {
  #index = 0
  #section: TomlSection = { path: [], values: new Map() }
  readonly #sections: TomlSection[] = []
  readonly #skipped: string[] = []

  constructor(private readonly text: string) {}

  /** Read the whole document, skipping statements it cannot read. */
  scan(): TomlDocument {
    for (;;) {
      this.#skipTrivia()
      if (this.#index >= this.text.length) break
      const start = this.#index
      try {
        if (this.text[this.#index] === '[') this.#readHeader()
        else this.#readPair()
      } catch (error: unknown) {
        /* v8 ignore next -- every reader throws TomlScanError; a defect escaping as some other
           error must not be recorded as an unreadable statement. */
        if (!(error instanceof TomlScanError)) throw error
        this.#recordStatement(start)
      }
    }
    this.#closeSection()
    return { sections: this.#sections, skipped: this.#skipped }
  }

  /** Record a statement the scanner abandoned, then resume on the next line. */
  #recordStatement(start: number): void {
    const end = this.text.indexOf('\n', start)
    const line = this.text.slice(start, end === -1 ? this.text.length : end).trim()
    if (line.length > 0) this.#skipped.push(line)
    this.#index = end === -1 ? this.text.length : end + 1
  }

  /** Publish the current section unless it is the empty pre-header placeholder. */
  #closeSection(): void {
    if (this.#section.path.length > 0 || this.#section.values.size > 0) this.#sections.push(this.#section)
  }

  /** Skip whitespace, newlines, and comments. */
  #skipTrivia(): void {
    while (WHITESPACE.has(this.text[this.#index] ?? '')) this.#index += 1
    while (this.text[this.#index] === '#') {
      this.#skipLine()
      while (WHITESPACE.has(this.text[this.#index] ?? '')) this.#index += 1
    }
  }

  /** Advance past the rest of the current line. */
  #skipLine(): void {
    while (this.#index < this.text.length && this.text[this.#index] !== '\n') this.#index += 1
  }

  /** Read one `[table]` or `[[array-of-table]]` header and start its section. */
  #readHeader(): void {
    this.#index += 1
    const array = this.text[this.#index] === '['
    if (array) this.#index += 1
    const path = this.#readKeyPath()
    this.#skipInlineSpace()
    if (this.text[this.#index] !== ']') throw this.#error('unterminated table header')
    this.#index += 1
    if (array) {
      if (this.text[this.#index] !== ']') throw this.#error('unterminated array-of-tables header')
      this.#index += 1
    }
    this.#closeSection()
    this.#section = { path, values: new Map() }
    this.#skipLineTail()
  }

  /** Read one `key = value` pair. */
  #readPair(): void {
    const key = this.#readKeyPath().join('.')
    this.#skipInlineSpace()
    if (this.text[this.#index] !== '=') throw this.#error('expected "=" after key')
    this.#index += 1
    this.#skipInlineSpace()
    const value = this.#readValue()
    if (key.length === 0) throw this.#error('expected a key')
    this.#section.values.set(key, value)
    this.#skipLineTail()
  }

  /** Skip spaces and tabs without consuming a line break. */
  #skipInlineSpace(): void {
    while (this.text[this.#index] === ' ' || this.text[this.#index] === '\t') this.#index += 1
  }

  /** Consume trailing space, an optional comment, and the line break, recording anything else. */
  #skipLineTail(): void {
    this.#skipInlineSpace()
    if (this.text[this.#index] === '#') this.#skipLine()
    const char = this.text[this.#index]
    if (char === undefined) return
    if (char === '\n') {
      this.#index += 1
      return
    }
    // A statement ends at its line break, so whatever remains on this line is not TOML.
    this.#recordStatement(this.#index)
  }

  /** Read a dotted key path, honoring quoted keys. */
  #readKeyPath(): string[] {
    const parts: string[] = []
    for (;;) {
      this.#skipInlineSpace()
      parts.push(this.#readKey())
      this.#skipInlineSpace()
      if (this.text[this.#index] !== '.') return parts
      this.#index += 1
    }
  }

  /** Read one bare or quoted key. */
  #readKey(): string {
    const char = this.text[this.#index]
    if (char === '"') return this.#readBasicString()
    if (char === "'") return this.#readLiteralString()
    const match = BARE_KEY.exec(this.text.slice(this.#index))
    if (match === null) throw this.#error('expected a key')
    this.#index += match[0].length
    return match[0]
  }

  /** Read one value. */
  #readValue(): TomlValue {
    const char = this.text[this.#index]
    if (char === undefined) throw this.#error('expected a value')
    if (char === '"') return this.text.startsWith('"""', this.#index) ? this.#readMultilineBasicString() : this.#readBasicString()
    if (char === "'") return this.text.startsWith("'''", this.#index) ? this.#readMultilineLiteralString() : this.#readLiteralString()
    if (char === '[') return this.#readArray()
    if (char === '{') return this.#readInlineTable()
    return this.#readBareValue()
  }

  /** Read a `"…"` string, expanding escape sequences. */
  #readBasicString(): string {
    this.#index += 1
    let out = ''
    for (;;) {
      const char = this.text[this.#index]
      if (char === undefined || char === '\n') throw this.#error('unterminated string')
      this.#index += 1
      if (char === '"') return out
      out += char === '\\' ? this.#readEscape() : char
    }
  }

  /** Read a `'…'` string, which TOML never unescapes. */
  #readLiteralString(): string {
    this.#index += 1
    const end = this.text.indexOf("'", this.#index)
    if (end === -1 || this.text.slice(this.#index, end).includes('\n')) throw this.#error('unterminated literal string')
    const out = this.text.slice(this.#index, end)
    this.#index = end + 1
    return out
  }

  /** Read a `"""…"""` string: a leading line break is trimmed and a trailing `\` joins lines. */
  #readMultilineBasicString(): string {
    this.#index += 3
    this.#trimLeadingLineBreak()
    let out = ''
    for (;;) {
      if (this.text.startsWith('"""', this.#index)) {
        this.#index += 3
        return out
      }
      const char = this.text[this.#index]
      if (char === undefined) throw this.#error('unterminated multi-line string')
      this.#index += 1
      out += char === '\\' ? this.#readMultilineEscape() : char
    }
  }

  /** Read a `'''…'''` string: a leading line break is trimmed, nothing is unescaped. */
  #readMultilineLiteralString(): string {
    this.#index += 3
    this.#trimLeadingLineBreak()
    const end = this.text.indexOf("'''", this.#index)
    if (end === -1) throw this.#error('unterminated multi-line literal string')
    const out = this.text.slice(this.#index, end)
    this.#index = end + 3
    return out
  }

  /** Skip the line break that immediately follows a multi-line opening delimiter. */
  #trimLeadingLineBreak(): void {
    if (this.text[this.#index] === '\r') this.#index += 1
    if (this.text[this.#index] === '\n') this.#index += 1
  }

  /** Read the sequence after a `\` inside a single-line string. */
  #readEscape(): string {
    const char = this.text[this.#index]
    if (char === undefined) throw this.#error('unterminated escape sequence')
    const mapped = BASIC_ESCAPES[char]
    if (mapped !== undefined) {
      this.#index += 1
      return mapped
    }
    if (char === 'u' || char === 'U') return this.#readUnicodeEscape(char === 'u' ? 4 : 8)
    throw this.#error(`unsupported escape sequence \\${char}`)
  }

  /** Read the sequence after a `\` inside a multi-line string, including a line join. */
  #readMultilineEscape(): string {
    let lookahead = this.#index
    while (this.text[lookahead] === ' ' || this.text[lookahead] === '\t' || this.text[lookahead] === '\r') lookahead += 1
    if (this.text[lookahead] === '\n') {
      this.#index = lookahead + 1
      while (WHITESPACE.has(this.text[this.#index] ?? '')) this.#index += 1
      return ''
    }
    return this.#readEscape()
  }

  /** Read a `\uXXXX` or `\UXXXXXXXX` sequence. */
  #readUnicodeEscape(length: number): string {
    const digits = this.text.slice(this.#index + 1, this.#index + 1 + length)
    if (digits.length !== length || !/^[0-9A-Fa-f]+$/.test(digits)) throw this.#error('invalid unicode escape')
    const code = Number.parseInt(digits, 16)
    if (code > 0x10FFFF) throw this.#error('unicode escape is outside the Unicode range')
    this.#index += 1 + length
    return String.fromCodePoint(code)
  }

  /** Read an `[…]` array, ignoring line breaks and a trailing comma. */
  #readArray(): TomlValue[] {
    this.#index += 1
    const items: TomlValue[] = []
    for (;;) {
      this.#skipTrivia()
      if (this.text[this.#index] === ']') {
        this.#index += 1
        return items
      }
      items.push(this.#readValue())
      this.#skipTrivia()
      const char = this.text[this.#index]
      if (char === ',') {
        this.#index += 1
        continue
      }
      if (char === ']') {
        this.#index += 1
        return items
      }
      throw this.#error('expected "," or "]" in array')
    }
  }

  /** Read an `{ … }` inline table, honoring dotted keys. */
  #readInlineTable(): TomlTable {
    this.#index += 1
    const table: TomlTable = {}
    for (;;) {
      this.#skipInlineSpace()
      if (this.text[this.#index] === '}') {
        this.#index += 1
        return table
      }
      const path = this.#readKeyPath()
      this.#skipInlineSpace()
      if (this.text[this.#index] !== '=') throw this.#error('expected "=" in inline table')
      this.#index += 1
      this.#skipInlineSpace()
      const value = this.#readValue()
      const leaf = path.pop()
      /* v8 ignore next -- readKeyPath() always returns at least one part, so pop() is defined. */
      if (leaf === undefined) throw this.#error('inline table entry has no key')
      let target = table
      for (const part of path) {
        const existing = target[part]
        if (existing === undefined) {
          const created: TomlTable = {}
          target[part] = created
          target = created
          continue
        }
        if (typeof existing !== 'object' || Array.isArray(existing)) throw this.#error('inline table key conflicts with a value')
        target = existing
      }
      target[leaf] = value
      this.#skipInlineSpace()
      const char = this.text[this.#index]
      if (char === ',') {
        this.#index += 1
        continue
      }
      if (char === '}') {
        this.#index += 1
        return table
      }
      throw this.#error('expected "," or "}" in inline table')
    }
  }

  /** Read `true`, `false`, a number, or an unrecognized token as its own text. */
  #readBareValue(): TomlValue {
    let end = this.#index
    for (;;) {
      const char = this.text[end]
      if (char === undefined || BARE_VALUE_END.has(char)) break
      end += 1
    }
    if (end === this.#index) throw this.#error('expected a value')
    const raw = this.text.slice(this.#index, end)
    this.#index = end
    if (raw === 'true') return true
    if (raw === 'false') return false
    if (NUMBER.test(raw)) return Number(raw.replaceAll('_', ''))
    return raw
  }

  /** Build a scan error naming the failing offset. */
  #error(message: string): TomlScanError {
    return new TomlScanError(`${message} at offset ${String(this.#index)}`)
  }
}

/**
 * Scan one TOML document into its table sections.
 * @param text - TOML document text, decoded as UTF-8 by the caller.
 * @returns the document sections in order plus every statement the scanner could not read.
 */
export function scanTomlSections(text: string): TomlDocument {
  return new Scanner(text).scan()
}
