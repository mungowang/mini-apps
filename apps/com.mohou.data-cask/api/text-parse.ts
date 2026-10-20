import vm from "node:vm"
import type { Sheet } from "../shared/types.ts"
import {
  DEFAULT_TEXT_PARSE_LIMITS,
  type TextParseError,
  type TextParseLimits,
  type TextParseResult,
} from "../shared/parser-types.ts"

type FnMap = {
  preprocess?: (raw: string) => unknown
  parseLine?: (line: string) => unknown
}

function normalizeParserSource(source: string): string {
  // Allow ESM-looking "export function foo" in user/LLM scripts.
  return String(source || "")
    .replace(/\bexport\s+async\s+function\s+/g, "async function ")
    .replace(/\bexport\s+function\s+/g, "function ")
    .replace(/\bexport\s+const\s+/g, "const ")
    .replace(/\bexport\s+let\s+/g, "let ")
    .replace(/\bexport\s+var\s+/g, "var ")
    .replace(/\bexport\s+default\s+/g, "")
}

function compileModule(source: string, label: string): FnMap {
  const code = normalizeParserSource(source).trim()
  if (!code) return {}
  const wrapped =
    `"use strict";\n` +
    code +
    `\n` +
    `if (typeof module.exports !== "object" || module.exports === null) module.exports = {};\n` +
    `if (typeof preprocess === "function") module.exports.preprocess = preprocess;\n` +
    `if (typeof parseLine === "function") module.exports.parseLine = parseLine;\n` +
    `module.exports;\n`
  try {
    const script = new vm.Script(wrapped, { filename: label })
    const moduleObj = { exports: {} as Record<string, unknown> }
    const sandbox = {
      module: moduleObj,
      exports: moduleObj.exports,
      console: undefined,
      require: undefined,
      process: undefined,
      Buffer: undefined,
      setTimeout: undefined,
      setInterval: undefined,
      fetch: undefined,
    }
    // keep exports alias in sync for `exports.x =` style
    Object.defineProperty(sandbox, "exports", {
      get() { return moduleObj.exports },
      set(v) { moduleObj.exports = v as Record<string, unknown> },
    })
    const result = script.runInNewContext(sandbox, { timeout: 200 }) as Record<string, unknown>
    const exp = (result && typeof result === "object" ? result : moduleObj.exports) as Record<string, unknown>
    const out: FnMap = {}
    if (typeof exp.preprocess === "function") out.preprocess = exp.preprocess as FnMap["preprocess"]
    if (typeof exp.parseLine === "function") out.parseLine = exp.parseLine as FnMap["parseLine"]
    return out
  } catch (err) {
    throw Object.assign(new Error(label + " 编译失败：" + String(err instanceof Error ? err.message : err)), {
      phase: "compile" as const,
    })
  }
}

function defaultPreprocess(raw: string): string[] {
  return String(raw || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
}

function asStringCells(value: unknown, maxStringLen: number): string[] | null {
  if (value == null) return null
  if (!Array.isArray(value)) throw new Error("parseLine 必须返回数组")
  if (value.length === 0) return null
  return value.map((cell) => {
    const text = cell == null ? "" : String(cell)
    if (text.length > maxStringLen) throw new Error("单元格过长")
    return text
  })
}

function looksLikeHeader(row: string[]): boolean {
  if (!row.length) return false
  let score = 0
  for (const cell of row) {
    const t = cell.trim()
    if (!t) continue
    if (/^[a-zA-Z_][\\w.-]*$/.test(t)) score += 1
    if (/^col[_\\s-]?\\d+$/i.test(t)) score -= 1
    if (/^\\d+(\\.\\d+)?$/.test(t)) score -= 1
  }
  return score >= Math.max(1, Math.ceil(row.length * 0.6))
}

export function runTextParser(args: {
  raw: string
  preprocessSource?: string
  parseLineSource: string
  sheetName?: string
  firstRowIsHeader?: boolean | "auto"
  limits?: Partial<TextParseLimits>
}): TextParseResult {
  const limits = { ...DEFAULT_TEXT_PARSE_LIMITS, ...args.limits }
  const raw = String(args.raw ?? "")
  const errors: TextParseError[] = []

  if (raw.length > limits.maxStringLen * 40) {
    return {
      sheet: { name: args.sheetName || "文本", columns: [], rows: [] },
      stats: { rawChars: raw.length, linesIn: 0, rowsOut: 0, skipped: 0, width: 0 },
      errors: [{ phase: "limit", message: "原文过长" }],
      hardFail: true,
    }
  }

  let preprocess: (raw: string) => unknown = defaultPreprocess
  let parseLine: (line: string) => unknown

  try {
    if (args.preprocessSource?.trim()) {
      const pre = compileModule(args.preprocessSource, "preprocess.js")
      if (!pre.preprocess) throw Object.assign(new Error("preprocess 源码需 export function preprocess"), { phase: "compile" })
      preprocess = pre.preprocess
    }
    const lineMod = compileModule(args.parseLineSource, "parseLine.js")
    if (!lineMod.parseLine) throw Object.assign(new Error("parseLine 源码需 export function parseLine"), { phase: "compile" })
    parseLine = lineMod.parseLine
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err)
    return {
      sheet: { name: args.sheetName || "文本", columns: [], rows: [] },
      stats: { rawChars: raw.length, linesIn: 0, rowsOut: 0, skipped: 0, width: 0 },
      errors: [{ phase: "compile", message }],
      hardFail: true,
    }
  }

  let lines: string[] = []
  try {
    const started = Date.now()
    const preOut = preprocess(raw)
    if (Date.now() - started > limits.timeoutMs) throw new Error("preprocess 超时")
    if (!Array.isArray(preOut)) throw new Error("preprocess 必须返回 string[]")
    lines = preOut.map((line) => {
      const text = line == null ? "" : String(line)
      if (text.length > limits.maxStringLen) throw new Error("行过长")
      return text
    })
  } catch (err) {
    return {
      sheet: { name: args.sheetName || "文本", columns: [], rows: [] },
      stats: { rawChars: raw.length, linesIn: 0, rowsOut: 0, skipped: 0, width: 0 },
      errors: [{ phase: "preprocess", message: String(err instanceof Error ? err.message : err) }],
      hardFail: true,
    }
  }

  if (lines.length > limits.maxLines) {
    return {
      sheet: { name: args.sheetName || "文本", columns: [], rows: [] },
      stats: { rawChars: raw.length, linesIn: lines.length, rowsOut: 0, skipped: 0, width: 0 },
      errors: [{ phase: "limit", message: "行数超过上限 " + limits.maxLines }],
      hardFail: true,
    }
  }

  const matrix: string[][] = []
  let skipped = 0
  let cells = 0
  const startedAll = Date.now()

  for (let i = 0; i < lines.length; i++) {
    if (Date.now() - startedAll > limits.timeoutMs) {
      errors.push({ phase: "limit", message: "解析超时", lineNo: i + 1 })
      return {
        sheet: { name: args.sheetName || "文本", columns: [], rows: [] },
        stats: { rawChars: raw.length, linesIn: lines.length, rowsOut: 0, skipped, width: 0 },
        errors,
        hardFail: true,
      }
    }
    const line = lines[i]
    try {
      const started = Date.now()
      const out = parseLine(line)
      if (Date.now() - started > Math.min(50, limits.timeoutMs)) throw new Error("单行超时")
      const row = asStringCells(out, limits.maxStringLen)
      if (!row) {
        skipped += 1
        continue
      }
      cells += row.length
      if (cells > limits.maxCells) {
        errors.push({ phase: "limit", message: "单元格总数超过上限", lineNo: i + 1, line })
        return {
          sheet: { name: args.sheetName || "文本", columns: [], rows: [] },
          stats: { rawChars: raw.length, linesIn: lines.length, rowsOut: matrix.length, skipped, width: 0 },
          errors,
          hardFail: true,
        }
      }
      matrix.push(row)
    } catch (err) {
      skipped += 1
      if (errors.length < 30) {
        errors.push({
          phase: "parseLine",
          lineNo: i + 1,
          line: line.slice(0, 200),
          message: String(err instanceof Error ? err.message : err),
        })
      }
    }
  }

  if (!matrix.length) {
    return {
      sheet: { name: args.sheetName || "文本", columns: [], rows: [] },
      stats: { rawChars: raw.length, linesIn: lines.length, rowsOut: 0, skipped, width: 0 },
      errors: errors.length ? errors : [{ phase: "parseLine", message: "没有解析出任何行" }],
      hardFail: true,
    }
  }

  const width = matrix.reduce((max, row) => Math.max(max, row.length), 0)
  const normalized = matrix.map((row) => {
    if (row.length === width) return row
    const next = row.slice()
    while (next.length < width) next.push("")
    return next
  })

  const headerMode = args.firstRowIsHeader ?? "auto"
  let columns: string[]
  let rows: string[][]
  if (headerMode === true || (headerMode === "auto" && looksLikeHeader(normalized[0]))) {
    columns = normalized[0].map((cell, index) => {
      const name = cell.trim() || "col_" + (index + 1)
      return name
    })
    // dedupe
    const seen = new Map<string, number>()
    columns = columns.map((name) => {
      const n = (seen.get(name) ?? 0) + 1
      seen.set(name, n)
      return n === 1 ? name : name + "_" + n
    })
    rows = normalized.slice(1)
  } else {
    columns = Array.from({ length: width }, (_, i) => "col_" + (i + 1))
    rows = normalized
  }

  const sheet: Sheet = {
    name: args.sheetName || "文本",
    columns,
    rows: rows.slice(0, 2000),
  }

  return {
    sheet,
    stats: {
      rawChars: raw.length,
      linesIn: lines.length,
      rowsOut: sheet.rows.length,
      skipped,
      width,
    },
    errors,
    hardFail: false,
  }
}
