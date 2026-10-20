import type { Sheet } from "./types.ts"

export type TextParserDef = {
  id: string
  name: string
  description: string
  preprocessSource: string
  parseLineSource: string
  sampleRaw: string
  builtIn: boolean
  createdAt: number
  updatedAt: number
}

export type TextParseError = {
  phase: "compile" | "preprocess" | "parseLine" | "limit"
  lineNo?: number
  line?: string
  message: string
}

export type TextParseStats = {
  rawChars: number
  linesIn: number
  rowsOut: number
  skipped: number
  width: number
}

export type TextParseResult = {
  sheet: Sheet
  stats: TextParseStats
  errors: TextParseError[]
  hardFail: boolean
}

export type TextParseLimits = {
  timeoutMs: number
  maxLines: number
  maxCells: number
  maxStringLen: number
}

export const DEFAULT_TEXT_PARSE_LIMITS: TextParseLimits = {
  timeoutMs: 800,
  maxLines: 20_000,
  maxCells: 200_000,
  maxStringLen: 50_000,
}

/** Built-in templates (seed). */
export const BUILTIN_TEXT_PARSERS: Omit<TextParserDef, "createdAt" | "updatedAt">[] = [
  {
    id: "builtin_kv_semicolon",
    name: "分号键值",
    description: "name=a;env=b;secret=c 一类行。# 开头跳过。",
    preprocessSource: `export function preprocess(raw) {
  return String(raw || "")
    .replace(/\\r\\n/g, "\\n")
    .split("\\n")
    .map((s) => s.trim())
    .filter(Boolean)
}`,
    parseLineSource: `export function parseLine(line) {
  if (!line || line.startsWith("#")) return null
  const map = Object.create(null)
  for (const part of line.split(";")) {
    const i = part.indexOf("=")
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k) map[k] = v
  }
  const keys = Object.keys(map)
  if (!keys.length) return null
  // stable order: name, env, secret, then others
  const preferred = ["name", "env", "secret", "key", "value"]
  const ordered = [
    ...preferred.filter((k) => k in map),
    ...keys.filter((k) => !preferred.includes(k)),
  ]
  return ordered.map((k) => String(map[k] ?? ""))
}`,
    sampleRaw: `name=alice;env=TMS:STG;secret=s3cr3t
name=bob;env=TMS:DEV;secret=****
# comment
name=carol;env=TMS:STG;secret=ok`,
    builtIn: true,
  },
  {
    id: "builtin_csv_line",
    name: "CSV 行",
    description: "逗号分隔，支持简单引号。",
    preprocessSource: `export function preprocess(raw) {
  return String(raw || "")
    .replace(/\\r\\n/g, "\\n")
    .split("\\n")
    .map((s) => s.trimEnd())
    .filter((s) => s.length > 0)
}`,
    parseLineSource: `export function parseLine(line) {
  const out = []
  let cur = ""
  let q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; continue }
      q = !q
      continue
    }
    if (ch === "," && !q) { out.push(cur); cur = ""; continue }
    cur += ch
  }
  out.push(cur)
  return out
}`,
    sampleRaw: `name,env,secret
alice,TMS:STG,s3cr3t
bob,TMS:DEV,****`,
    builtIn: true,
  },
  {
    id: "builtin_tsv_line",
    name: "TSV 行",
    description: "Tab 分隔。",
    preprocessSource: `export function preprocess(raw) {
  return String(raw || "")
    .replace(/\\r\\n/g, "\\n")
    .split("\\n")
    .map((s) => s.replace(/\\s+$/g, ""))
    .filter((s) => s.length > 0)
}`,
    parseLineSource: `export function parseLine(line) {
  return line.split("\\t")
}`,
    sampleRaw: `name\tenv\tsecret
alice\tTMS:STG\ts3cr3t
bob\tTMS:DEV\t****`,
    builtIn: true,
  },
  {
    id: "builtin_ndjson",
    name: "NDJSON",
    description: "每行一个 JSON 对象，按键名排序输出值。",
    preprocessSource: `export function preprocess(raw) {
  return String(raw || "")
    .replace(/\\r\\n/g, "\\n")
    .split("\\n")
    .map((s) => s.trim())
    .filter(Boolean)
}`,
    parseLineSource: `export function parseLine(line) {
  let obj
  try { obj = JSON.parse(line) } catch { return null }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null
  const keys = Object.keys(obj).sort()
  return keys.map((k) => {
    const v = obj[k]
    if (v == null) return ""
    if (typeof v === "string") return v
    return JSON.stringify(v)
  })
}`,
    sampleRaw: `{"name":"alice","env":"TMS:STG","secret":"s3cr3t"}
{"name":"bob","env":"TMS:DEV","secret":"****"}`,
    builtIn: true,
  },
]
