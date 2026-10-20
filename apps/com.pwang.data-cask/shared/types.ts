export type FieldType = "string" | "secret" | "url" | "text" | "date" | "datetime" | "time" | "ref"

export type Field = {
  key: string
  type: FieldType
  schema?: string
  label?: boolean
  search?: boolean
}

export type SchemaRow = {
  id: string
  name: string
  fields: Field[]
  display?: string
  /** Manual list order within the desk */
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export type DataRow = {
  id: string
  schemaId: string
  data: Record<string, string>
  tags: string[]
  openedAt: number
  /** Manual list order within its table */
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export type Sheet = {
  name: string
  columns: string[]
  rows: string[][]
}

export type ViewColumn = {
  key: string
  as: string
  show: boolean
  search: boolean
  /** Whether this shown column can be sorted on the home table */
  sort: boolean
  /** When search is on: offer distinct values as autocomplete suggestions */
  enum?: boolean
}

export type ViewSort = {
  key: string
  dir: "asc" | "desc"
}

export type ViewShortcut = {
  id: string
  name: string
  filters: Record<string, string>
  /** Multi-level sort stack; applied with filters */
  sorts: ViewSort[]
}

export type ViewDef = {
  id: string
  name: string
  description: string
  illustration: string
  schemaId: string
  columns: ViewColumn[]
  shortcuts: ViewShortcut[]
  /** Home view: show 新增 / 行内编辑 without leaving the table */
  allowWrite: boolean
  createdAt: number
  updatedAt: number
}

/** Portable pack for share / onboard — refs use schema names, not ids */
export type CaskPackField = {
  key: string
  type: FieldType
  /** Target schema name when type is ref */
  schemaName?: string
  label?: boolean
  search?: boolean
}

export type CaskPackSchema = {
  name: string
  fields: CaskPackField[]
  display?: string
}

export type CaskPackView = {
  name: string
  description: string
  illustration: string
  schemaName: string
  columns: ViewColumn[]
  /** Optional shortcuts; omit or [] to skip */
  shortcuts?: ViewShortcut[]
}

export type CaskPackSample = {
  schemaName: string
  /** Stable id inside the pack for remapping refs on import */
  packId: string
  data: Record<string, string>
  tags: string[]
}

export type CaskPack = {
  version: 1
  kind: "caskpack"
  name: string
  exportedAt: number
  schemas: CaskPackSchema[]
  views: CaskPackView[]
  samples: CaskPackSample[]
  /** Built-in module id; falls back to file stem when listing modules */
  moduleId?: string
  /** Card title in empty-state module list */
  title?: string
  description?: string
  /** Sort earlier / badge in module list — UI still iterates listModules() */
  recommended?: boolean
}

export type ModuleInfo = {
  id: string
  title: string
  description: string
  path: string
  fileName: string
  recommended: boolean
  hasSamples: boolean
  sampleCount: number
  schemaNames: string[]
  viewNames: string[]
  /** All pack schema names already exist locally */
  installed: boolean
}

export type ViewFieldOption = {
  path: string
  type: FieldType
  schema?: string
  note: string
  depth: number
}

export function flattenViewFields(schema: SchemaRow, schemas: SchemaRow[], prefix = "", depth = 0, maxDepth = 3, seen = new Set<string>()): ViewFieldOption[] {
  if (seen.has(schema.id)) return []
  const nextSeen = new Set(seen)
  nextSeen.add(schema.id)
  const out: ViewFieldOption[] = []
  for (const field of schema.fields) {
    const path = prefix ? prefix + "." + field.key : field.key
    const target = field.type === "ref" ? schemas.find((item) => item.id === field.schema) : undefined
    out.push({
      path,
      type: field.type,
      schema: field.schema,
      note: field.type === "ref" ? "引用 " + (target?.name ?? "") : field.type === "secret" ? "密钥，表里打码，可复制" : field.type,
      depth,
    })
    if (field.type === "ref" && target && depth < maxDepth) {
      out.push(...flattenViewFields(target, schemas, path, depth + 1, maxDepth, nextSeen))
    }
  }
  return out
}

export function resolveViewPath(row: DataRow, path: string, schemas: SchemaRow[], records: DataRow[], labels: Record<string, string>) {
  const parts = path.split(".").filter(Boolean)
  if (!parts.length) return { text: "", copy: "", type: "string" as FieldType, schema: undefined as string | undefined }
  let current: DataRow | undefined = row
  let currentSchema = schemas.find((item) => item.id === row.schemaId)
  for (let index = 0; index < parts.length; index++) {
    const key = parts[index]
    const field = currentSchema?.fields.find((item) => item.key === key)
    if (!field || !current) return { text: "", copy: "", type: "string" as FieldType, schema: undefined }
    const raw = current.data[key] ?? ""
    const last = index === parts.length - 1
    if (last) {
      if (field.type === "ref") return { text: labels[raw] || raw, copy: labels[raw] || raw, type: field.type, schema: field.schema }
      if (field.type === "secret") return { text: raw ? "••••••" : "", copy: raw, type: field.type, schema: field.schema }
      return { text: raw, copy: raw, type: field.type, schema: field.schema }
    }
    if (field.type !== "ref" || !raw) return { text: "", copy: "", type: field.type, schema: field.schema }
    current = records.find((item) => item.id === raw)
    currentSchema = schemas.find((item) => item.id === field.schema)
  }
  return { text: "", copy: "", type: "string" as FieldType, schema: undefined }
}

export type DeskQuery = { table: string; tag: string; cites: string; text: string }

export function parseQuery(raw: string): DeskQuery {
  const query: DeskQuery = { table: "", tag: "", cites: "", text: "" }
  const text: string[] = []
  const source = raw.trim()
  let index = 0
  while (index < source.length) {
    while (index < source.length && (source[index] === " " || source[index] === "&")) index++
    if (index >= source.length) break
    const start = index
    let key = ""
    while (index < source.length && source[index] !== " " && source[index] !== "&" && source[index] !== "=") key += source[index++]
    if (source[index] === "=" && (key === "table" || key === "tag" || key === "cites")) {
      index++
      let value = ""
      if (source[index] === '"') {
        index++
        while (index < source.length && source[index] !== '"') value += source[index++]
        if (source[index] === '"') index++
      } else {
        while (index < source.length && source[index] !== " " && source[index] !== "&") value += source[index++]
      }
      query[key] = value
    } else {
      while (index < source.length && source[index] !== " " && source[index] !== "&") index++
      text.push(source.slice(start, index))
    }
  }
  query.text = text.join(" ")
  return query
}

function quoteValue(value: string) {
  return /[\s"&]/.test(value) ? '"' + value.replaceAll('"', "") + '"' : value
}

export function formatQuery(query: DeskQuery) {
  const parts: string[] = []
  if (query.table) parts.push("table=" + quoteValue(query.table))
  if (query.tag) parts.push("tag=" + quoteValue(query.tag))
  if (query.cites) parts.push("cites=" + quoteValue(query.cites))
  if (query.text) parts.push(query.text)
  return parts.join(" ")
}

export type LabelCtx = {
  schemas?: SchemaRow[]
  /** Resolve a record by id — needed for `{ref.field}` display paths */
  recordById?: (id: string) => DataRow | undefined
}

/** Resolve a field path on a row: `name` or `service.env` (walk refs). */
export function resolveLabelPath(
  schema: SchemaRow | undefined,
  row: DataRow | undefined,
  path: string,
  lookup?: (id: string) => string | undefined,
  ctx?: LabelCtx,
  seen = new Set<string>(),
): string {
  if (!row || !schema) return ""
  const parts = path.split(".").map((part) => part.trim()).filter(Boolean)
  if (!parts.length) return ""
  let currentSchema: SchemaRow | undefined = schema
  let currentRow: DataRow | undefined = row
  for (let index = 0; index < parts.length; index++) {
    const key = parts[index]
    const field = currentSchema?.fields.find((item) => item.key === key)
    if (!field || !currentRow) return ""
    const raw = currentRow.data[key] ?? ""
    const last = index === parts.length - 1
    if (last) {
      if (!raw) return ""
      if (field.type === "ref") {
        if (lookup) {
          if (seen.has(raw)) return raw
          return lookup(raw) || raw
        }
        return raw
      }
      if (field.type === "secret") return "••••••"
      return raw
    }
    if (field.type !== "ref" || !raw) return ""
    if (seen.has(raw)) return ""
    currentRow = ctx?.recordById?.(raw)
    currentSchema = (ctx?.schemas ?? []).find((item) => item.id === field.schema)
  }
  return ""
}

export function labelOf(schema: SchemaRow | undefined, row: DataRow | undefined, lookup?: (id: string) => string | undefined, seen = new Set<string>(), ctx?: LabelCtx) {
  if (!row) return ""
  if (seen.has(row.id)) return row.id
  seen.add(row.id)
  const marked = schema?.fields.filter((item) => item.label) ?? []
  const fields = marked.length ? marked : schema?.fields.filter((item) => item.type === "string").slice(0, 1) ?? []
  const value = (field: Field) => resolveLabelPath(schema, row, field.key, lookup, ctx, seen)
  const template = schema?.display?.trim() || (marked.length > 1 ? marked.map((field) => "{" + field.key + "}").join("_") : "")
  if (template) {
    const text = template.replace(/\{([^{}]+)\}/g, (_, key: string) => resolveLabelPath(schema, row, String(key).trim(), lookup, ctx, seen))
    if (!text.replace(/[^\p{L}\p{N}]+/gu, "")) return "未命名"
    return text
  }
  const field = fields[0]
  if (!field) return row.id
  return value(field) || row.id
}
