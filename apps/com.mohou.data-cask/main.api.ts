import { Buffer } from "node:buffer"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { defineApp } from "@mohou/contract"
import { parseWorkbook } from "./api/parse-file.ts"
import { runTextParser } from "./api/text-parse.ts"
import { allRecords, allSchemas, id, mapRecord, mapSchema, nextRecordSort, nextSchemaSort, now, refsTo } from "./api/store.ts"
import { BUILTIN_TEXT_PARSERS, type TextParserDef } from "./shared/parser-types.ts"
import { flattenViewFields, isTagsPath, labelOf, parseQuery, resolveViewPath, tagsPathLabel, type CaskPack, type CaskPackField, type DataRow, type Field, type ModuleInfo, type SchemaRow, type ViewColumn, type ViewDef, type ViewShortcut } from "./shared/types.ts"
import { resolveViewIllustration } from "./shared/view-illu.ts"
// Bundled fallback so empty-state modules work even if runtime modules/ is missing / unreadable
import qaAccountsBasicPack from "./modules/qa-accounts-basic.caskpack.json" with { type: "json" }
import webBookmarksBasicPack from "./modules/web-bookmarks-basic.caskpack.json" with { type: "json" }
import configFlagsBasicPack from "./modules/config-flags-basic.caskpack.json" with { type: "json" }

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
    enum: !!item?.search && !!item?.enum,
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

const VIEW_SELECT = "id, name, description, illustration, schema_id, columns, shortcuts, base_filters, allow_write, reveal_secrets_default, created_at, updated_at"

const BASE_OPS = new Set(["eq", "neq", "contains", "notContains", "hasTag", "lacksTag"])

function parseBaseFilters(raw: unknown): import("./shared/types.ts").ViewBaseFilter[] {
  let source: unknown = raw
  if (typeof raw === "string") {
    try { source = JSON.parse(raw) } catch { return [] }
  }
  // legacy: { "path": "value", "$tag": "x", "$tagExclude": "y" }
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const out: import("./shared/types.ts").ViewBaseFilter[] = []
    for (const [key, val] of Object.entries(source as Record<string, unknown>)) {
      const value = String(val ?? "").trim()
      const k = key.trim()
      if (!k || !value) continue
      if (k === "$tag") out.push({ key: "$tag", op: "hasTag", value })
      else if (k === "$tagExclude") out.push({ key: "$tag", op: "lacksTag", value })
      else out.push({ key: k, op: "contains", value })
    }
    return out
  }
  if (!Array.isArray(source)) return []
  const out: import("./shared/types.ts").ViewBaseFilter[] = []
  for (const item of source) {
    if (!item || typeof item !== "object") continue
    const row = item as Record<string, unknown>
    const key = String(row.key ?? "").trim()
    const value = String(row.value ?? "").trim()
    let op = String(row.op ?? "contains").trim()
    if (!BASE_OPS.has(op)) op = "contains"
    if (!key || !value) continue
    if (op === "hasTag" || op === "lacksTag") out.push({ key: "$tag", op: op as "hasTag" | "lacksTag", value })
    else out.push({ key, op: op as import("./shared/types.ts").ViewBaseFilterOp, value })
  }
  return out
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
    baseFilters: parseBaseFilters(row.base_filters),
    allowWrite: Number(row.allow_write ?? 0) === 1,
    revealSecretsDefault: Number(row.reveal_secrets_default ?? 0) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function splitFilterValues(raw: string) {
  return String(raw ?? "")
    .split(/\s*\|\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function matchBaseFilters(item: DataRow, base: import("./shared/types.ts").ViewBaseFilter[], schemas: SchemaRow[], records: DataRow[], labels: Record<string, string>) {
  for (const rule of base) {
    const needles = splitFilterValues(rule.value).map((part) => part.toLowerCase())
    if (!needles.length) continue
    if (rule.op === "hasTag") {
      // OR: row has any listed tag
      const tags = item.tags.map((tag) => tag.toLowerCase())
      if (!needles.some((needle) => tags.some((tag) => tag === needle))) return false
      continue
    }
    if (rule.op === "lacksTag") {
      // AND: row has none of the listed tags
      const tags = item.tags.map((tag) => tag.toLowerCase())
      if (needles.some((needle) => tags.some((tag) => tag === needle))) return false
      continue
    }
    const resolved = resolveViewPath(item, rule.key, schemas, records, labels)
    if (isTagsPath(rule.key)) {
      const tags = ((resolved as { tags?: string[] }).tags ?? splitFilterValues(String(resolved.text || "").replaceAll("·", "|")))
        .map((tag) => tag.toLowerCase())
      if (rule.op === "eq") {
        if (!needles.some((needle) => tags.some((tag) => tag === needle))) return false
      } else if (rule.op === "neq") {
        if (needles.some((needle) => tags.some((tag) => tag === needle))) return false
      } else if (rule.op === "notContains") {
        if (needles.some((needle) => tags.some((tag) => tag.includes(needle)))) return false
      } else {
        // contains — OR across needles
        if (!needles.some((needle) => tags.some((tag) => tag === needle || tag.includes(needle)))) return false
      }
      continue
    }
    const hay = (resolved.text || resolved.copy).toLowerCase()
    if (rule.op === "eq") {
      if (!needles.some((needle) => hay === needle)) return false
    } else if (rule.op === "neq") {
      if (needles.some((needle) => hay === needle)) return false
    } else if (rule.op === "notContains") {
      if (needles.some((needle) => hay.includes(needle))) return false
    } else {
      // contains (default) — OR
      if (!needles.some((needle) => hay.includes(needle))) return false
    }
  }
  return true
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
      enum: secret ? false : !!item.search && !!item.enum,
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

function modulesDir(appDir: string) {
  return join(appDir, "modules")
}

const BUILTIN_PREFIX = "builtin:"

function isCaskPack(value: unknown): value is CaskPack {
  if (!value || typeof value !== "object") return false
  const pack = value as CaskPack
  return pack.kind === "caskpack" && Number(pack.version) === 1 && Array.isArray(pack.schemas)
}

function builtinPacks(): CaskPack[] {
  const packs = [
    qaAccountsBasicPack as unknown as CaskPack,
    webBookmarksBasicPack as unknown as CaskPack,
    configFlagsBasicPack as unknown as CaskPack,
  ]
  return packs.filter((pack) => isCaskPack(pack) && pack.schemas.length > 0)
}

function moduleInfoFromPack(pack: CaskPack, fileName: string, path: string, existingNames: Set<string>): ModuleInfo {
  const stem = fileName.replace(/\.caskpack\.json$/i, "").replace(/\.json$/i, "")
  const id = String(pack.moduleId ?? "").trim() || stem
  const title = String(pack.title ?? pack.name ?? id).trim() || id
  const description = String(pack.description ?? "").trim()
  const samples = Array.isArray(pack.samples) ? pack.samples : []
  const schemaNames = (pack.schemas ?? []).map((item) => String(item.name ?? "").trim()).filter(Boolean)
  const viewNames = (pack.views ?? []).map((item) => String(item.name ?? "").trim()).filter(Boolean)
  const installed = schemaNames.length > 0 && schemaNames.every((name) => existingNames.has(name))
  return {
    id,
    title,
    description,
    path,
    fileName,
    recommended: !!pack.recommended,
    hasSamples: samples.length > 0,
    sampleCount: samples.length,
    schemaNames,
    viewNames,
    installed,
  }
}

async function readModulePackFile(filePath: string): Promise<CaskPack> {
  const raw = await readFile(filePath, "utf8")
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("模块包不是有效 JSON：" + basename(filePath))
  }
  if (!isCaskPack(parsed)) throw new Error("不是有效的 caskpack：" + basename(filePath))
  if (!parsed.schemas.length) throw new Error("包里没有表定义：" + basename(filePath))
  return parsed
}

async function resolveModulePack(appDir: string, mod: ModuleInfo): Promise<CaskPack> {
  if (mod.path.startsWith(BUILTIN_PREFIX)) {
    const id = mod.path.slice(BUILTIN_PREFIX.length) || mod.id
    const pack = builtinPacks().find((item) => String(item.moduleId ?? item.name ?? "").trim() === id || id === mod.id)
    if (!pack) throw new Error("找不到内置模块：" + id)
    return pack
  }
  const root = modulesDir(appDir)
  const allowed = join(root, mod.fileName)
  if (mod.path !== allowed && basename(mod.path) !== mod.fileName) {
    // still allow exact listed path under modules/
    if (!mod.path.startsWith(root)) throw new Error("只能安装应用 modules 目录或内置模块")
  }
  return readModulePackFile(mod.path.startsWith(root) ? mod.path : allowed)
}

async function listModulePacks(appDir: string, storage: Storage): Promise<{ modules: ModuleInfo[]; debug: Record<string, unknown> }> {
  const existing = await allSchemas(storage)
  const existingNames = new Set(existing.map((item) => item.name))
  const byId = new Map<string, ModuleInfo>()

  // 1) Bundled builtins — always available
  for (const pack of builtinPacks()) {
    const id = String(pack.moduleId ?? pack.name ?? "module").trim() || "module"
    const info = moduleInfoFromPack(pack, id + ".caskpack.json", BUILTIN_PREFIX + id, existingNames)
    byId.set(info.id, info)
  }

  // 2) Disk modules/ — add or override by id (drop-in extension)
  const dir = modulesDir(appDir)
  let diskError = ""
  let diskFiles: string[] = []
  try {
    diskFiles = await readdir(dir)
  } catch (err) {
    diskError = String(err instanceof Error ? err.message : err)
  }
  for (const fileName of diskFiles) {
    if (!fileName.endsWith(".caskpack.json") || fileName.startsWith(".")) continue
    const filePath = join(dir, fileName)
    try {
      const pack = await readModulePackFile(filePath)
      const info = moduleInfoFromPack(pack, fileName, filePath, existingNames)
      byId.set(info.id, info)
    } catch {
      // skip bad files
    }
  }

  const modules = [...byId.values()].sort((a, b) => {
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1
    return a.title.localeCompare(b.title, "zh-CN") || a.id.localeCompare(b.id)
  })
  return {
    modules,
    debug: {
      appDir,
      modulesDir: dir,
      diskError: diskError || undefined,
      diskFiles,
      builtinCount: builtinPacks().length,
      total: modules.length,
    },
  }
}

async function runImportCaskPack(storage: Storage, pack: CaskPack, conflict: "skip" | "rename") {
  if (!pack || pack.kind !== "caskpack" || pack.version !== 1) throw new Error("不是有效的 caskpack")
  if (!Array.isArray(pack.schemas) || !pack.schemas.length) throw new Error("包里没有表定义")
  const existing = await allSchemas(storage)
  const nameTaken = new Set(existing.map((item) => item.name))
  const createdSchemas: { name: string; id: string; skipped: boolean }[] = []
  const nameToId: Record<string, string> = Object.fromEntries(existing.map((item) => [item.name, item.id]))
  const stamp = now()

  const pendingFields: { schemaId: string; fields: CaskPackField[]; display?: string; mergeOnly?: boolean }[] = []
  for (const item of pack.schemas) {
    const baseName = String(item.name ?? "").trim()
    if (!baseName) continue
    let name = baseName
    if (nameTaken.has(name)) {
      if (conflict === "skip") {
        const existingId = nameToId[name]
        createdSchemas.push({ name: baseName, id: existingId, skipped: true })
        // Still merge missing fields / refresh display from pack onto the reused table
        pendingFields.push({ schemaId: existingId, fields: item.fields ?? [], display: item.display, mergeOnly: true })
        continue
      }
      let n = 2
      while (nameTaken.has(name + " " + n)) n++
      name = name + " " + n
    }
    const schemaId = id("s")
    const bare = (item.fields ?? []).map((field) => {
      const f: Field = { key: String(field.key ?? "").trim(), type: field.type }
      if (!f.key) throw new Error("包内字段名无效")
      if (field.type === "ref") f.type = "string"
      if (field.label) f.label = true
      if (field.search && f.type !== "secret") f.search = true
      return f
    }).filter((field) => field.key)
    if (!bare.length) throw new Error("表 " + baseName + " 没有字段")
    if (!bare.some((field) => field.label)) bare[0].label = true
    const sortOrder = await nextSchemaSort(storage)
    await storage.run(
      "INSERT INTO schemas (id, name, fields, display, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [schemaId, name, JSON.stringify(bare), "", sortOrder, stamp, stamp],
    )
    nameTaken.add(name)
    nameToId[baseName] = schemaId
    nameToId[name] = schemaId
    createdSchemas.push({ name, id: schemaId, skipped: false })
    pendingFields.push({ schemaId, fields: item.fields ?? [], display: item.display })
  }

  for (const pending of pendingFields) {
    const packFields: Field[] = []
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
          next.type = "string"
        } else {
          next.schema = targetId
        }
      }
      if (field.label) next.label = true
      if (field.search && next.type !== "secret") next.search = true
      packFields.push(next)
    }
    if (!packFields.length) continue
    let fields = packFields
    let display = String(pending.display ?? "").trim()
    if (pending.mergeOnly) {
      const live = (await allSchemas(storage)).find((item) => item.id === pending.schemaId)
      if (!live) continue
      const have = new Set(live.fields.map((item) => item.key))
      const merged = live.fields.slice()
      for (const field of packFields) {
        if (have.has(field.key)) continue
        merged.push(field)
        have.add(field.key)
      }
      fields = merged
      if (!fields.some((field) => field.label) && fields[0]) fields[0].label = true
      // Keep existing display if pack omits one; otherwise prefer pack display for nested templates
      display = display || String(live.display ?? "").trim()
    } else {
      if (!fields.some((field) => field.label)) fields[0].label = true
    }
    await storage.run("UPDATE schemas SET fields = ?, display = ?, updated_at = ? WHERE id = ?", [JSON.stringify(fields), display, stamp, pending.schemaId])
  }

  const createdViews: { name: string; id: string; skipped: boolean }[] = []
  for (const view of pack.views ?? []) {
    const viewName = String(view.name ?? "").trim()
    const schemaName = String(view.schemaName ?? "").trim()
    const schemaId = nameToId[schemaName]
    if (!viewName || !schemaId) continue
    const exists = (await storage.query("SELECT id FROM views WHERE name = ? AND schema_id = ?", [viewName, schemaId]))[0]
    if (exists) {
      if (conflict === "skip") {
        createdViews.push({ name: viewName, id: String(exists.id), skipped: true })
        continue
      }
    }
    let finalName = viewName
    if (exists && conflict === "rename") {
      let n = 2
      while ((await storage.query("SELECT id FROM views WHERE name = ? AND schema_id = ?", [viewName + " " + n, schemaId]))[0]) n++
      finalName = viewName + " " + n
    }
    const schemasNow = await allSchemas(storage)
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
    const baseFilters = parseBaseFilters(view.baseFilters ?? {})
    const allowWrite = view.allowWrite === true ? 1 : 0
    const revealSecretsDefault = view.revealSecretsDefault === true ? 1 : 0
    await storage.run(
      "INSERT INTO views (id, name, description, illustration, schema_id, columns, shortcuts, base_filters, allow_write, reveal_secrets_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [viewId, finalName, String(view.description ?? "").trim(), illustration, schemaId, JSON.stringify(columns), JSON.stringify(shortcuts), JSON.stringify(baseFilters), allowWrite, revealSecretsDefault, stamp, stamp],
    )
    createdViews.push({ name: finalName, id: viewId, skipped: false })
  }

  let sampleCount = 0
  const packIdToNewId: Record<string, string> = {}
  const pendingSamples: { newId: string; schemaId: string; data: Record<string, string>; tags: string[]; schema: SchemaRow }[] = []
  const schemasNow = await allSchemas(storage)
  const schemaById = Object.fromEntries(schemasNow.map((item) => [item.id, item]))
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
    const sortOrder = await nextRecordSort(storage, schemaId)
    await storage.run(
      "INSERT INTO records (id, schema_id, data, tags, opened_at, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
      [newId, schemaId, JSON.stringify(data), JSON.stringify(tags), sortOrder, stamp, stamp],
    )
    pendingSamples.push({ newId, schemaId, data: raw, tags, schema })
    sampleCount++
  }
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
      await storage.run("UPDATE records SET data = ?, updated_at = ? WHERE id = ?", [JSON.stringify(data), stamp, item.newId])
    }
  }

  const primaryView = createdViews.find((item) => !item.skipped) ?? createdViews[0]
  return {
    schemas: createdSchemas,
    views: createdViews,
    samples: sampleCount,
    primaryViewId: primaryView?.id ?? "",
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
}

export default defineApp({
  name: "数据手账",
  description: "动态数据表与视图，用于管理各种琐碎常用数据：测试账号、环境变量等。支持完全自定义表结构与视图，以及从多种数据源导入。",
  api: {
    async overview(ctx) {
      const { schemas, records } = await load(ctx.storage)
      const tags: Record<string, number> = {}
      for (const row of records) for (const tag of row.tags) tags[tag] = (tags[tag] ?? 0) + 1
      const recent = records.filter((row) => row.openedAt > 0).sort((a, b) => b.openedAt - a.openedAt).slice(0, 5)
      const labels = labelIndex(schemas, records)
      const saved = await ctx.storage.query("SELECT id, name, q, created_at FROM saved_queries ORDER BY created_at DESC")
      const history = await ctx.storage.query("SELECT id, q, used_at FROM query_history ORDER BY used_at DESC LIMIT 20")
      const views = (await ctx.storage.query("SELECT " + VIEW_SELECT + " FROM views ORDER BY created_at DESC")).map(mapView)
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

    async saveView(ctx, args?: { id?: string; name?: string; description?: string; illustration?: string; schemaId?: string; columns?: ViewColumn[]; baseFilters?: unknown; allowWrite?: boolean; revealSecretsDefault?: boolean }) {
      const name = String(args?.name ?? "").trim()
      const description = String(args?.description ?? "").trim()
      const schemaId = String(args?.schemaId ?? "")
      const baseFilters = parseBaseFilters(args?.baseFilters ?? {})
      const allowWrite = args?.allowWrite === true ? 1 : 0
      const revealSecretsDefault = args?.revealSecretsDefault === true ? 1 : 0
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
        await ctx.storage.run("UPDATE views SET name = ?, description = ?, illustration = ?, schema_id = ?, columns = ?, base_filters = ?, allow_write = ?, reveal_secrets_default = ?, updated_at = ? WHERE id = ?", [name, description, illustration, schemaId, JSON.stringify(columns), JSON.stringify(baseFilters), allowWrite, revealSecretsDefault, stamp, existing.id])
        return { id: String(existing.id) }
      }
      const viewId = id("v")
      const illustration = resolveViewIllustration(String(args?.illustration ?? ""), viewId)
      await ctx.storage.run("INSERT INTO views (id, name, description, illustration, schema_id, columns, shortcuts, base_filters, allow_write, reveal_secrets_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [viewId, name, description, illustration, schemaId, JSON.stringify(columns), "[]", JSON.stringify(baseFilters), allowWrite, revealSecretsDefault, stamp, stamp])
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
      const kv = ctx.storage.kv()
      const pinned = String((await kv.get("settings.defaultViewId")) ?? "")
      // Deleted pin → fall back to first view (empty setting)
      if (pinned && pinned === viewId) await kv.delete("settings.defaultViewId")
      return { ok: true }
    },

    async viewRows(ctx, args?: { viewId?: string; filters?: Record<string, string> }) {
      const viewId = String(args?.viewId ?? "")
      const row = (await ctx.storage.query("SELECT " + VIEW_SELECT + " FROM views WHERE id = ?", [viewId]))[0]
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
        if (!matchBaseFilters(item, view.baseFilters, schemas, records, labels)) return false
        return searchable.every((col) => {
          const raw = String(filters[col.key] ?? "").trim()
          if (!raw) return true
          // multi-select values are joined with " | "
          const needles = raw.split(/\s*\|\s*/).map((part) => part.trim().toLowerCase()).filter(Boolean)
          if (!needles.length) return true
          const resolved = resolveViewPath(item, col.key, schemas, records, labels)
          if (isTagsPath(col.key)) {
            const tags = ((resolved as { tags?: string[] }).tags ?? String(resolved.text || "").split(/[·,]/).map((part) => part.trim()).filter(Boolean))
              .map((tag) => tag.toLowerCase())
            return needles.some((needle) => tags.some((tag) => tag === needle || tag.includes(needle)))
          }
          const hay = (resolved.text || resolved.copy).toLowerCase()
          return needles.some((needle) => {
            if (resolved.type === "ref") return hay === needle || hay.includes(needle)
            return hay.includes(needle)
          })
        })
      })
      const baseRows = records.filter((item) => item.schemaId === view.schemaId)
      return {
        view,
        schema,
        headers: shown.map((item) => ({ key: item.key, label: item.as || (isTagsPath(item.key) ? tagsPathLabel(item.key) : item.key) })),
        filters: searchable.map((item) => {
          const field = byPath.get(item.key)
          const options = item.enum
            ? [...new Set(baseRows.flatMap((row) => {
                const resolved = resolveViewPath(row, item.key, schemas, records, labels)
                if (isTagsPath(item.key)) {
                  return (resolved as { tags?: string[] }).tags ?? String(resolved.text || "").split(/[·,]/).map((part) => part.trim()).filter(Boolean)
                }
                const text = String(resolved.text || resolved.copy || "").trim()
                return text ? [text] : []
              }))].sort((a, b) => a.localeCompare(b, "zh-CN"))
            : undefined
          return {
            key: item.key,
            label: item.as || (isTagsPath(item.key) ? tagsPathLabel(item.key) : item.key),
            type: field?.type ?? "string",
            schema: field?.schema,
            enum: !!item.enum,
            options,
          }
        }),
        rows: matched.map((item) => ({
          id: item.id,
          cells: shown.map((col) => {
            const resolved = resolveViewPath(item, col.key, schemas, records, labels)
            if (isTagsPath(col.key)) {
              const tags = Array.isArray((resolved as { tags?: string[] }).tags)
                ? (resolved as { tags: string[] }).tags
                : String(resolved.text || "").split(/[·,]/).map((part) => part.trim()).filter(Boolean)
              return {
                text: tags.join(" · "),
                copy: tags.join(", "),
                type: "tags",
                tags,
              }
            }
            return {
              text: resolved.text,
              copy: resolved.copy,
              type: resolved.type,
            }
          }),
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
      return { row, hits: refsTo(records, schemas, recordId, labels), schemas }
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
      const doomedViews = (await ctx.storage.query("SELECT id FROM views WHERE schema_id = ?", [schemaId])).map((row) => String(row.id))
      await ctx.storage.transaction(async (tx) => {
        await tx.run("DELETE FROM views WHERE schema_id = ?", [schemaId])
        await tx.run("DELETE FROM records WHERE schema_id = ?", [schemaId])
        await tx.run("DELETE FROM schemas WHERE id = ?", [schemaId])
      })
      const kv = ctx.storage.kv()
      const pinnedSchema = String((await kv.get("settings.defaultSchemaId")) ?? "all")
      const pinnedView = String((await kv.get("settings.defaultViewId")) ?? "")
      // Deleted pin → All tables / first view
      if (pinnedSchema === schemaId) await kv.set("settings.defaultSchemaId", "all")
      if (pinnedView && doomedViews.includes(pinnedView)) await kv.delete("settings.defaultViewId")
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
      const views = (await ctx.storage.query("SELECT " + VIEW_SELECT + " FROM views ORDER BY created_at DESC")).map(mapView)
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
            baseFilters: view.baseFilters ?? [],
            allowWrite: !!view.allowWrite,
            revealSecretsDefault: !!view.revealSecretsDefault,
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
      let defaultSchemaId = String((await kv.get("settings.defaultSchemaId")) ?? "all") || "all"
      let defaultViewId = String((await kv.get("settings.defaultViewId")) ?? "")
      const backupDir = String((await kv.get("settings.backupDir")) ?? "")
      const lastBackupPath = String((await kv.get("settings.lastBackupPath")) ?? "")
      const lastBackupAt = Number((await kv.get("settings.lastBackupAt")) ?? 0) || 0
      const allowed = new Set(["home", "data", "views", "import", "settings"])
      const schemas = await allSchemas(ctx.storage)
      const viewRows = await ctx.storage.query("SELECT id FROM views ORDER BY created_at DESC")
      // Heal stale pins: missing table → All; missing view → first view (empty = auto)
      if (defaultSchemaId !== "all" && !schemas.some((item) => item.id === defaultSchemaId)) {
        defaultSchemaId = "all"
        await kv.set("settings.defaultSchemaId", "all")
      }
      if (defaultViewId && !viewRows.some((row) => String(row.id) === defaultViewId)) {
        defaultViewId = ""
        await kv.delete("settings.defaultViewId")
      }
      return {
        startupNav: allowed.has(startupNav) ? startupNav : "home",
        defaultSchemaId,
        defaultViewId,
        backupDir,
        lastBackupPath,
        lastBackupAt,
        rowActionPins: String((await kv.get("settings.rowActionPins")) ?? "edit,copy"),
      }
    },

    async saveSettings(ctx, args?: { startupNav?: string; defaultSchemaId?: string; defaultViewId?: string | null; backupDir?: string | null; rowActionPins?: string }) {
      const kv = ctx.storage.kv()
      if (args?.startupNav != null) {
        const nav = String(args.startupNav)
        const allowed = new Set(["home", "data", "views", "import", "settings"])
        if (!allowed.has(nav)) throw new Error("不支持的启动页")
        await kv.set("settings.startupNav", nav)
      }
      if (args?.defaultSchemaId != null) {
        const sid = String(args.defaultSchemaId).trim() || "all"
        if (sid !== "all") {
          const schemas = await allSchemas(ctx.storage)
          if (!schemas.some((item) => item.id === sid)) throw new Error("找不到这张表")
        }
        await kv.set("settings.defaultSchemaId", sid)
      }
      if (args && Object.prototype.hasOwnProperty.call(args, "defaultViewId")) {
        const vid = args.defaultViewId == null ? "" : String(args.defaultViewId).trim()
        if (vid) {
          const row = (await ctx.storage.query("SELECT id FROM views WHERE id = ?", [vid]))[0]
          if (!row) throw new Error("找不到这个视图")
        }
        if (vid) await kv.set("settings.defaultViewId", vid)
        else await kv.delete("settings.defaultViewId")
      }
      if (args && Object.prototype.hasOwnProperty.call(args, "backupDir")) {
        const dir = args.backupDir == null ? "" : String(args.backupDir).trim()
        if (dir) await kv.set("settings.backupDir", dir)
        else await kv.delete("settings.backupDir")
      }
      if (args?.rowActionPins != null) {
        const allowed = new Set(["edit", "clone", "delete", "copy", "open"])
        const parts = String(args.rowActionPins).split(",").map((item) => item.trim())
        const left = allowed.has(parts[0] ?? "") ? parts[0] : "edit"
        let right = allowed.has(parts[1] ?? "") ? parts[1] : "copy"
        if (right === left) right = left === "copy" ? "open" : "copy"
        await kv.set("settings.rowActionPins", left + "," + right)
      }
      const startupNav = String((await kv.get("settings.startupNav")) ?? "home")
      const defaultSchemaId = String((await kv.get("settings.defaultSchemaId")) ?? "all")
      const defaultViewId = String((await kv.get("settings.defaultViewId")) ?? "")
      const backupDir = String((await kv.get("settings.backupDir")) ?? "")
      return { startupNav, defaultSchemaId, defaultViewId, backupDir }
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
      const viewRows = (await ctx.storage.query("SELECT " + VIEW_SELECT + " FROM views ORDER BY created_at DESC")).map(mapView)
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
        baseFilters: view.baseFilters ?? [],
        allowWrite: !!view.allowWrite,
        revealSecretsDefault: !!view.revealSecretsDefault,
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

    async listModules(ctx) {
      return listModulePacks(ctx.appDir, ctx.storage)
    },

    /** Dry-run plan for the install review dialog — no writes. */
    async previewModule(ctx, args?: { id?: string; path?: string; includeSamples?: boolean }) {
      const { modules } = await listModulePacks(ctx.appDir, ctx.storage)
      const wantId = String(args?.id ?? "").trim()
      const wantPath = String(args?.path ?? "").trim()
      const mod = modules.find((item) => (wantPath && item.path === wantPath) || (wantId && item.id === wantId))
      if (!mod) throw new Error(wantId || wantPath ? "找不到该模块" : "请指定模块 id")
      const pack = await resolveModulePack(ctx.appDir, mod)
      const existing = await allSchemas(ctx.storage)
      const existingNames = new Set(existing.map((item) => item.name))
      const existingViews = (await ctx.storage.query("SELECT name, schema_id FROM views")).map((row) => ({
        name: String(row.name),
        schemaId: String(row.schema_id),
      }))
      const schemaIdByName = Object.fromEntries(existing.map((item) => [item.name, item.id]))
      const includeSamples = !!args?.includeSamples && Array.isArray(pack.samples) && pack.samples.length > 0

      const schemas = (pack.schemas ?? []).map((item) => {
        const name = String(item.name ?? "").trim()
        const fields = (item.fields ?? []).map((field) => String(field.key ?? "").trim()).filter(Boolean)
        const exists = !!name && existingNames.has(name)
        return {
          name,
          fieldCount: fields.length,
          fields,
          exists,
          action: exists ? "reuse" as const : "create" as const,
        }
      }).filter((item) => item.name)

      const views = (pack.views ?? []).map((item) => {
        const name = String(item.name ?? "").trim()
        const schemaName = String(item.schemaName ?? "").trim()
        const schemaId = schemaIdByName[schemaName]
        const exists = !!(name && schemaId && existingViews.some((row) => row.name === name && row.schemaId === schemaId))
        const baseFilters = parseBaseFilters(item.baseFilters ?? [])
        return {
          name,
          schemaName,
          description: String(item.description ?? "").trim(),
          exists,
          action: exists ? "skip" as const : "create" as const,
          baseFilterCount: baseFilters.length,
          allowWrite: item.allowWrite === true,
          revealSecretsDefault: item.revealSecretsDefault === true,
        }
      }).filter((item) => item.name)

      const sampleGroups: Record<string, number> = {}
      for (const sample of includeSamples ? (pack.samples ?? []) : []) {
        const schemaName = String(sample.schemaName ?? "").trim() || "?"
        sampleGroups[schemaName] = (sampleGroups[schemaName] ?? 0) + 1
      }
      const samples = Object.entries(sampleGroups).map(([schemaName, count]) => ({ schemaName, count }))

      return {
        moduleId: mod.id,
        title: mod.title,
        description: mod.description,
        includeSamples,
        hasSamples: !!mod.hasSamples,
        sampleCount: includeSamples ? (pack.samples?.length ?? 0) : 0,
        sampleTotal: pack.samples?.length ?? 0,
        schemas,
        views,
        samples,
        summary: {
          schemaCreate: schemas.filter((item) => item.action === "create").length,
          schemaReuse: schemas.filter((item) => item.action === "reuse").length,
          viewCreate: views.filter((item) => item.action === "create").length,
          viewSkip: views.filter((item) => item.action === "skip").length,
          sampleRows: includeSamples ? (pack.samples?.length ?? 0) : 0,
        },
      }
    },

    async installModule(ctx, args?: { id?: string; path?: string; includeSamples?: boolean; conflict?: "skip" | "rename" }) {
      const { modules } = await listModulePacks(ctx.appDir, ctx.storage)
      const wantId = String(args?.id ?? "").trim()
      const wantPath = String(args?.path ?? "").trim()
      const mod = modules.find((item) => (wantPath && item.path === wantPath) || (wantId && item.id === wantId))
      if (!mod) throw new Error(wantId || wantPath ? "找不到该模块" : "请指定模块 id")
      const pack = await resolveModulePack(ctx.appDir, mod)
      const includeSamples = !!args?.includeSamples && Array.isArray(pack.samples) && pack.samples.length > 0
      const toImport: CaskPack = {
        ...pack,
        samples: includeSamples ? pack.samples : [],
      }
      const conflict = args?.conflict === "rename" ? "rename" : "skip"
      const result = await runImportCaskPack(ctx.storage, toImport, conflict)
      return {
        ...result,
        moduleId: mod.id,
        title: mod.title,
        includeSamples,
      }
    },

    async importCaskPack(ctx, args?: { pack?: CaskPack; conflict?: "skip" | "rename" }) {
      const conflict = args?.conflict === "rename" ? "rename" : "skip"
      return runImportCaskPack(ctx.storage, args?.pack as CaskPack, conflict)
    },

  },
})
