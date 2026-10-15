import { Buffer } from "node:buffer"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { defineApp } from "@mohou/contract"
import { parseWorkbook } from "./api/parse-file.ts"
import { runTextParser } from "./api/text-parse.ts"
import { allRecords, allSchemas, id, mapRecord, mapSchema, nextRecordSort, nextSchemaSort, now, refsTo } from "./api/store.ts"
import { BUILTIN_TEXT_PARSERS, type TextParserDef } from "./shared/parser-types.ts"
import { flattenViewFields, labelOf, parseQuery, resolveViewPath, type CaskPack, type CaskPackField, type DataRow, type Field, type SchemaRow, type ViewColumn, type ViewDef, type ViewShortcut } from "./shared/types.ts"
import { resolveViewIllustration } from "./shared/view-illu.ts"

type Storage = {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>
  run(sql: string, params?: unknown[]): Promise<unknown>
  transaction<T>(work: (tx: Storage) => Promise<T>): Promise<T>
}

function pad2(n: number) {
  return String(n).padStart(2, "0")
}

function cleanFields(fields: Field[], schemas: SchemaRow[], selfId?: string) {
  const keys = new Set<string>()
  return fields.map((field) => {
    const key = String(field.key ?? "").trim()
    if (!key || key.includes(".")) throw new Error("字段名不能为空，也不能包含点")
    if (keys.has(key)) throw new Error("字段名重复：" + key)
    keys.add(key)
    const type = field.type
    if (!["string", "secret", "url", "text", "date", "datetime", "time", "ref"].includes(type)) throw new Error("不认识的类型")
    const next: Field = { key, type }
    if (type === "ref") {
      const target = String(field.schema ?? "")
      if (!schemas.some((item) => item.id === target && item.id !== selfId)) throw new Error("引用必须指向另一张已有的表")
      next.schema = target
    }
    if (field.label) next.label = true
    if (field.search && type !== "secret") next.search = true
    return next
  })
}

async function load(storage: Storage) {
  return { schemas: await allSchemas(storage), records: await allRecords(storage) }
}

function parseViewColumns(raw: unknown): ViewColumn[] {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw
  if (!Array.isArray(value)) return []
  return value.map((item) => ({
    key: String(item?.key ?? "").trim(),
    as: String(item?.as ?? "").trim(),
    show: !!item?.show,
    search: !!item?.search,
    sort: item?.sort === undefined ? !!item?.show : !!item?.sort,
  })).filter((item) => item.key)
}

function parseViewSorts(raw: unknown): { key: string; dir: "asc" | "desc" }[] {
  const value = typeof raw === "string" ? (() => { try { return JSON.parse(raw) } catch { return [] } })() : raw
  if (!Array.isArray(value)) return []
  const out: { key: string; dir: "asc" | "desc" }[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const key = String(item?.key ?? "").trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push({ key, dir: item?.dir === "desc" ? "desc" : "asc" })
  }
  return out
}

function parseViewShortcuts(raw: unknown): ViewShortcut[] {
  const value = typeof raw === "string" ? (() => { try { return JSON.parse(raw) } catch { return [] } })() : raw
  if (!Array.isArray(value)) return []
  const out: ViewShortcut[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const sid = String(item?.id ?? "").trim() || id("s")
    if (seen.has(sid)) continue
    seen.add(sid)
    const name = String(item?.name ?? "").trim()
    if (!name) continue
    const filters: Record<string, string> = {}
    const source = item?.filters && typeof item.filters === "object" ? item.filters as Record<string, unknown> : {}
    for (const [key, val] of Object.entries(source)) {
      const text = String(val ?? "").trim()
      if (text) filters[key] = text
    }
    out.push({ id: sid, name, filters, sorts: parseViewSorts(item?.sorts) })
  }
  return out
}

function mapTextParser(row: Record<string, unknown>): TextParserDef {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description ?? ""),
    preprocessSource: String(row.preprocess_source ?? ""),
    parseLineSource: String(row.parse_line_source ?? ""),
    sampleRaw: String(row.sample_raw ?? ""),
    builtIn: Number(row.built_in) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

async function ensureTextParsers(storage: Storage) {
  const count = await storage.query("SELECT COUNT(1) AS c FROM text_parsers")
  const n = Number(count[0]?.c ?? 0)
  if (n > 0) return
  const stamp = now()
  for (const item of BUILTIN_TEXT_PARSERS) {
    await storage.run(
      "INSERT INTO text_parsers (id, name, description, preprocess_source, parse_line_source, sample_raw, built_in, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
      [item.id, item.name, item.description, item.preprocessSource, item.parseLineSource, item.sampleRaw, stamp, stamp],
    )
  }
}

function mapView(row: Record<string, unknown>): ViewDef {
  const id = String(row.id)
  return {
    id,
    name: String(row.name),
    description: String(row.description ?? ""),
    illustration: resolveViewIllustration(String(row.illustration ?? ""), id),
    schemaId: String(row.schema_id),
    columns: parseViewColumns(row.columns),
    shortcuts: parseViewShortcuts(row.shortcuts),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function cleanViewColumns(columns: ViewColumn[], schema: SchemaRow, schemas: SchemaRow[]) {
  const allowed = new Map(flattenViewFields(schema, schemas).map((item) => [item.path, item]))
  const seen = new Set<string>()
  const next: ViewColumn[] = []
  for (const item of columns) {
    const key = String(item.key ?? "").trim()
    const field = allowed.get(key)
    if (!field || seen.has(key)) continue
    seen.add(key)
    const secret = field.type === "secret"
    next.push({
      key,
      as: String(item.as ?? "").trim(),
      show: !!item.show,
      search: secret ? false : !!item.search,
      sort: secret ? false : !!item.sort && !!item.show,
    })
  }
  if (!next.some((item) => item.show)) {
    const first = flattenViewFields(schema, schemas).find((item) => item.type !== "secret")
    if (first) next.push({ key: first.path, as: "", show: true, search: false, sort: true })
  }
  return next
}

function labelIndex(schemas: SchemaRow[], records: DataRow[]) {
  const byId = new Map(records.map((row) => [row.id, row]))
  const cache = new Map<string, string>()
  const ctx = { schemas, recordById: (id: string) => byId.get(id) }
  const visit = (id: string, seen: Set<string>): string => {
    const hit = cache.get(id)
    if (hit) return hit
    const row = byId.get(id)
    const schema = schemas.find((item) => item.id === row?.schemaId)
    if (!row || !schema) return ""
    const text = labelOf(schema, row, (ref) => visit(ref, seen), seen, ctx)
    cache.set(id, text)
    return text
  }
  return Object.fromEntries(records.map((row) => [row.id, visit(row.id, new Set())]))
}

export default defineApp({
  name: "数据手账",
  description: "本地的表和行。建表、查阅、从 CSV 或 Excel 导入。",
  api: {
    async overview(ctx) {
      const { schemas, records } = await load(ctx.storage)
      const tags: Record<string, number> = {}
      for (const row of records) for (const tag of row.tags) tags[tag] = (tags[tag] ?? 0) + 1
      const recent = records.filter((row) => row.openedAt > 0).sort((a, b) => b.openedAt - a.openedAt).slice(0, 5)
      const labels = labelIndex(schemas, records)
      const saved = await ctx.storage.query("SELECT id, name, q, created_at FROM saved_queries ORDER BY created_at DESC")
      const history = await ctx.storage.query("SELECT id, q, used_at FROM query_history ORDER BY used_at DESC LIMIT 20")
      const views = (await ctx.storage.query("SELECT id, name, description, illustration, schema_id, columns, shortcuts, created_at, updated_at FROM views ORDER BY created_at DESC")).map(mapView)
      return {
        schemas,
        counts: Object.fromEntries(schemas.map((schema) => [schema.id, records.filter((row) => row.schemaId === schema.id).length])),
        tags,
        recent,
        labels,
        saved: saved.map((row) => ({ id: String(row.id), name: String(row.name), q: String(row.q) })),
        history: history.map((row) => ({ id: String(row.id), q: String(row.q), usedAt: Number(row.used_at) })),
        views,
        totals: { schemas: schemas.length, records: records.length, tags: Object.keys(tags).length },
      }
    },

    async saveView(ctx, args?: { id?: string; name?: string; description?: string; illustration?: string; schemaId?: string; columns?: ViewColumn[] }) {
      const name = String(args?.name ?? "").trim()
      const description = String(args?.description ?? "").trim()
      const schemaId = String(args?.schemaId ?? "")
      if (!name) throw new Error("视图名不能为空")
      const schemas = await allSchemas(ctx.storage)
      const schema = schemas.find((item) => item.id === schemaId)
      if (!schema) throw new Error("找不到这张表")
      const columns = cleanViewColumns(args?.columns ?? [], schema, schemas)
      if (!columns.some((item) => item.show)) throw new Error("至少显示一列")
      const stamp = now()
      const existing = args?.id ? (await ctx.storage.query("SELECT id FROM views WHERE id = ?", [args.id]))[0] : undefined
      if (existing) {
        const illustration = resolveViewIllustration(String(args?.illustration ?? ""), String(existing.id))
        await ctx.storage.run("UPDATE views SET name = ?, description = ?, illustration = ?, schema_id = ?, columns = ?, updated_at = ? WHERE id = ?", [name, description, illustration, schemaId, JSON.stringify(columns), stamp, existing.id])
        return { id: String(existing.id) }
      }
      const viewId = id("v")
      const illustration = resolveViewIllustration(String(args?.illustration ?? ""), viewId)
      await ctx.storage.run("INSERT INTO views (id, name, description, illustration, schema_id, columns, shortcuts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [viewId, name, description, illustration, schemaId, JSON.stringify(columns), "[]", stamp, stamp])
      return { id: viewId }
    },

    async saveViewShortcut(ctx, args?: { viewId?: string; id?: string; name?: string; filters?: Record<string, string>; sorts?: { key?: string; dir?: string }[] }) {
      const viewId = String(args?.viewId ?? "")
      const name = String(args?.name ?? "").trim()
      if (!viewId) throw new Error("缺少视图")
      if (!name) throw new Error("快捷搜索名不能为空")
      const row = (await ctx.storage.query("SELECT id, shortcuts FROM views WHERE id = ?", [viewId]))[0]
      if (!row) throw new Error("找不到视图")
      const filters: Record<string, string> = {}
      for (const [key, val] of Object.entries(args?.filters ?? {})) {
        const text = String(val ?? "").trim()
        if (text) filters[key] = text
      }
      const sorts = parseViewSorts(args?.sorts)
      if (!Object.keys(filters).length && !sorts.length) throw new Error("当前没有可保存的筛选或排序")
      const list = parseViewShortcuts(row.shortcuts)
      const sid = String(args?.id ?? "").trim() || id("s")
      const entry = { id: sid, name, filters, sorts }
      const next = list.some((item) => item.id === sid)
        ? list.map((item) => item.id === sid ? entry : item)
        : [...list, entry]
      await ctx.storage.run("UPDATE views SET shortcuts = ?, updated_at = ? WHERE id = ?", [JSON.stringify(next), now(), viewId])
      return { id: sid, shortcuts: next }
    },

    async deleteViewShortcut(ctx, args?: { viewId?: string; id?: string }) {
      const viewId = String(args?.viewId ?? "")
      const sid = String(args?.id ?? "")
      if (!viewId || !sid) throw new Error("缺少参数")
      const row = (await ctx.storage.query("SELECT id, shortcuts FROM views WHERE id = ?", [viewId]))[0]
      if (!row) throw new Error("找不到视图")
      const next = parseViewShortcuts(row.shortcuts).filter((item) => item.id !== sid)
      await ctx.storage.run("UPDATE views SET shortcuts = ?, updated_at = ? WHERE id = ?", [JSON.stringify(next), now(), viewId])
      return { ok: true, shortcuts: next }
    },

    async deleteView(ctx, args?: { id?: string }) {
      const viewId = String(args?.id ?? "")
      await ctx.storage.run("DELETE FROM views WHERE id = ?", [viewId])
      return { ok: true }
    },

    async viewRows(ctx, args?: { viewId?: string; filters?: Record<string, string> }) {
      const viewId = String(args?.viewId ?? "")
      const row = (await ctx.storage.query("SELECT id, name, description, illustration, schema_id, columns, shortcuts, created_at, updated_at FROM views WHERE id = ?", [viewId]))[0]
      if (!row) throw new Error("找不到这个视图")
      const view = mapView(row)
      const { schemas, records } = await load(ctx.storage)
      const schema = schemas.find((item) => item.id === view.schemaId)
      if (!schema) throw new Error("视图指向的表不存在了")
      const labels = labelIndex(schemas, records)
      const filters = args?.filters ?? {}
      const available = flattenViewFields(schema, schemas)
      const byPath = new Map(available.map((item) => [item.path, item]))
      const shown = view.columns.filter((item) => item.show)
      const searchable = view.columns.filter((item) => item.search)
      const matched = records.filter((item) => {
        if (item.schemaId !== view.schemaId) return false
        return searchable.every((col) => {
          const needle = String(filters[col.key] ?? "").trim().toLowerCase()
          if (!needle) return true
          const resolved = resolveViewPath(item, col.key, schemas, records, labels)
          const hay = resolved.text || resolved.copy
          if (resolved.type === "ref") return hay.toLowerCase() === needle || hay.toLowerCase().includes(needle)
          return hay.toLowerCase().includes(needle)
        })
      })
      return {
        view,
        schema,
        headers: shown.map((item) => ({ key: item.key, label: item.as || item.key })),
        filters: searchable.map((item) => {
          const field = byPath.get(item.key)
          return { key: item.key, label: item.as || item.key, type: field?.type ?? "string", schema: field?.schema }
        }),
        rows: matched.map((item) => ({
          id: item.id,
          cells: shown.map((col) => resolveViewPath(item, col.key, schemas, records, labels)),
        })),
      }
    },

    async saveQuery(ctx, args?: { name?: string; q?: string }) {
      const name = String(args?.name ?? "").trim()
      const q = String(args?.q ?? "").trim()
      if (!name || !q) throw new Error("名称和查询都不能为空")
      const existing = await ctx.storage.query("SELECT id FROM saved_queries WHERE q = ?", [q])
      const stamp = now()
      if (existing[0]) {
        await ctx.storage.run("UPDATE saved_queries SET name = ? WHERE id = ?", [name, existing[0].id])
        return { id: String(existing[0].id) }
      }
      const queryId = id("q")
      await ctx.storage.run("INSERT INTO saved_queries (id, name, q, created_at) VALUES (?, ?, ?, ?)", [queryId, name, q, stamp])
      return { id: queryId }
    },

    async rememberQuery(ctx, args?: { q?: string }) {
      const q = String(args?.q ?? "").trim()
      if (!q) return { ok: true }
      const stamp = now()
      const existing = await ctx.storage.query("SELECT id FROM query_history WHERE q = ?", [q])
      if (existing[0]) {
        await ctx.storage.run("UPDATE query_history SET used_at = ? WHERE id = ?", [stamp, existing[0].id])
        return { ok: true }
      }
      await ctx.storage.run("INSERT INTO query_history (id, q, used_at) VALUES (?, ?, ?)", [id("h"), q, stamp])
      return { ok: true }
    },

    async records(ctx, args?: { schemaId?: string; tag?: string; q?: string }) {
      const { schemas, records } = await load(ctx.storage)
      const parsed = parseQuery(String(args?.q ?? ""))
      const labels = labelIndex(schemas, records)
      const table = parsed.table ? schemas.find((item) => item.name === parsed.table) : undefined
      const rows = records.filter((row) => {
        if (parsed.table) {
          if (!table || row.schemaId !== table.id) return false
        } else if (args?.schemaId && args.schemaId !== "all" && row.schemaId !== args.schemaId) return false
        if (parsed.tag && !row.tags.some((item) => item.toLowerCase() === parsed.tag.toLowerCase())) return false
        if (args?.tag && args.tag !== "all" && !row.tags.includes(args.tag)) return false
        if (parsed.cites) {
          const schema = schemas.find((item) => item.id === row.schemaId)
          const needle = parsed.cites.toLowerCase()
          const cited = schema?.fields.some((field) => field.type === "ref" && (labels[row.data[field.key] ?? ""] ?? "").toLowerCase().includes(needle)) ?? false
          if (!cited) return false
        }
        if (!parsed.text) return true
        const schema = schemas.find((item) => item.id === row.schemaId)
        const marked = schema?.fields.filter((field) => field.search && field.type !== "secret") ?? []
        const text = marked.length ? marked.map((field) => field.type === "ref" ? labels[row.data[field.key] ?? ""] || row.data[field.key] || "" : row.data[field.key] ?? "").join(" ") : labels[row.id] ?? ""
        return parsed.text.toLowerCase().split(/\s+/).every((word) => text.toLowerCase().includes(word))
      }).sort((a, b) => (a.sortOrder - b.sortOrder) || (a.createdAt - b.createdAt))
      return { schemas, rows }
    },

    async reorderSchemas(ctx, args?: { ids?: string[] }) {
      const ids = (args?.ids ?? []).map(String).filter(Boolean)
      if (!ids.length) return { ok: true }
      await ctx.storage.transaction(async (tx) => {
        for (let i = 0; i < ids.length; i++) {
          await tx.run("UPDATE schemas SET sort_order = ? WHERE id = ?", [i + 1, ids[i]])
        }
      })
      return { ok: true }
    },

    async reorderRecords(ctx, args?: { schemaId?: string; ids?: string[] }) {
      const schemaId = String(args?.schemaId ?? "")
      const ids = (args?.ids ?? []).map(String).filter(Boolean)
      if (!schemaId || !ids.length) return { ok: true }
      await ctx.storage.transaction(async (tx) => {
        for (let i = 0; i < ids.length; i++) {
          await tx.run("UPDATE records SET sort_order = ? WHERE id = ? AND schema_id = ?", [i + 1, ids[i], schemaId])
        }
      })
      return { ok: true }
    },

    async openRecord(ctx, args?: { id?: string }) {
      const recordId = String(args?.id ?? "")
      const stamp = now()
      await ctx.storage.run("UPDATE records SET opened_at = ? WHERE id = ?", [stamp, recordId])
      const { schemas, records } = await load(ctx.storage)
      const row = records.find((item) => item.id === recordId)
      if (!row) throw new Error("找不到这行")
      const labels = labelIndex(schemas, records)
      return { row, hits: refsTo(records, schemas, recordId, (ref) => labels[ref]), schemas }
    },

    async saveSchema(ctx, args?: { id?: string; name?: string; fields?: Field[]; display?: string; renames?: { from: string; to: string }[] }) {
      const name = String(args?.name ?? "").trim()
      if (!name) throw new Error("表名不能为空")
      const schemas = await allSchemas(ctx.storage)
      const existing = args?.id ? schemas.find((item) => item.id === args.id) : undefined
      if (schemas.some((item) => item.name === name && item.id !== existing?.id)) throw new Error("已经有同名的表")
      const fields = cleanFields(args?.fields ?? [], schemas, existing?.id)
      if (!fields.length) throw new Error("至少留一列")
      if (!fields.some((field) => field.label)) fields[0].label = true
      // Keep display even with 0–1 label flags — nested paths like {service.name}:{serviceUrl.env.name} need it
      const display = String(args?.display ?? "").trim()
      const stamp = now()
      if (!existing) {
        const schemaId = id("s")
        const sortOrder = await nextSchemaSort(ctx.storage)
        await ctx.storage.run("INSERT INTO schemas (id, name, fields, display, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [schemaId, name, JSON.stringify(fields), display, sortOrder, stamp, stamp])
        return { id: schemaId }
      }
      await ctx.storage.transaction(async (tx) => {
        for (const rename of args?.renames ?? []) {
          if (!rename.from || rename.from === rename.to) continue
          const rows = await tx.query("SELECT id, data FROM records WHERE schema_id = ?", [existing.id])
          for (const row of rows) {
            const data = JSON.parse(String(row.data)) as Record<string, string>
            if (Object.prototype.hasOwnProperty.call(data, rename.from)) {
              data[rename.to] = data[rename.from]
              delete data[rename.from]
              await tx.run("UPDATE records SET data = ?, updated_at = ? WHERE id = ?", [JSON.stringify(data), stamp, row.id])
            }
          }
        }
        const keep = new Set(fields.map((field) => field.key))
        const rows = await tx.query("SELECT id, data FROM records WHERE schema_id = ?", [existing.id])
        for (const row of rows) {
          const data = JSON.parse(String(row.data)) as Record<string, string>
          let changed = false
          for (const key of Object.keys(data)) {
            if (!keep.has(key)) {
              delete data[key]
              changed = true
            }
          }
          if (changed) await tx.run("UPDATE records SET data = ?, updated_at = ? WHERE id = ?", [JSON.stringify(data), stamp, row.id])
        }
        await tx.run("UPDATE schemas SET name = ?, fields = ?, display = ?, updated_at = ? WHERE id = ?", [name, JSON.stringify(fields), display, stamp, existing.id])
      })
      return { id: existing.id }
    },

    async deleteSchema(ctx, args?: { id?: string }) {
      const schemaId = String(args?.id ?? "")
      const { schemas, records } = await load(ctx.storage)
      if (schemas.some((schema) => schema.fields.some((field) => field.type === "ref" && field.schema === schemaId))) {
        throw new Error("还有别的表引用它，不能删除")
      }
      if (records.some((row) => row.schemaId === schemaId && refsTo(records, schemas, row.id).length)) {
        throw new Error("里面还有被引用的行，先处理那些引用")
      }
      await ctx.storage.transaction(async (tx) => {
        await tx.run("DELETE FROM records WHERE schema_id = ?", [schemaId])
        await tx.run("DELETE FROM schemas WHERE id = ?", [schemaId])
      })
      return { ok: true }
    },

    async saveRecord(ctx, args?: { id?: string; schemaId?: string; data?: Record<string, string>; tags?: string[] }) {
      const schemaId = String(args?.schemaId ?? "")
      const schemas = await allSchemas(ctx.storage)
      const schema = schemas.find((item) => item.id === schemaId)
      if (!schema) throw new Error("找不到这张表")
      const records = await allRecords(ctx.storage)
      const data: Record<string, string> = {}
      for (const field of schema.fields) {
        const value = String(args?.data?.[field.key] ?? "")
        if (field.type === "ref" && value) {
          const target = records.find((item) => item.id === value)
          if (!target || target.schemaId !== field.schema) throw new Error(field.key + " 指向的行不存在")
        }
        data[field.key] = value
      }
      const tags = [...new Set((args?.tags ?? []).map((tag) => String(tag).trim()).filter(Boolean))]
      const stamp = now()
      if (!args?.id) {
        const recordId = id("r")
        const sortOrder = await nextRecordSort(ctx.storage, schemaId)
        await ctx.storage.run(
          "INSERT INTO records (id, schema_id, data, tags, opened_at, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [recordId, schemaId, JSON.stringify(data), JSON.stringify(tags), stamp, sortOrder, stamp, stamp],
        )
        return { id: recordId }
      }
      await ctx.storage.run("UPDATE records SET data = ?, tags = ?, updated_at = ? WHERE id = ?", [JSON.stringify(data), JSON.stringify(tags), stamp, args.id])
      return { id: args.id }
    },

    async previewDelete(ctx, args?: { id?: string }) {
      const { schemas, records } = await load(ctx.storage)
      return { hits: refsTo(records, schemas, String(args?.id ?? "")) }
    },

    async deleteRecord(ctx, args?: { id?: string; mode?: "clear" | "cascade" }) {
      const recordId = String(args?.id ?? "")
      const mode = args?.mode === "cascade" ? "cascade" : "clear"
      await ctx.storage.transaction(async (tx) => {
        const schemas = (await tx.query("SELECT id, name, fields, display, sort_order, created_at, updated_at FROM schemas")).map(mapSchema)
        const records = (await tx.query("SELECT id, schema_id, data, tags, opened_at, sort_order, created_at, updated_at FROM records")).map(mapRecord)
        const drop = new Set<string>()
        const visit = (current: string) => {
          if (drop.has(current)) return
          drop.add(current)
          if (mode !== "cascade") return
          for (const hit of refsTo(records, schemas, current)) visit(hit.recordId)
        }
        visit(recordId)
        if (mode === "clear") {
          for (const row of records) {
            if (drop.has(row.id)) continue
            const schema = schemas.find((item) => item.id === row.schemaId)
            let changed = false
            for (const field of schema?.fields ?? []) {
              if (field.type === "ref" && drop.has(row.data[field.key] ?? "")) {
                row.data[field.key] = ""
                changed = true
              }
            }
            if (changed) await tx.run("UPDATE records SET data = ?, updated_at = ? WHERE id = ?", [JSON.stringify(row.data), now(), row.id])
          }
        }
        for (const dropped of drop) await tx.run("DELETE FROM records WHERE id = ?", [dropped])
      })
      return { ok: true }
    },

    async parseImport(ctx, args?: { filename?: string; base64?: string }) {
      const filename = String(args?.filename ?? "import.csv")
      const raw = String(args?.base64 ?? "")
      const payload = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw
      const bytes = Uint8Array.from(Buffer.from(payload, "base64"))
      const sheets = await parseWorkbook(bytes, filename)
      if (!sheets.length) throw new Error("文件里没有表")
      return { sheets }
    },

    async listTextParsers(ctx) {
      await ensureTextParsers(ctx.storage)
      const rows = await ctx.storage.query(
        "SELECT id, name, description, preprocess_source, parse_line_source, sample_raw, built_in, created_at, updated_at FROM text_parsers ORDER BY built_in DESC, name ASC",
      )
      return { parsers: rows.map(mapTextParser) }
    },

    async saveTextParser(ctx, args?: {
      id?: string
      name?: string
      description?: string
      preprocessSource?: string
      parseLineSource?: string
      sampleRaw?: string
    }) {
      await ensureTextParsers(ctx.storage)
      const name = String(args?.name ?? "").trim()
      const parseLineSource = String(args?.parseLineSource ?? "")
      if (!name) throw new Error("解析器名称不能为空")
      if (!parseLineSource.trim()) throw new Error("parseLine 不能为空")
      // compile gate
      const dry = runTextParser({
        raw: String(args?.sampleRaw ?? "a,b\n1,2"),
        preprocessSource: args?.preprocessSource,
        parseLineSource,
        firstRowIsHeader: "auto",
      })
      if (dry.hardFail && dry.errors.some((e) => e.phase === "compile")) {
        throw new Error(dry.errors[0]?.message || "脚本编译失败")
      }
      const stamp = now()
      const existingId = String(args?.id ?? "")
      if (existingId) {
        const row = (await ctx.storage.query("SELECT id, built_in FROM text_parsers WHERE id = ?", [existingId]))[0]
        if (!row) throw new Error("找不到解析器")
        if (Number(row.built_in) === 1) throw new Error("内置解析器不能修改，请另存为副本")
        await ctx.storage.run(
          "UPDATE text_parsers SET name = ?, description = ?, preprocess_source = ?, parse_line_source = ?, sample_raw = ?, updated_at = ? WHERE id = ?",
          [name, String(args?.description ?? "").trim(), String(args?.preprocessSource ?? ""), parseLineSource, String(args?.sampleRaw ?? ""), stamp, existingId],
        )
        return { id: existingId }
      }
      const parserId = id("tp")
      await ctx.storage.run(
        "INSERT INTO text_parsers (id, name, description, preprocess_source, parse_line_source, sample_raw, built_in, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
        [parserId, name, String(args?.description ?? "").trim(), String(args?.preprocessSource ?? ""), parseLineSource, String(args?.sampleRaw ?? ""), stamp, stamp],
      )
      return { id: parserId }
    },

    async deleteTextParser(ctx, args?: { id?: string }) {
      await ensureTextParsers(ctx.storage)
      const parserId = String(args?.id ?? "")
      const row = (await ctx.storage.query("SELECT id, built_in FROM text_parsers WHERE id = ?", [parserId]))[0]
      if (!row) throw new Error("找不到解析器")
      if (Number(row.built_in) === 1) throw new Error("内置解析器不能删除")
      await ctx.storage.run("DELETE FROM text_parsers WHERE id = ?", [parserId])
      return { ok: true }
    },

    async runTextParser(ctx, args?: {
      raw?: string
      preprocessSource?: string
      parseLineSource?: string
      parserId?: string
      sheetName?: string
      firstRowIsHeader?: boolean | "auto"
    }) {
      await ensureTextParsers(ctx.storage)
      let preprocessSource = String(args?.preprocessSource ?? "")
      let parseLineSource = String(args?.parseLineSource ?? "")
      const parserId = String(args?.parserId ?? "")
      if (parserId) {
        const row = (await ctx.storage.query(
          "SELECT preprocess_source, parse_line_source, name FROM text_parsers WHERE id = ?",
          [parserId],
        ))[0]
        if (!row) throw new Error("找不到解析器")
        if (!parseLineSource.trim()) parseLineSource = String(row.parse_line_source ?? "")
        if (!preprocessSource.trim()) preprocessSource = String(row.preprocess_source ?? "")
        if (!args?.sheetName) args = { ...args, sheetName: String(row.name ?? "文本") }
      }
      if (!parseLineSource.trim()) throw new Error("parseLine 不能为空")
      return runTextParser({
        raw: String(args?.raw ?? ""),
        preprocessSource: preprocessSource || undefined,
        parseLineSource,
        sheetName: args?.sheetName,
        firstRowIsHeader: args?.firstRowIsHeader ?? "auto",
      })
    },

    async generateTextParser(ctx, args?: { raw?: string; hint?: string }) {
      const raw = String(args?.raw ?? "")
      if (!raw.trim()) throw new Error("先粘贴原文")
      const sample = raw.slice(0, 4000)
      const hint = String(args?.hint ?? "").trim()
      const schema = {
        type: "object",
        properties: {
          preprocessSource: { type: "string" },
          parseLineSource: { type: "string" },
          notes: { type: "string" },
        },
        required: ["parseLineSource"],
      }
      const prompt =
        "You write JavaScript parser functions for a local data importer.\n" +
        "Return JSON with preprocessSource (optional) and parseLineSource (required).\n" +
        "Each must be full source exporting functions:\n" +
        "  export function preprocess(raw) { ... return string[] }\n" +
        "  export function parseLine(line) { ... return string[] | null }\n" +
        "Rules: no require/import/fetch/fs/process; pure sync code; skip junk with null; stable column count.\n" +
        (hint ? "User hint: " + hint + "\n" : "") +
        "Sample text:\n```\n" + sample + "\n```"
      const rawJson = await ctx.llm(prompt, { schema })
      const parsed = JSON.parse(String(rawJson)) as { preprocessSource?: string; parseLineSource?: string; notes?: string }
      const parseLineSource = String(parsed.parseLineSource ?? "")
      const preprocessSource = String(parsed.preprocessSource ?? "")
      if (!parseLineSource.trim()) throw new Error("模型没有返回 parseLine")
      const result = runTextParser({
        raw,
        preprocessSource: preprocessSource || undefined,
        parseLineSource,
        sheetName: "文本",
        firstRowIsHeader: "auto",
      })
      return {
        preprocessSource,
        parseLineSource,
        notes: String(parsed.notes ?? ""),
        result,
      }
    },

    async commitImport(ctx, args?: { rows?: DataRow[] }) {
      const incoming = args?.rows ?? []
      if (!incoming.length) throw new Error("没有要写入的行")
      const schemas = await allSchemas(ctx.storage)
      const existing = await allRecords(ctx.storage)
      const known = new Set(existing.map((row) => row.id))
      for (const row of incoming) known.add(row.id)
      for (const row of incoming) {
        const schema = schemas.find((item) => item.id === row.schemaId)
        if (!schema) throw new Error("目标表不存在")
        for (const field of schema.fields) {
          if (field.type === "ref" && row.data[field.key] && !known.has(row.data[field.key])) {
            throw new Error(field.key + " 对不上已有的行")
          }
        }
      }
      const stamp = now()
      await ctx.storage.transaction(async (tx) => {
        const nextBySchema = new Map<string, number>()
        for (const row of incoming) {
          let next = nextBySchema.get(row.schemaId)
          if (next == null) {
            const m = await tx.query("SELECT COALESCE(MAX(sort_order), 0) AS m FROM records WHERE schema_id = ?", [row.schemaId])
            next = Number(m[0]?.m ?? 0) + 1
          }
          await tx.run(
            "INSERT INTO records (id, schema_id, data, tags, opened_at, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
            [row.id, row.schemaId, JSON.stringify(row.data), JSON.stringify(row.tags ?? []), next, stamp, stamp],
          )
          nextBySchema.set(row.schemaId, next + 1)
        }
      })
      return { count: incoming.length }
    },

    async exportCaskPack(ctx, args?: {
      name?: string
      schemaIds?: string[]
      viewIds?: string[]
      /** viewId -> shortcut ids to include; missing key = all shortcuts for that view */
      viewShortcutIds?: Record<string, string[]>
      /** tables that export real rows */
      realSchemaIds?: string[]
      /** tables that export auto-generated demo rows */
      sampleSchemaIds?: string[]
      includeSamples?: boolean
      maxSamplesPerSchema?: number
    }) {
      const schemas = await allSchemas(ctx.storage)
      const records = await allRecords(ctx.storage)
      const views = (await ctx.storage.query("SELECT id, name, description, illustration, schema_id, columns, shortcuts, created_at, updated_at FROM views ORDER BY created_at DESC")).map(mapView)
      const byId = Object.fromEntries(schemas.map((item) => [item.id, item]))

      // Resolve schema selection + ref dependencies (closure)
      const wanted = new Set<string>()
      const seedSchemas = Array.isArray(args?.schemaIds) && args.schemaIds.length
        ? args.schemaIds.map(String).filter((id) => byId[id])
        : schemas.map((item) => item.id)
      const seedViews = Array.isArray(args?.viewIds)
        ? views.filter((view) => args.viewIds!.map(String).includes(view.id))
        : []
      for (const view of seedViews) wanted.add(view.schemaId)
      const realSeeds = Array.isArray(args?.realSchemaIds)
        ? args.realSchemaIds.map(String).filter((id) => byId[id])
        : []
      const sampleSeeds = Array.isArray(args?.sampleSchemaIds)
        ? args.sampleSchemaIds.map(String).filter((id) => byId[id])
        : (args?.includeSamples === false || realSeeds.length || args?.sampleSchemaIds ? [] : [])
      for (const id of realSeeds) wanted.add(id)
      for (const id of sampleSeeds) wanted.add(id)
      for (const id of seedSchemas) wanted.add(id)

      const queue = [...wanted]
      while (queue.length) {
        const sid = queue.shift()!
        const schema = byId[sid]
        if (!schema) continue
        for (const field of schema.fields) {
          if (field.type === "ref" && field.schema && byId[field.schema] && !wanted.has(field.schema)) {
            wanted.add(field.schema)
            queue.push(field.schema)
          }
        }
      }

      // Stable export order: dependencies first (simple Kahn-ish by repeated peel)
      const remaining = new Set(wanted)
      const ordered: SchemaRow[] = []
      while (remaining.size) {
        let progressed = false
        for (const sid of [...remaining]) {
          const schema = byId[sid]
          const deps = (schema?.fields ?? []).filter((field) => field.type === "ref" && field.schema && remaining.has(field.schema))
          if (!deps.length) {
            ordered.push(schema)
            remaining.delete(sid)
            progressed = true
          }
        }
        if (!progressed) {
          // cycle fallback
          for (const sid of [...remaining]) {
            ordered.push(byId[sid])
            remaining.delete(sid)
          }
        }
      }

      const idToName = Object.fromEntries(ordered.map((item) => [item.id, item.name]))
      const packSchemas = ordered.map((schema) => ({
        name: schema.name,
        display: schema.display || undefined,
        fields: schema.fields.map((field) => {
          const next: CaskPackField = { key: field.key, type: field.type }
          if (field.type === "ref" && field.schema) next.schemaName = idToName[field.schema] || byId[field.schema]?.name || field.schema
          if (field.label) next.label = true
          if (field.search) next.search = true
          return next
        }),
      }))

      const selectedViewIds = Array.isArray(args?.viewIds) ? new Set(args.viewIds.map(String)) : null
      const shortcutPick = args?.viewShortcutIds && typeof args.viewShortcutIds === "object" ? args.viewShortcutIds : null
      const packViews = views
        .filter((view) => wanted.has(view.schemaId))
        .filter((view) => !selectedViewIds || selectedViewIds.has(view.id))
        .map((view) => {
          let shortcuts = view.shortcuts ?? []
          if (shortcutPick) {
            if (!Object.prototype.hasOwnProperty.call(shortcutPick, view.id)) shortcuts = []
            else {
              const allowed = new Set((shortcutPick[view.id] ?? []).map(String))
              shortcuts = shortcuts.filter((item) => allowed.has(item.id))
            }
          }
          return {
            name: view.name,
            description: view.description,
            illustration: view.illustration,
            schemaName: idToName[view.schemaId] || view.schemaId,
            columns: view.columns,
            shortcuts: shortcuts.map((item) => ({
              id: item.id,
              name: item.name,
              filters: { ...item.filters },
              sorts: (item.sorts ?? []).map((sort) => ({ ...sort })),
            })),
          }
        })

      const samples: CaskPack["samples"] = []
      const realSet = new Set(realSeeds)
      const sampleSet = new Set(sampleSeeds)
      const demoCap = Math.max(1, Math.min(20, Number(args?.maxSamplesPerSchema ?? 5) || 5))
      const exportedRecordIds = new Set<string>()
      const demo = (schema: SchemaRow, index: number) => {
        const data: Record<string, string> = {}
        for (const field of schema.fields) {
          if (field.type === "ref") data[field.key] = ""
          else if (field.type === "secret") data[field.key] = "demo-secret-" + (index + 1)
          else if (field.type === "url") data[field.key] = "https://example.com/" + schema.name.toLowerCase() + "/" + (index + 1)
          else if (field.type === "date") data[field.key] = "2026-01-" + String((index % 28) + 1).padStart(2, "0")
          else if (field.type === "datetime") data[field.key] = "2026-01-" + String((index % 28) + 1).padStart(2, "0") + "T10:00"
          else if (field.type === "time") data[field.key] = "10:" + String(index % 60).padStart(2, "0")
          else if (field.type === "text") data[field.key] = schema.name + " 示例说明 " + (index + 1)
          else data[field.key] = schema.name + "-" + (index + 1)
        }
        return data
      }
      // Pass 1: collect real rows with packId; keep ref ids only if target row will also be exported
      const pendingReal: { schema: SchemaRow; row: DataRow }[] = []
      for (const schema of ordered) {
        if (!realSet.has(schema.id)) continue
        for (const row of records.filter((item) => item.schemaId === schema.id)) {
          pendingReal.push({ schema, row })
          exportedRecordIds.add(row.id)
        }
      }
      for (const { schema, row } of pendingReal) {
        const data: Record<string, string> = { ...row.data }
        for (const field of schema.fields) {
          if (field.type !== "ref") continue
          const refId = data[field.key] ?? ""
          // keep as packId when target is in this pack; else blank
          if (!refId || !exportedRecordIds.has(refId)) data[field.key] = ""
        }
        samples.push({ schemaName: schema.name, packId: row.id, data, tags: row.tags ?? [] })
      }
      for (const schema of ordered) {
        if (!sampleSet.has(schema.id) || realSet.has(schema.id)) continue
        for (let i = 0; i < demoCap; i++) {
          const packId = "demo:" + schema.id + ":" + i
          samples.push({ schemaName: schema.name, packId, data: demo(schema, i), tags: ["sample"] })
        }
      }

      const pack: CaskPack = {
        version: 1,
        kind: "caskpack",
        name: String(args?.name ?? "").trim() || "数据手账包",
        exportedAt: now(),
        schemas: packSchemas,
        views: packViews,
        samples,
      }
      const json = JSON.stringify(pack, null, 2)
      const safeName = (pack.name || "数据手账包").replace(/[/\\?%*:|"<>]/g, "-").trim() || "数据手账包"
      const stamp = new Date()
      const stampLabel = stamp.getFullYear() + pad2(stamp.getMonth() + 1) + pad2(stamp.getDate()) + "-" + pad2(stamp.getHours()) + pad2(stamp.getMinutes()) + pad2(stamp.getSeconds())
      const fileName = safeName + "-" + stampLabel + ".caskpack.json"
      const exportDir = join(ctx.appDir, "exports")
      await mkdir(exportDir, { recursive: true })
      const filePath = join(exportDir, fileName)
      await writeFile(filePath, json, "utf8")
      return {
        pack,
        json,
        fileName,
        filePath,
        exportDir,
        meta: {
          schemaIds: ordered.map((item) => item.id),
          forcedSchemaIds: ordered.map((item) => item.id).filter((id) => !seedSchemas.includes(id) && !sampleSeeds.includes(id) && !realSeeds.includes(id) && !seedViews.some((view) => view.schemaId === id)),
          viewCount: packViews.length,
          sampleCount: samples.length,
        },
      }
    },

    async revealExportPath(ctx, args?: { path?: string; mode?: "file" | "folder" }) {
      const target = String(args?.path ?? "").trim()
      if (!target) throw new Error("缺少路径")
      const exportRoot = join(ctx.appDir, "exports")
      const kv = ctx.storage.kv()
      const backupDir = String((await kv.get("settings.backupDir")) ?? "").trim()
      const allowed = target.startsWith(exportRoot) || (backupDir && (target === backupDir || target.startsWith(backupDir.endsWith("/") ? backupDir : backupDir + "/")))
      if (!allowed) throw new Error("只能打开应用导出目录或已记住的备份目录内的路径")
      const mode = args?.mode === "folder" ? "folder" : "file"
      const quoted = "'" + target.replace(/'/g, "'\''") + "'"
      const command = mode === "folder"
        ? (target === backupDir || target === exportRoot ? "open " + quoted : "open -R " + quoted)
        : "open " + quoted
      const result = await ctx.bash(command)
      if (result.exitCode !== 0) throw new Error(result.stderr || "无法打开")
      return { ok: true, path: target, mode }
    },

    async getSettings(ctx) {
      const kv = ctx.storage.kv()
      const startupNav = String((await kv.get("settings.startupNav")) ?? "home")
      const backupDir = String((await kv.get("settings.backupDir")) ?? "")
      const lastBackupPath = String((await kv.get("settings.lastBackupPath")) ?? "")
      const lastBackupAt = Number((await kv.get("settings.lastBackupAt")) ?? 0) || 0
      const allowed = new Set(["home", "data", "views", "import", "settings"])
      return {
        startupNav: allowed.has(startupNav) ? startupNav : "home",
        backupDir,
        lastBackupPath,
        lastBackupAt,
      }
    },

    async saveSettings(ctx, args?: { startupNav?: string; backupDir?: string | null }) {
      const kv = ctx.storage.kv()
      if (args?.startupNav != null) {
        const nav = String(args.startupNav)
        const allowed = new Set(["home", "data", "views", "import", "settings"])
        if (!allowed.has(nav)) throw new Error("不支持的启动页")
        await kv.set("settings.startupNav", nav)
      }
      if (args && Object.prototype.hasOwnProperty.call(args, "backupDir")) {
        const dir = args.backupDir == null ? "" : String(args.backupDir).trim()
        if (dir) await kv.set("settings.backupDir", dir)
        else await kv.delete("settings.backupDir")
      }
      const startupNav = String((await kv.get("settings.startupNav")) ?? "home")
      const backupDir = String((await kv.get("settings.backupDir")) ?? "")
      return { startupNav, backupDir }
    },

    async pickBackupDirectory(ctx) {
      const result = await ctx.bash(`osascript -e 'try' -e 'POSIX path of (choose folder with prompt "选择备份目录")' -e 'on error' -e 'return ""' -e 'end try'`)
      const dir = String(result.stdout ?? "").trim()
      if (!dir) throw new Error("未选择目录")
      const kv = ctx.storage.kv()
      await kv.set("settings.backupDir", dir)
      return { dir }
    },

    async backupNow(ctx, args?: { name?: string }) {
      const kv = ctx.storage.kv()
      const backupDir = String((await kv.get("settings.backupDir")) ?? "").trim()
      if (!backupDir) throw new Error("请先选择备份目录")
      const schemas = await allSchemas(ctx.storage)
      const records = await allRecords(ctx.storage)
      const viewRows = (await ctx.storage.query("SELECT id, name, description, illustration, schema_id, columns, shortcuts, created_at, updated_at FROM views ORDER BY created_at DESC")).map(mapView)
      const idToName = Object.fromEntries(schemas.map((item) => [item.id, item.name]))
      const packName = String(args?.name ?? "").trim() || "数据手账备份"
      const packSchemas = schemas.map((schema) => ({
        name: schema.name,
        display: schema.display || undefined,
        fields: schema.fields.map((field) => {
          const next: CaskPackField = { key: field.key, type: field.type }
          if (field.type === "ref" && field.schema) next.schemaName = idToName[field.schema] || field.schema
          if (field.label) next.label = true
          if (field.search) next.search = true
          return next
        }),
      }))
      const packViews = viewRows.map((view) => ({
        name: view.name,
        description: view.description,
        illustration: view.illustration,
        schemaName: idToName[view.schemaId] || view.schemaId,
        columns: view.columns,
        shortcuts: (view.shortcuts ?? []).map((item) => ({
          id: item.id,
          name: item.name,
          filters: { ...item.filters },
          sorts: (item.sorts ?? []).map((sort) => ({ ...sort })),
        })),
      }))
      const allIds = new Set(records.map((row) => row.id))
      const samples: CaskPack["samples"] = []
      for (const schema of schemas) {
        for (const row of records.filter((item) => item.schemaId === schema.id)) {
          const data: Record<string, string> = { ...row.data }
          for (const field of schema.fields) {
            if (field.type !== "ref") continue
            const refId = data[field.key] ?? ""
            if (!refId || !allIds.has(refId)) data[field.key] = ""
          }
          samples.push({ schemaName: schema.name, packId: row.id, data, tags: row.tags ?? [] })
        }
      }
      const pack: CaskPack = {
        version: 1,
        kind: "caskpack",
        name: packName,
        exportedAt: now(),
        schemas: packSchemas,
        views: packViews,
        samples,
      }
      const json = JSON.stringify(pack, null, 2)
      const safeName = packName.replace(/[/\\?%*:|"<>]/g, "-").trim() || "数据手账备份"
      const stamp = new Date()
      const stampLabel = stamp.getFullYear() + pad2(stamp.getMonth() + 1) + pad2(stamp.getDate()) + "-" + pad2(stamp.getHours()) + pad2(stamp.getMinutes()) + pad2(stamp.getSeconds())
      const fileName = safeName + "-" + stampLabel + ".caskpack.json"
      const filePath = join(backupDir, fileName)
      await mkdir(backupDir, { recursive: true })
      await writeFile(filePath, json, "utf8")
      await kv.set("settings.lastBackupAt", now())
      await kv.set("settings.lastBackupPath", filePath)
      return { filePath, exportDir: backupDir, fileName, pack }
    },

    async resetAllData(ctx, args?: { confirm?: string }) {
      if (String(args?.confirm ?? "").trim() !== "清空全部数据") {
        throw new Error("确认文案不正确")
      }
      await ctx.storage.transaction(async (tx) => {
        await tx.run("DELETE FROM records")
        await tx.run("DELETE FROM views")
        await tx.run("DELETE FROM schemas")
        await tx.run("DELETE FROM saved_queries")
        await tx.run("DELETE FROM query_history")
        await tx.run("DELETE FROM text_parsers WHERE built_in = 0")
      })
      return { ok: true }
    },

    async importCaskPack(ctx, args?: { pack?: CaskPack; conflict?: "skip" | "rename" }) {
      const pack = args?.pack
      if (!pack || pack.kind !== "caskpack" || pack.version !== 1) throw new Error("不是有效的 caskpack")
      if (!Array.isArray(pack.schemas) || !pack.schemas.length) throw new Error("包里没有表定义")
      const conflict = args?.conflict === "rename" ? "rename" : "skip"
      const existing = await allSchemas(ctx.storage)
      const nameTaken = new Set(existing.map((item) => item.name))
      const createdSchemas: { name: string; id: string; skipped: boolean }[] = []
      const nameToId: Record<string, string> = Object.fromEntries(existing.map((item) => [item.name, item.id]))
      const stamp = now()

      // First pass: create tables (order as in pack; refs may point forward — resolve after all exist)
      const pendingFields: { schemaId: string; fields: CaskPackField[]; display?: string }[] = []
      for (const item of pack.schemas) {
        const baseName = String(item.name ?? "").trim()
        if (!baseName) continue
        let name = baseName
        if (nameTaken.has(name)) {
          if (conflict === "skip") {
            createdSchemas.push({ name: baseName, id: nameToId[name], skipped: true })
            continue
          }
          let n = 2
          while (nameTaken.has(name + " " + n)) n++
          name = name + " " + n
        }
        const schemaId = id("s")
        // temporary fields without refs; fix in second pass
        const bare = (item.fields ?? []).map((field) => {
          const f: Field = { key: String(field.key ?? "").trim(), type: field.type }
          if (!f.key) throw new Error("包内字段名无效")
          if (field.type === "ref") f.type = "string" // placeholder until refs resolve
          if (field.label) f.label = true
          if (field.search && f.type !== "secret") f.search = true
          return f
        }).filter((field) => field.key)
        if (!bare.length) throw new Error("表 " + baseName + " 没有字段")
        if (!bare.some((field) => field.label)) bare[0].label = true
        const sortOrder = await nextSchemaSort(ctx.storage)
        await ctx.storage.run(
          "INSERT INTO schemas (id, name, fields, display, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [schemaId, name, JSON.stringify(bare), "", sortOrder, stamp, stamp],
        )
        nameTaken.add(name)
        nameToId[baseName] = schemaId // original pack name maps to new id for views/samples
        nameToId[name] = schemaId
        createdSchemas.push({ name, id: schemaId, skipped: false })
        pendingFields.push({ schemaId, fields: item.fields ?? [], display: item.display })
      }

      // Second pass: apply real fields with ref → id
      for (const pending of pendingFields) {
        const fields: Field[] = []
        const keys = new Set<string>()
        for (const field of pending.fields) {
          const key = String(field.key ?? "").trim()
          if (!key || keys.has(key)) continue
          keys.add(key)
          const next: Field = { key, type: field.type }
          if (field.type === "ref") {
            const targetName = String(field.schemaName ?? "").trim()
            const targetId = nameToId[targetName]
            if (!targetId || targetId === pending.schemaId) {
              // drop broken ref → string so import still works
              next.type = "string"
            } else {
              next.schema = targetId
            }
          }
          if (field.label) next.label = true
          if (field.search && next.type !== "secret") next.search = true
          fields.push(next)
        }
        if (!fields.length) continue
        if (!fields.some((field) => field.label)) fields[0].label = true
        const display = fields.filter((field) => field.label).length > 1 ? String(pending.display ?? "").trim() : ""
        await ctx.storage.run("UPDATE schemas SET fields = ?, display = ?, updated_at = ? WHERE id = ?", [JSON.stringify(fields), display, stamp, pending.schemaId])
      }

      const createdViews: { name: string; id: string; skipped: boolean }[] = []
      for (const view of pack.views ?? []) {
        const viewName = String(view.name ?? "").trim()
        const schemaName = String(view.schemaName ?? "").trim()
        const schemaId = nameToId[schemaName]
        if (!viewName || !schemaId) continue
        const exists = (await ctx.storage.query("SELECT id FROM views WHERE name = ? AND schema_id = ?", [viewName, schemaId]))[0]
        if (exists) {
          if (conflict === "skip") {
            createdViews.push({ name: viewName, id: String(exists.id), skipped: true })
            continue
          }
        }
        let finalName = viewName
        if (exists && conflict === "rename") {
          let n = 2
          while ((await ctx.storage.query("SELECT id FROM views WHERE name = ? AND schema_id = ?", [viewName + " " + n, schemaId]))[0]) n++
          finalName = viewName + " " + n
        }
        const schemasNow = await allSchemas(ctx.storage)
        const schema = schemasNow.find((item) => item.id === schemaId)
        if (!schema) continue
        let columns: ViewColumn[] = []
        try {
          columns = cleanViewColumns(view.columns ?? [], schema, schemasNow)
        } catch {
          columns = schema.fields.filter((field) => field.type !== "secret").slice(0, 6).map((field) => ({
            key: field.key, as: "", show: true, search: true, sort: true,
          }))
        }
        if (!columns.some((item) => item.show)) continue
        const viewId = id("v")
        const illustration = resolveViewIllustration(String(view.illustration ?? ""), viewId)
        const shortcuts = parseViewShortcuts(view.shortcuts ?? []).map((item) => ({
          id: id("s"),
          name: item.name,
          filters: item.filters,
          sorts: item.sorts ?? [],
        }))
        await ctx.storage.run(
          "INSERT INTO views (id, name, description, illustration, schema_id, columns, shortcuts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [viewId, finalName, String(view.description ?? "").trim(), illustration, schemaId, JSON.stringify(columns), JSON.stringify(shortcuts), stamp, stamp],
        )
        createdViews.push({ name: finalName, id: viewId, skipped: false })
      }

      let sampleCount = 0
      const packIdToNewId: Record<string, string> = {}
      const pendingSamples: { newId: string; schemaId: string; data: Record<string, string>; tags: string[]; schema: SchemaRow }[] = []
      const schemasNow = await allSchemas(ctx.storage)
      const schemaById = Object.fromEntries(schemasNow.map((item) => [item.id, item]))
      // Pass 1: insert rows with blank refs, remember packId → newId
      for (const sample of pack.samples ?? []) {
        const schemaId = nameToId[String(sample.schemaName ?? "").trim()]
        if (!schemaId) continue
        const schema = schemaById[schemaId]
        if (!schema) continue
        const packId = String(sample.packId ?? "").trim() || id("pack")
        const newId = id("r")
        packIdToNewId[packId] = newId
        const raw = sample.data && typeof sample.data === "object" ? { ...sample.data } : {}
        const data: Record<string, string> = {}
        for (const field of schema.fields) {
          if (field.type === "ref") data[field.key] = ""
          else data[field.key] = String(raw[field.key] ?? "")
        }
        const tags = Array.isArray(sample.tags) ? sample.tags.map(String) : []
        const sortOrder = await nextRecordSort(ctx.storage, schemaId)
        await ctx.storage.run(
          "INSERT INTO records (id, schema_id, data, tags, opened_at, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
          [newId, schemaId, JSON.stringify(data), JSON.stringify(tags), sortOrder, stamp, stamp],
        )
        pendingSamples.push({ newId, schemaId, data: raw, tags, schema })
        sampleCount++
      }
      // Pass 2: remap refs from packId → new local ids
      for (const item of pendingSamples) {
        let changed = false
        const data: Record<string, string> = {}
        for (const field of item.schema.fields) {
          if (field.type === "ref") {
            const packRef = String(item.data[field.key] ?? "").trim()
            const mapped = packRef ? packIdToNewId[packRef] ?? "" : ""
            data[field.key] = mapped
            if (mapped) changed = true
          } else {
            data[field.key] = String(item.data[field.key] ?? "")
          }
        }
        if (changed) {
          await ctx.storage.run("UPDATE records SET data = ?, updated_at = ? WHERE id = ?", [JSON.stringify(data), stamp, item.newId])
        }
      }

      return {
        schemas: createdSchemas,
        views: createdViews,
        samples: sampleCount,
        created: {
          schemas: createdSchemas.filter((item) => !item.skipped).length,
          views: createdViews.filter((item) => !item.skipped).length,
          samples: sampleCount,
        },
        skipped: {
          schemas: createdSchemas.filter((item) => item.skipped).length,
          views: createdViews.filter((item) => item.skipped).length,
        },
      }
    },
  },
})
