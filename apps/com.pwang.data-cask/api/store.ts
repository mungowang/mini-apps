import { labelOf, type DataRow, type Field, type SchemaRow } from "../shared/types.ts"

type Ctx = {
  storage: {
    query(sql: string, params?: unknown[] | Record<string, unknown>): Promise<Record<string, unknown>[]>
    run(sql: string, params?: unknown[] | Record<string, unknown>): Promise<unknown>
    transaction<T>(work: (tx: Ctx["storage"]) => Promise<T>): Promise<T>
  }
}

export function now() {
  return Date.now()
}

export function id(prefix: string) {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

function parseFields(raw: unknown): Field[] {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw
  return Array.isArray(value) ? value : []
}

function parseData(raw: unknown): Record<string, string> {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = item == null ? "" : String(item)
  return out
}

function parseTags(raw: unknown): string[] {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw
  return Array.isArray(value) ? value.map((item) => String(item)) : []
}

export function mapSchema(row: Record<string, unknown>): SchemaRow {
  return {
    id: String(row.id),
    name: String(row.name),
    fields: parseFields(row.fields),
    display: String(row.display ?? ""),
    sortOrder: Number(row.sort_order ?? row.created_at ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

export function mapRecord(row: Record<string, unknown>): DataRow {
  return {
    id: String(row.id),
    schemaId: String(row.schema_id),
    data: parseData(row.data),
    tags: parseTags(row.tags),
    openedAt: Number(row.opened_at ?? 0),
    sortOrder: Number(row.sort_order ?? row.created_at ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

export async function allSchemas(storage: Ctx["storage"]) {
  const rows = await storage.query("SELECT id, name, fields, display, sort_order, created_at, updated_at FROM schemas ORDER BY sort_order ASC, created_at ASC")
  return rows.map(mapSchema)
}

export async function allRecords(storage: Ctx["storage"]) {
  const rows = await storage.query("SELECT id, schema_id, data, tags, opened_at, sort_order, created_at, updated_at FROM records ORDER BY sort_order ASC, created_at ASC")
  return rows.map(mapRecord)
}

export async function nextSchemaSort(storage: Ctx["storage"]) {
  const rows = await storage.query("SELECT COALESCE(MAX(sort_order), 0) AS m FROM schemas")
  return Number(rows[0]?.m ?? 0) + 1
}

export async function nextRecordSort(storage: Ctx["storage"], schemaId: string) {
  const rows = await storage.query("SELECT COALESCE(MAX(sort_order), 0) AS m FROM records WHERE schema_id = ?", [schemaId])
  return Number(rows[0]?.m ?? 0) + 1
}

export function refsTo(records: DataRow[], schemas: SchemaRow[], id: string, labels?: Record<string, string>) {
  const schemaById = new Map(schemas.map((item) => [item.id, item]))
  const recordById = new Map(records.map((item) => [item.id, item]))
  const ctx = { schemas, recordById: (rid: string) => recordById.get(rid) }
  const lookup = (rid: string) => labels?.[rid]
  const hits: { recordId: string; schemaId: string; schemaName: string; field: string; name: string }[] = []
  for (const row of records) {
    const schema = schemaById.get(row.schemaId)
    if (!schema) continue
    for (const field of schema.fields) {
      if (field.type === "ref" && row.data[field.key] === id) {
        const name = labels?.[row.id] || labelOf(schema, row, lookup, new Set(), ctx) || row.id
        hits.push({ recordId: row.id, schemaId: schema.id, schemaName: schema.name, field: field.key, name })
      }
    }
  }
  return hits
}
