import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { AnimatePresence, motion } from "motion/react"
import { Autocomplete, Badge, Checkbox, DatePicker, DateTimePicker, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, FileDropzone, Icon, IlluEmpty, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Separator, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TimePicker, Toaster, toast, useApp } from "@mohou/ui"
import type { CaskPack, DataRow, Field, ModuleInfo, SchemaRow, Sheet, ViewColumn, ViewDef, ViewShortcut, ViewSort } from "./shared/types.ts"
import { flattenViewFields, formatQuery, labelOf, parseQuery } from "./shared/types.ts"
import type { TextParseResult, TextParserDef } from "./shared/parser-types.ts"
import { VIEW_ILLUSTRATIONS, pickViewIllustration, viewIllustrationAsset } from "./shared/view-illu.ts"
import { layoutRowActs, parseRowActPins, resolveRowActPins, ViewRowActBar, type RowActId } from "./ui/view-row-actions.tsx"

type Nav = "home" | "data" | "import" | "views" | "settings"
type Step = "home" | "file" | "text" | "parser" | "ai" | "targets" | "map" | "refs" | "preview" | "done"
type ImportSource = "file" | "text"
type ImportDeskMode = "landing" | "data" | "pack" | "export"
type PackStep = "source" | "preview" | "conflict" | "done"
type ExportStep = "select" | "preview" | "done"
type Overview = {
  schemas: SchemaRow[]
  counts: Record<string, number>
  tags: Record<string, number>
  recent: DataRow[]
  labels: Record<string, string>
  saved: { id: string; name: string; q: string }[]
  history: { id: string; q: string; usedAt: number }[]
  views: ViewDef[]
  totals: { schemas: number; records: number; tags: number }
}
type ViewResult = {
  view: ViewDef
  schema: SchemaRow
  headers: { key: string; label: string }[]
  filters: { key: string; label: string; type: Field["type"]; schema?: string; enum?: boolean; options?: string[] }[]
  rows: { id: string; cells: { text: string; copy: string; type?: string }[] }[]
}

/** CJK counts ~2 units so short Chinese labels (角色/系统) keep readable width. */
function visualLen(value: string) {
  let n = 0
  for (const ch of value) n += /[\u3400-\u9fff]/.test(ch) ? 2.1 : 1
  return n
}

/** Min pixel widths for home-view columns — never crush short CJK headers. */
function viewColumnMinWidths(headers: { key: string; label: string }[], rows: { cells: { text: string; copy: string; type?: string }[] }[]) {
  if (!headers.length) return [] as number[]
  return headers.map((header, index) => {
    const samples = rows.map((row) => row.cells[index]).filter(Boolean)
    const type = String(samples.find((cell) => cell?.type)?.type || "")
    const blob = (header.key + " " + header.label).toLowerCase()
    const maxV = Math.max(
      visualLen(header.label),
      2,
      ...samples.map((cell) => visualLen(String(cell?.text || "").slice(0, 48))),
    )
    if (type === "secret" || /secret|password|密码|密钥|token/.test(blob)) return 118
    if (type === "url" || /url|link|href|入口|baseurl|website/.test(blob)) return Math.min(260, Math.max(160, maxV * 7.5 + 36))
    if (type === "date" || type === "time") return 108
    if (type === "datetime") return 148
    // floor keeps 角色/系统/环境 from collapsing to one glyph
    return Math.min(240, Math.max(88, maxV * 8.2 + 48))
  })
}

async function copyText(text: string, okTitle: string, okDesc?: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.add({ title: okTitle, description: okDesc, type: "success" })
  } catch (err) {
    toast.add({ title: "复制失败", description: String(err instanceof Error ? err.message : err), type: "error" })
  }
}

function useSaveHotkey(onSave: () => void | Promise<void>, enabled = true) {
  const ref = useRef(onSave)
  ref.current = onSave
  useEffect(() => {
    if (!enabled) return
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key.toLowerCase() !== "s") return
      event.preventDefault()
      void ref.current()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [enabled])
}

function asDate(value: string | undefined) {
  if (!value) return undefined
  const date = new Date(value.length === 10 ? value + "T00:00:00" : value)
  return Number.isNaN(date.getTime()) ? undefined : date
}
function pad(n: number) { return String(n).padStart(2, "0") }
function stampDate(date: Date) { return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) }
function stampDateTime(date: Date) { return stampDate(date) + "T" + pad(date.getHours()) + ":" + pad(date.getMinutes()) }

const stepName: Record<Step, string> = {
  home: "来源",
  file: "文件",
  text: "原文",
  parser: "解析器",
  ai: "AI 识别",
  targets: "目标表",
  map: "列匹配",
  refs: "关联",
  preview: "确认",
  done: "完成",
}
const fileSteps: Step[] = ["home", "file", "targets", "map", "refs", "preview", "done"]
const textSteps: Step[] = ["home", "text", "ai", "parser", "targets", "map", "refs", "preview", "done"]

export default function App() {
  const { call, resolveAssetUrl } = useApp()
  const [nav, setNav] = useState<Nav>("home")
  const [settingsReady, setSettingsReady] = useState(false)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [schemaId, setSchemaId] = useState("all")
  const [defaultSchemaId, setDefaultSchemaId] = useState("all")
  const [defaultViewId, setDefaultViewId] = useState("")
  const [tag, setTag] = useState("all")
  const [q, setQ] = useState("")
  const [rows, setRows] = useState<DataRow[]>([])
  const [selected, setSelected] = useState("")
  const [hits, setHits] = useState<{ recordId: string; schemaId: string; schemaName: string; field: string; name: string }[]>([])
  const [building, setBuilding] = useState<SchemaRow | null>(null)
  const [error, setError] = useState("")
  const [dialog, setDialog] = useState(false)
  const [dropSchema, setDropSchema] = useState<SchemaRow | null>(null)
  const [homeViewId, setHomeViewId] = useState("")
  const [editViewId, setEditViewId] = useState("")
  const filters = useRef({ schemaId: "all", tag: "all", q: "" })
  const request = useRef(0)
  const defaultSchemaRef = useRef("all")
  const defaultViewRef = useRef("")

  function resolveDefaultSchema(preferred: string, list: SchemaRow[]) {
    const id = String(preferred || "all").trim() || "all"
    if (id === "all") return "all"
    return list.some((item) => item.id === id) ? id : "all"
  }

  function resolveDefaultView(preferred: string, list: ViewDef[]) {
    const id = String(preferred || "").trim()
    // Empty pin = first view; missing pin also falls back to first
    if (id && list.some((item) => item.id === id)) return id
    return list[0]?.id ?? ""
  }

  async function enterDataTab(preferred?: string) {
    setNav("data")
    setBuilding(null)
    const list = overview?.schemas ?? []
    const next = resolveDefaultSchema(preferred ?? defaultSchemaRef.current, list)
    setSchemaId(next)
    setSelected("")
    setHits([])
    setQ("")
    await refresh(next, "all", "")
  }

  function enterHomeTab(preferred?: string) {
    setNav("home")
    setBuilding(null)
    const list = overview?.views ?? []
    const next = resolveDefaultView(preferred ?? defaultViewRef.current, list)
    if (next) setHomeViewId(next)
  }

  async function refresh(nextSchema = filters.current.schemaId, nextTag = filters.current.tag, nextQ = filters.current.q) {
    filters.current = { schemaId: nextSchema, tag: nextTag, q: nextQ }
    const token = ++request.current
    const data = await call<Overview>("overview")
    const listed = await call<{ rows: DataRow[] }>("records", { schemaId: nextSchema, tag: nextTag, q: nextQ })
    if (token !== request.current) return listed.rows
    setOverview(data)
    setRows(listed.rows)
    return listed.rows
  }

  useEffect(() => {
    ;(async () => {
      let bootNav: Nav = "home"
      let bootSchema = "all"
      let bootView = ""
      try {
        const settings = await call<{ startupNav: Nav; defaultSchemaId?: string; defaultViewId?: string }>("getSettings")
        bootNav = settings?.startupNav || "home"
        bootSchema = String(settings?.defaultSchemaId ?? "all") || "all"
        bootView = String(settings?.defaultViewId ?? "")
        setDefaultSchemaId(bootSchema)
        defaultSchemaRef.current = bootSchema
        setDefaultViewId(bootView)
        defaultViewRef.current = bootView
        setNav(bootNav)
      } catch { /* first run */ }
      finally { setSettingsReady(true) }
      try {
        const data = await call<Overview>("overview")
        setOverview(data)
        const schema = resolveDefaultSchema(bootSchema, data.schemas ?? [])
        const view = resolveDefaultView(bootView, data.views ?? [])
        setSchemaId(schema)
        if (view) setHomeViewId(view)
        if (bootNav === "data") {
          setSelected("")
          setHits([])
          setQ("")
          await refresh(schema, "all", "")
        } else {
          await refresh(schema, "all", "")
        }
      } catch (err) { setError(String((err as Error).message ?? err)) }
    })()
  }, [])

  async function openRow(id: string, query = filters.current.q) {
    setNav("data")
    setBuilding(null)
    setQ(query)
    const opened = await call<{ row: DataRow; hits: typeof hits }>("openRecord", { id })
    setHits(opened.hits)
    setSchemaId(opened.row.schemaId)
    setSelected(id)
    const next = await refresh(opened.row.schemaId, filters.current.tag, query)
    if (!next.some((row) => row.id === id)) {
      setTag("all")
      setQ("")
      await refresh(opened.row.schemaId, "all", "")
    }
  }

  async function applyQuery(q: string) {
    const parsed = parseQuery(q)
    const match = parsed.table ? (overview?.schemas ?? []).find((item) => item.name === parsed.table) : undefined
    const nextSchema = match?.id ?? "all"
    setSchemaId(nextSchema)
    setTag("all")
    setQ(q)
    setSelected("")
    setHits([])
    setNav("data")
    setBuilding(null)
    if (q.trim()) await call("rememberQuery", { q })
    await refresh(nextSchema, "all", q)
  }

  function citeQuery(tableName: string) {
    const row = rows.find((item) => item.id === selected)
    const schema = schemas.find((item) => item.id === row?.schemaId)
    const cites = labelOf(schema, row, (id) => overview?.labels[id])
    return formatQuery({ table: tableName, tag: "", cites, text: "" })
  }

  const schemas = overview?.schemas ?? []
  const current = rows.find((row) => row.id === selected)

  return (
    <div className="app-shell flex h-full min-h-0 overflow-hidden bg-background text-foreground">
      <Toaster position="bottom-right" timeout={3200} limit={3} />
      <nav className="flex w-[76px] shrink-0 flex-col items-center gap-1 border-r border-border bg-card py-4">
        <img src={resolveAssetUrl("./assets/logo-open-book.webp")} alt="数据手账" title="数据手账" className="mb-3 h-11 w-11 object-contain" />
        {(["home", "data", "views", "import", "settings"] as Nav[]).map((id) => (
          <button
            key={id}
            className={"flex h-14 w-[60px] flex-col items-center justify-center gap-1 rounded-xl text-[11px] " + (nav === id ? "bg-muted text-foreground" : "text-muted-foreground")}
            onClick={() => {
              if (id === "data") void enterDataTab()
              else if (id === "home") enterHomeTab()
              else { setNav(id); setBuilding(null) }
            }}
          >
            {id === "home" ? <Icon.Home size={20} /> : id === "data" ? <Icon.Database size={20} /> : id === "views" ? <Icon.SwatchBook size={20} /> : id === "import" ? <Icon.Download size={20} /> : <Icon.Settings size={20} />}<span>{id === "home" ? "首页" : id === "data" ? "数据" : id === "views" ? "视图" : id === "import" ? "导入" : "设置"}</span>
          </button>
        ))}
      </nav>
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
      <AnimatePresence initial={false}>
        <motion.div
          key={nav + (building ? "-build" : "")}
          className="absolute inset-0 flex min-h-0 min-w-0 overflow-hidden bg-background"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{
            opacity: { duration: 0.26, ease: [0.22, 1, 0.36, 1] },
            y: { duration: 0.32, ease: [0.22, 1, 0.36, 1] },
          }}
          style={{ willChange: "opacity, transform" }}
        >
          {nav === "home" && <HomeView overview={overview} focusViewId={homeViewId} onOpen={openRow} onEditViews={() => setNav("views")} onGoData={() => void enterDataTab()} onGoImport={() => setNav("import")} onRefresh={async () => { await refresh() }} onFocusView={(id) => setHomeViewId(id)} />}
          {nav === "data" && (building ? <Builder schema={building} schemas={schemas} onClose={() => setBuilding(null)} onDelete={() => setDropSchema(building)} onSaved={async (id) => { setSchemaId(id); setQ(""); setSelected(""); setHits([]); setBuilding(null); await refresh(id, tag, "") }} /> : (
            <DataDesk schemas={schemas} counts={overview?.counts ?? {}} tags={overview?.tags ?? {}} recent={overview?.recent ?? []} views={overview?.views ?? []} rows={rows} schemaId={schemaId} tag={tag} q={q} selected={current} hits={hits} schemasAll={schemas} labels={overview?.labels ?? {}}
              onSchema={async (id) => { setSchemaId(id); setQ(""); setSelected(""); setHits([]); await refresh(id, tag, "") }}
              onTag={async (id) => { setTag(id); setSelected(""); setHits([]); await refresh(schemaId, id, q) }}
              onQuery={async (value) => {
                setQ(value)
                const parsed = parseQuery(value)
                const match = parsed.table ? schemas.find((item) => item.name === parsed.table) : undefined
                if (match) setSchemaId(match.id)
                await refresh(match?.id ?? schemaId, tag, value)
              }}
              onOpen={openRow}
              onCite={async (id, tableName) => openRow(id, citeQuery(tableName))}
              onCiteGroup={async (id, tableName) => { setSchemaId(id); setSelected(""); setHits([]); const query = citeQuery(tableName); setQ(query); await refresh(id, tag, query) }}
              onBuild={(schema) => setBuilding(schema)} onDropSchema={setDropSchema} onCreate={() => setBuilding({ id: "", name: "未命名", fields: [{ key: "name", type: "string", label: true }], display: "", sortOrder: 0, createdAt: 0, updatedAt: 0 })}
              onImport={() => setNav("import")}
              onViews={() => setNav("views")}
              onOpenView={(id) => { setHomeViewId(id); setNav("home") }}
              onEditView={(id) => { setEditViewId(id); setNav("views") }}
              onClose={() => { setSelected(""); setHits([]) }}
              onDelete={() => setDialog(true)}
              onSave={async (data, tags) => { if (!current) return; await call("saveRecord", { id: current.id, schemaId: current.schemaId, data, tags }); await openRow(current.id) }}
              onSaveAsNew={async (data, tags) => {
                if (!current) return
                const created = await call<{ id: string }>("saveRecord", { schemaId: current.schemaId, data, tags })
                await refresh()
                await openRow(created.id)
              }}
              onReorderSchemas={async (ids) => {
                await call("reorderSchemas", { ids })
                await refresh()
              }}
              onReorderRecords={async (ids) => {
                if (schemaId === "all") return
                await call("reorderRecords", { schemaId, ids })
                await refresh()
              }}
              onAdd={async () => { if (schemaId === "all") return; const created = await call<{ id: string }>("saveRecord", { schemaId, data: {}, tags: [] }); await refresh(); await openRow(created.id) }}
            />
          ))}
          {nav === "import" && <ImportDesk schemas={schemas} views={overview?.views ?? []} counts={overview?.counts ?? {}} onDone={async () => { await refresh(); setNav("data") }} onBuild={() => setNav("data")} />}
          {nav === "views" && <ViewBuilder schemas={schemas} views={overview?.views ?? []} counts={overview?.counts ?? {}} focusViewId={editViewId} onGoData={() => setNav("data")} onGoImport={() => setNav("import")} onSaved={async () => { await refresh() }} />}
          {nav === "settings" && settingsReady && (
            <SettingsDesk
              schemas={schemas}
              views={overview?.views ?? []}
              onDefaultsChanged={(next) => {
                if (next.defaultSchemaId != null) {
                  setDefaultSchemaId(next.defaultSchemaId)
                  defaultSchemaRef.current = next.defaultSchemaId
                }
                if (next.defaultViewId != null) {
                  setDefaultViewId(next.defaultViewId)
                  defaultViewRef.current = next.defaultViewId
                  const resolved = resolveDefaultView(next.defaultViewId, overview?.views ?? [])
                  if (resolved) setHomeViewId(resolved)
                }
              }}
              onOpenImport={() => setNav("import")}
              onResetDone={async () => {
                setSelected("")
                setHits([])
                setSchemaId("all")
                setQ("")
                setBuilding(null)
                await refresh("all", "all", "")
              }}
            />
          )}
        </motion.div>
      </AnimatePresence>
      </div>
      {error && <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-lg bg-foreground px-3 py-2 text-sm text-background">{error}</div>}
      {dropSchema && (
        <div className="absolute inset-0 z-10 grid place-items-center bg-background/80">
          <div className="w-[380px] rounded-2xl border border-border bg-card p-5">
            <strong>删除表 {dropSchema.name}</strong>
            <p className="mt-2 text-sm text-muted-foreground">表和里面的行会一起删掉。被别的表引用时不能删。</p>
            <div className="mt-4 flex justify-end gap-2">
              <button className="h-9 rounded-lg border border-border px-3 text-sm" onClick={() => setDropSchema(null)}>取消</button>
              <button className="h-9 rounded-lg bg-destructive px-4 text-sm text-destructive-foreground" onClick={async () => {
                try {
                  const doomed = dropSchema.id
                  await call("deleteSchema", { id: doomed })
                  const stay = schemaId === doomed ? "all" : schemaId
                  setSchemaId(stay)
                  if (defaultSchemaRef.current === doomed) {
                    defaultSchemaRef.current = "all"
                    setDefaultSchemaId("all")
                  }
                  if (homeViewId) {
                    // views on this table were removed server-side; pin falls back on next resolve
                    const data = await call<Overview>("overview")
                    setOverview(data)
                    if (defaultViewRef.current && !(data.views ?? []).some((item) => item.id === defaultViewRef.current)) {
                      defaultViewRef.current = ""
                      setDefaultViewId("")
                    }
                    const nextView = resolveDefaultView(defaultViewRef.current, data.views ?? [])
                    if (nextView) setHomeViewId(nextView)
                  }
                  setSelected("")
                  setHits([])
                  setBuilding(null)
                  setDropSchema(null)
                  await refresh(stay, tag, "")
                } catch (err) {
                  setDropSchema(null)
                  setError(String(err instanceof Error ? err.message : err))
                }
              }}>删除</button>
            </div>
          </div>
        </div>
      )}
      {dialog && current && <DeleteDialog hits={hits} name={overview?.labels[current.id] || labelOf(schemas.find((item) => item.id === current.schemaId), current, (id) => overview?.labels[id]) || current.id} onClose={() => setDialog(false)} onChoose={async (mode) => {
        if (mode === "abort") { setDialog(false); return }
        await call("deleteRecord", { id: current.id, mode })
        setDialog(false)
        setSelected("")
        await refresh()
      }} />}
    </div>
  )
}

function viewRelatedTables(view: ViewDef, schemas: SchemaRow[]) {
  const main = schemas.find((item) => item.id === view.schemaId)
  if (!main) return { mainName: "表", related: [] as string[] }
  const names = new Set<string>()
  const byId = Object.fromEntries(schemas.map((item) => [item.id, item]))
  for (const col of view.columns ?? []) {
    const parts = String(col.key || "").split(".").filter(Boolean)
    let current = main
    for (let i = 0; i < parts.length - 1; i++) {
      const field = current.fields.find((item) => item.key === parts[i])
      if (!field || field.type !== "ref" || !field.schema) break
      const next = byId[field.schema]
      if (!next) break
      names.add(next.name)
      current = next
    }
  }
  return { mainName: main.name, related: [...names] }
}

function ViewRailCard({ on, name, mainName, related = [], rows, illuUrl, onClick }: {
  on: boolean
  name: string
  mainName: string
  related?: string[]
  rows: number
  illuUrl: string
  onClick: () => void
}) {
  return (
    <button type="button" className={"view-rail-card " + (on ? "is-on" : "")} onClick={onClick}>
      <span className={"view-illu-stamp view-illu-stamp-sm shrink-0 " + (on ? "is-on" : "")}>
        <img src={illuUrl} alt="" />
      </span>
      <span className="view-rail-card-body">
        <span className="view-rail-card-title">{name}</span>
        <span className="view-rail-card-lineage">
          <b>{mainName}</b>
          {related.length > 0 && (
            <>
              <span className="view-rail-card-sep" aria-hidden="true" />
              <span className="view-rail-card-related">{related.join(" · ")}</span>
            </>
          )}
        </span>
      </span>
      <span className={"view-rail-card-count " + (on ? "is-on" : "")} aria-label={rows + " 行"}>
        {/* single text run — avoid dual-baseline 3/行 drift */}
        {rows}<span className="view-rail-card-count-unit">行</span>
      </span>
    </button>
  )
}

function sameFilters(a: Record<string, string>, b: Record<string, string>) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (String(a[key] ?? "").trim() !== String(b[key] ?? "").trim()) return false
  }
  return true
}

function sameSorts(a: ViewSort[], b: ViewSort[]) {
  if (a.length !== b.length) return false
  return a.every((item, index) => item.key === b[index]?.key && item.dir === b[index]?.dir)
}

function compactFilters(input: Record<string, string>) {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    const text = value.trim()
    if (text) out[key] = text
  }
  return out
}

function shortcutLabel(filters: Record<string, string>, headers: { key: string; label: string }[]) {
  const parts = Object.entries(filters).map(([key, value]) => {
    const label = headers.find((item) => item.key === key)?.label ?? key
    return label + " " + value
  })
  return parts.join(" · ") || "快捷搜索"
}

function shortcutMemoryKey(viewId: string) {
  return "data-cask.view-shortcut." + viewId
}

function readRememberedShortcut(viewId: string) {
  try { return localStorage.getItem(shortcutMemoryKey(viewId)) ?? "" } catch { return "" }
}

function rememberShortcut(viewId: string, shortcutId: string) {
  try { localStorage.setItem(shortcutMemoryKey(viewId), shortcutId) } catch { /* ignore */ }
}

function HomeView({ overview, focusViewId, onOpen, onEditViews, onGoData, onGoImport, onRefresh, onFocusView }: { overview: Overview | null; focusViewId?: string; onOpen: (id: string) => void; onEditViews: () => void; onGoData: () => void; onGoImport: () => void; onRefresh: () => Promise<void>; onFocusView?: (id: string) => void }) {
  const { call, resolveAssetUrl } = useApp()
  const views = overview?.views ?? []
  const schemas = overview?.schemas ?? []
  const [viewId, setViewId] = useState(() => (focusViewId && views.some((item) => item.id === focusViewId) ? focusViewId : views[0]?.id ?? ""))
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [result, setResult] = useState<ViewResult | null>(null)
  const [options, setOptions] = useState<Record<string, { id: string; label: string }[]>>({})
  const [savingShortcut, setSavingShortcut] = useState(false)
  const [naming, setNaming] = useState(false)
  const [shortcutName, setShortcutName] = useState("")
  const [irisKey, setIrisKey] = useState(0)
  const [sorts, setSorts] = useState<ViewSort[]>([])
  const [revealSecrets, setRevealSecrets] = useState(false)
  const [editor, setEditor] = useState<{ mode: "create" | "edit"; row?: DataRow } | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState("")
  const [actionPins, setActionPins] = useState<[RowActId, RowActId]>(["edit", "copy"])
  const [sheetW, setSheetW] = useState(0)
  const sheetRef = useRef<HTMLDivElement>(null)
  const filterTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const shortcutInput = useRef<HTMLInputElement>(null)
  const active = views.find((item) => item.id === viewId) ?? views[0]
  const writeSchema = schemas.find((item) => item.id === active?.schemaId)
  const canWrite = !!active?.allowWrite && !!writeSchema
  useEffect(() => {
    call<{ rowActionPins?: string }>("getSettings").then((settings) => {
      setActionPins(parseRowActPins(settings?.rowActionPins))
    }).catch(() => {})
  }, [call])
  useLayoutEffect(() => {
    const el = sheetRef.current
    if (!el) return
    const apply = () => setSheetW(el.clientWidth)
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(el)
    return () => observer.disconnect()
  }, [viewId, result?.headers.length])
  useEffect(() => () => { if (filterTimer.current) clearTimeout(filterTimer.current) }, [])
  useEffect(() => {
    if (!naming) return
    const timer = setTimeout(() => {
      shortcutInput.current?.focus()
      shortcutInput.current?.select()
    }, 120)
    return () => clearTimeout(timer)
  }, [naming])
  useEffect(() => {
    if (!views.length) { setViewId(""); setResult(null); return }
    if (!views.some((item) => item.id === viewId)) setViewId(views[0].id)
  }, [views, viewId])
  useEffect(() => {
    if (focusViewId && views.some((item) => item.id === focusViewId)) setViewId(focusViewId)
  }, [focusViewId, views])
  useEffect(() => { setRevealSecrets(false) }, [active?.id])
  useEffect(() => {
    if (!active) return
    const remembered = readRememberedShortcut(active.id)
    const shortcut = (active.shortcuts ?? []).find((item) => item.id === remembered)
    const next = shortcut ? { ...shortcut.filters } : {}
    const nextSorts = shortcut?.sorts?.length ? shortcut.sorts.map((item) => ({ ...item })) : []
    setFilters(next)
    setSorts(nextSorts)
    setNaming(false)
    setShortcutName("")
    setIrisKey((value) => value + 1)
    if (remembered && !shortcut) rememberShortcut(active.id, "")
    call<ViewResult>("viewRows", { viewId: active.id, filters: next }).then(setResult).catch(() => setResult(null))
  }, [active?.id])
  useEffect(() => {
    if (!result) return
    const refs = result.filters.filter((item) => item.type === "ref" && item.schema)
    Promise.all(refs.map(async (item) => {
      const listed = await call<{ rows: DataRow[] }>("records", { schemaId: item.schema })
      const schema = overview?.schemas.find((row) => row.id === item.schema)
      return [item.key, listed.rows.map((row) => ({ id: row.id, label: overview?.labels[row.id] || labelOf(schema, row, (id) => overview?.labels[id]) || row.id }))] as const
    })).then((pairs) => setOptions(Object.fromEntries(pairs)))
  }, [result?.view.id])
  async function run(next: Record<string, string>, shortcutId?: string, nextSorts?: ViewSort[]) {
    if (!active) return
    if (filterTimer.current) {
      clearTimeout(filterTimer.current)
      filterTimer.current = null
    }
    setFilters(next)
    if (nextSorts) setSorts(nextSorts)
    if (shortcutId !== undefined) rememberShortcut(active.id, shortcutId)
    const data = await call<ViewResult>("viewRows", { viewId: active.id, filters: next })
    setResult(data)
  }

  function toggleSort(key: string) {
    const sortable = active?.columns.some((col) => col.key === key && col.show && col.sort)
    if (!sortable) return
    setSorts((prev) => {
      const idx = prev.findIndex((item) => item.key === key)
      if (idx < 0) return [...prev, { key, dir: "asc" }].slice(0, 3)
      const cur = prev[idx]
      if (cur.dir === "asc") {
        const next = prev.slice()
        next[idx] = { key, dir: "desc" }
        return next
      }
      return prev.filter((item) => item.key !== key)
    })
  }

  function clearSort(key?: string) {
    if (!key) setSorts([])
    else setSorts((prev) => prev.filter((item) => item.key !== key))
  }

  function sortedRows(rows: ViewResult["rows"]) {
    if (!sorts.length) return rows
    const headers = result?.headers ?? []
    const indexOf = (key: string) => headers.findIndex((h) => h.key === key)
    return rows.slice().sort((a, b) => {
      for (const sort of sorts) {
        const i = indexOf(sort.key)
        if (i < 0) continue
        const av = (a.cells[i]?.text ?? "").trim()
        const bv = (b.cells[i]?.text ?? "").trim()
        const an = Number(av)
        const bn = Number(bv)
        let cmp = 0
        if (av !== "" && bv !== "" && !Number.isNaN(an) && !Number.isNaN(bn)) cmp = an - bn
        else cmp = av.localeCompare(bv, "zh-CN", { numeric: true, sensitivity: "base" })
        if (cmp !== 0) return sort.dir === "asc" ? cmp : -cmp
      }
      return 0
    })
  }
  function runTextFilter(key: string, value: string) {
    if (!active) return
    setFilters((prev) => {
      const next = { ...prev, [key]: value }
      if (filterTimer.current) clearTimeout(filterTimer.current)
      filterTimer.current = setTimeout(() => {
        filterTimer.current = null
        void run(next)
      }, 280)
      return next
    })
  }
  function beginSaveShortcut() {
    if (!active || savingShortcut) return
    const packed = compactFilters(filters)
    if (!Object.keys(packed).length && !sorts.length) {
      toast.add({ title: "先设筛选或排序", type: "error" })
      return
    }
    const base = shortcutLabel(packed, result?.headers ?? [])
    const sortPart = sorts.map((item) => {
      const label = result?.headers.find((h) => h.key === item.key)?.label ?? item.key
      return label + (item.dir === "asc" ? "↑" : "↓")
    }).join(" ")
    setShortcutName([base !== "快捷搜索" ? base : "", sortPart].filter(Boolean).join(" · ") || "快捷")
    setNaming(true)
  }
  async function updateShortcut(target: ViewShortcut) {
    if (!active || savingShortcut) return
    const packed = compactFilters(filters)
    if (!Object.keys(packed).length && !sorts.length) {
      toast.add({ title: "先设筛选或排序", type: "error" })
      return
    }
    setSavingShortcut(true)
    try {
      const saved = await call<{ id: string }>("saveViewShortcut", {
        viewId: active.id,
        id: target.id,
        name: target.name,
        filters: packed,
        sorts,
      })
      rememberShortcut(active.id, saved.id)
      await onRefresh()
      setNaming(false)
      toast.add({ title: "快捷已更新", description: target.name, type: "success" })
    } catch (err) {
      toast.add({ title: "更新失败", description: String(err instanceof Error ? err.message : err), type: "error" })
    } finally {
      setSavingShortcut(false)
    }
  }
  async function saveShortcut() {
    if (!active || savingShortcut) return
    const packed = compactFilters(filters)
    if (!Object.keys(packed).length && !sorts.length) {
      toast.add({ title: "先设筛选或排序", type: "error" })
      return
    }
    const name = shortcutName.trim()
    if (!name) {
      toast.add({ title: "先写快捷名称", type: "error" })
      return
    }
    // create new — do not silently overwrite another shortcut just because filters match
    setSavingShortcut(true)
    try {
      const saved = await call<{ id: string }>("saveViewShortcut", { viewId: active.id, name, filters: packed, sorts })
      rememberShortcut(active.id, saved.id)
      await onRefresh()
      setNaming(false)
      toast.add({ title: "快捷已保存", description: name, type: "success" })
    } catch (err) {
      toast.add({ title: "保存失败", description: String(err instanceof Error ? err.message : err), type: "error" })
    } finally {
      setSavingShortcut(false)
    }
  }
  async function removeShortcut(item: ViewShortcut) {
    if (!active) return
    try {
      await call("deleteViewShortcut", { viewId: active.id, id: item.id })
      if (readRememberedShortcut(active.id) === item.id) {
        rememberShortcut(active.id, "")
        await run({})
      }
      await onRefresh()
      toast.add({ title: "已删除快捷搜索", description: item.name, type: "success" })
    } catch (err) {
      toast.add({ title: "删除失败", description: String(err instanceof Error ? err.message : err), type: "error" })
    }
  }
  if (!views.length) {
    const hasTables = (overview?.schemas.length ?? 0) > 0
    return (
      <ViewEmptyStage
        kind={hasTables ? "no-views" : "no-tables"}
        onPrimary={hasTables ? onEditViews : onGoData}
        onSecondary={hasTables ? onGoData : onGoImport}
        onTertiary={hasTables ? onGoImport : undefined}
        onRefresh={onRefresh}
        onInstalled={async (viewId) => {
          await onRefresh()
          if (viewId) onFocusView?.(viewId)
        }}
      />
    )
  }
  const schemaName = schemas.find((item) => item.id === active?.schemaId)?.name ?? ""
  const totalRows = overview?.counts[active?.schemaId ?? ""] ?? 0
  const matchRows = result?.rows.length ?? 0
  const packed = compactFilters(filters)
  const hasFilters = Object.keys(packed).length > 0
  const hasSorts = sorts.length > 0
  const canSaveShortcut = hasFilters || hasSorts
  const shortcuts = active?.shortcuts ?? []
  const activeShortcutId = shortcuts.find((item) => sameFilters(item.filters, packed) && sameSorts(item.sorts ?? [], sorts))?.id
  const rememberedShortcutId = active ? readRememberedShortcut(active.id) : ""
  const pinnedShortcut = shortcuts.find((item) => item.id === (activeShortcutId || rememberedShortcutId))
  const canUpdatePinned = !!pinnedShortcut && !activeShortcutId
  const activeIllu = viewIllustrationAsset(active?.illustration, active?.id ?? "view")
  const displayRows = sortedRows(result?.rows ?? [])
  const hasSecrets = displayRows.some((row) => row.cells.some((cell) => cell.type === "secret" && !!(cell.copy || cell.text)))
  const sortLabel = (key: string) => result?.headers.find((h) => h.key === key)?.label ?? key
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
      <aside className="flex h-full min-h-0 w-[268px] shrink-0 flex-col overflow-hidden border-r border-border bg-card/40 px-4 py-7">
        <p className="mb-4 px-2 text-xs tracking-[0.18em] text-muted-foreground">视图</p>
        <div className="min-h-0 flex-1 space-y-2 overflow-auto">
          {views.map((item) => {
            const illu = viewIllustrationAsset(item.illustration, item.id)
            return (
              <ViewRailCard
                key={item.id}
                on={item.id === active?.id}
                name={item.name}
                {...viewRelatedTables(item, schemas)}
                rows={overview?.counts[item.schemaId] ?? 0}
                illuUrl={resolveAssetUrl(illu.path)}
                onClick={() => setViewId(item.id)}
              />
            )
          })}
        </div>
      </aside>
      <div key={active?.id + "-" + irisKey} className="view-iris view-iris-in flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-10 py-8">
        <div className="view-mast shrink-0">
          <div className="view-mast-title min-w-0">
            <div className="view-mast-copy">
              <p className="text-xs tracking-[0.2em] text-muted-foreground">只读 · 来自 {schemaName}</p>
              <h1 className="mt-2 text-3xl font-medium tracking-tight break-words">{active?.name}</h1>
              {!!active?.description?.trim() && <p className="mt-2 text-sm leading-relaxed text-muted-foreground break-words">{active.description.trim()}</p>}
            </div>
            <div className="view-mast-shortcuts">
              <button type="button" className={"view-chip " + (!hasFilters && !hasSorts ? "view-chip-on" : "view-chip-off")} onClick={() => run({}, "", [])}>
                全部
              </button>
              {shortcuts.map((item) => {
                const on = item.id === activeShortcutId
                return (
                  <span key={item.id} className={"view-chip !pr-1 " + (on ? "view-chip-on" : "view-chip-off")}>
                    <button type="button" className="view-chip-btn" onClick={() => run({ ...item.filters }, item.id, item.sorts ?? [])}>{item.name}</button>
                    <button type="button" className="view-chip-x" aria-label={"删除 " + item.name} onClick={() => removeShortcut(item)}>
                      <Icon.X size={11} />
                    </button>
                  </span>
                )
              })}
              {canSaveShortcut && !naming && !activeShortcutId && (
                <div className="view-chip-save-bar">
                  {canUpdatePinned && pinnedShortcut ? (
                    <>
                      <button
                        type="button"
                        className="view-chip view-chip-save-main"
                        disabled={savingShortcut}
                        onClick={() => void updateShortcut(pinnedShortcut)}
                        title={"用当前筛选/排序覆盖「" + pinnedShortcut.name + "」"}
                      >
                        {savingShortcut ? <Icon.Loader2 size={11} className="animate-spin" /> : <Icon.BookmarkCheck size={12} />}
                        <span className="max-w-[7.5rem] truncate">更新「{pinnedShortcut.name}」</span>
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          delay={0}
                          render={
                            <button type="button" className="view-chip view-chip-save-more" disabled={savingShortcut} aria-label="更多快捷操作">
                              <Icon.ChevronDown size={12} />
                            </button>
                          }
                        />
                        <DropdownMenuContent align="start" sideOffset={6} className="min-w-[12rem]">
                          <DropdownMenuItem onClick={() => beginSaveShortcut()}>
                            <Icon.BookmarkPlus size={14} />
                            存为新快捷…
                          </DropdownMenuItem>
                          {shortcuts.filter((item) => item.id !== pinnedShortcut.id).length > 0 && <DropdownMenuSeparator />}
                          {shortcuts.filter((item) => item.id !== pinnedShortcut.id).map((item) => (
                            <DropdownMenuItem key={item.id} onClick={() => void updateShortcut(item)}>
                              <Icon.Replace size={14} />
                              覆盖「{item.name}」
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="view-chip view-chip-dash view-chip-save-main"
                      disabled={savingShortcut}
                      onClick={() => beginSaveShortcut()}
                    >
                      <Icon.BookmarkPlus size={12} />
                      <span>存为快捷</span>
                    </button>
                  )}
                </div>
              )}
              {canSaveShortcut && naming && (
                <div className="view-chip view-chip-save is-open">
                  <div className="view-chip-save-edit is-solid">
                    <input
                      ref={shortcutInput}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder="快捷名称"
                      value={shortcutName}
                      onChange={(event) => setShortcutName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void saveShortcut()
                        if (event.key === "Escape") setNaming(false)
                      }}
                    />
                    <button type="button" className="view-chip-x" aria-label="取消" onClick={() => setNaming(false)}><Icon.X size={11} /></button>
                    <button type="button" className="view-chip-save-go" disabled={savingShortcut} onClick={() => void saveShortcut()}>
                      {savingShortcut ? <Icon.Loader2 size={11} className="animate-spin" /> : "保存"}
                    </button>
                  </div>
                </div>
              )}
              {!shortcuts.length && !canSaveShortcut && !naming && (
                <span className="shrink-0 text-[11px] leading-none text-muted-foreground">筛选或排序后可存为快捷</span>
              )}
            </div>
          </div>
          <div className="view-mast-gap" aria-hidden="true" />
          <div className="view-mast-illu" aria-hidden="true">
            <img src={resolveAssetUrl(activeIllu.path)} alt="" />
          </div>
          <div className="view-mast-seal">
            <div className="view-stamp grid h-[116px] w-[116px] place-items-center rounded-[28px] border border-border">
              <div className="text-center">
                <p className="text-[10px] tracking-[0.22em] text-muted-foreground">VIEW</p>
                <strong className="mt-1 block text-[28px] font-medium tracking-tight leading-none">{matchRows}<span className="text-lg text-muted-foreground">/{totalRows}</span></strong>
                <p className="mt-1.5 text-[10px] tracking-[0.18em] text-muted-foreground">MATCH</p>
              </div>
            </div>
          </div>
        </div>
        {!!result?.filters.length && (
          <div className="view-filters mt-7 rounded-[24px] border border-border bg-card px-5 py-4 shadow-sm">
            {result.filters.map((item) => {
              const enumOpts = item.enum && item.options?.length ? item.options : undefined
              return (
              <label key={item.key} className="view-filter-item flex flex-col gap-2 text-[11px] tracking-[0.14em] text-muted-foreground">
                {item.label}
                {enumOpts ? (
                  <div className={"view-filter-auto" + ((filters[item.key] ?? "").trim() ? " has-value" : "")}>
                    <Autocomplete
                      value={filters[item.key] ?? ""}
                      placeholder="输入或选择"
                      options={enumOpts}
                      onChange={(value) => {
                        // typing → debounce; picking a full option → apply immediately
                        const exact = enumOpts.includes(value)
                        if (exact || !value) run({ ...filters, [item.key]: value })
                        else runTextFilter(item.key, value)
                      }}
                    />
                    <button
                      type="button"
                      className="view-filter-clear"
                      aria-label={"清除 " + item.label}
                      tabIndex={(filters[item.key] ?? "").trim() ? 0 : -1}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => run({ ...filters, [item.key]: "" })}
                    >
                      <Icon.X size={14} />
                    </button>
                  </div>
                ) : item.type === "ref" ? (
                  <div className={"view-filter-select" + ((filters[item.key] ?? "").trim() ? " has-value" : "")}>
                    <AppSelect height={40} value={filters[item.key] ?? ""} placeholder="全部" emptyLabel="全部" onChange={(value) => run({ ...filters, [item.key]: value })} options={(options[item.key] ?? []).map((row) => ({ value: row.label, label: row.label }))} />
                    <button type="button" className="view-filter-clear" aria-label={"清除 " + item.label} tabIndex={(filters[item.key] ?? "").trim() ? 0 : -1} onClick={() => run({ ...filters, [item.key]: "" })}>
                      <Icon.X size={14} />
                    </button>
                  </div>
                ) : item.type === "date" ? (
                  <DatePicker className="h-10 w-full justify-between rounded-xl border border-border bg-card px-3 text-sm font-normal shadow-none hover:bg-card dark:bg-card dark:hover:bg-card" placeholder="全部" {...asDate(filters[item.key]) ? { value: asDate(filters[item.key]) } : {}} onChange={(value) => run({ ...filters, [item.key]: value ? stampDate(value) : "" })} />
                ) : item.type === "datetime" ? (
                  <DateTimePicker className="h-10 w-full justify-between rounded-xl border border-border bg-card px-3 text-sm font-normal shadow-none hover:bg-card dark:bg-card dark:hover:bg-card" placeholder="全部" {...asDate(filters[item.key]) ? { value: asDate(filters[item.key]) } : {}} onChange={(value) => run({ ...filters, [item.key]: value ? stampDateTime(value) : "" })} />
                ) : item.type === "time" ? (
                  <TimePicker className="h-10 w-full rounded-xl border border-border bg-card px-3 text-sm shadow-none dark:bg-card" value={filters[item.key] ?? ""} onChange={(value) => run({ ...filters, [item.key]: value })} />
                ) : (
                  <div className={"view-filter-text" + ((filters[item.key] ?? "").trim() ? " has-value" : "")}>
                    <FieldBox height={40}>
                      <input className="h-full w-full border-0 bg-transparent pr-1 text-sm text-foreground outline-none" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="包含" value={filters[item.key] ?? ""} onChange={(event) => runTextFilter(item.key, event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") run({ ...filters, [item.key]: (event.target as HTMLInputElement).value }) }} />
                    </FieldBox>
                    <button type="button" className="view-filter-clear" aria-label={"清除 " + item.label} tabIndex={(filters[item.key] ?? "").trim() ? 0 : -1} onClick={() => run({ ...filters, [item.key]: "" })}>
                      <Icon.X size={14} />
                    </button>
                  </div>
                )}
              </label>
              )
            })}
          </div>
        )}
        <div className="mt-6 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[28px] border border-border bg-card shadow-sm">
          {(canWrite || hasSorts || hasSecrets) && (
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 text-[11px]">
              {canWrite && (
                <button
                  type="button"
                  className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-border bg-foreground px-3 text-xs font-medium text-background hover:opacity-90"
                  onClick={() => setEditor({ mode: "create" })}
                >
                  <Icon.Plus size={14} />
                  新增
                </button>
              )}
              {hasSorts && (
                <>
                  <span className="tracking-[0.14em] text-muted-foreground">排序</span>
                  {sorts.map((item, index) => (
                    <button
                      key={item.key}
                      type="button"
                      className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border bg-background px-2 text-foreground hover:bg-secondary"
                      onClick={() => toggleSort(item.key)}
                      title="切换升/降；再点一次取消该级"
                    >
                      <span className="grid h-4 min-w-4 place-items-center rounded-full bg-secondary text-[10px] tabular-nums">{index + 1}</span>
                      <span>{sortLabel(item.key)}</span>
                      {item.dir === "asc" ? <Icon.ArrowUp size={12} /> : <Icon.ArrowDown size={12} />}
                    </button>
                  ))}
                  <button type="button" className="h-7 rounded-lg px-2 text-muted-foreground hover:bg-secondary hover:text-foreground" onClick={() => clearSort()}>
                    清除排序
                  </button>
                </>
              )}
              {hasSecrets && (
                <button
                  type="button"
                  className={"ml-auto inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 " + (revealSecrets ? "border-foreground bg-foreground text-background" : "border-border bg-background text-muted-foreground hover:bg-secondary hover:text-foreground")}
                  title={revealSecrets ? "隐藏全部密钥" : "一键显示本页全部密钥"}
                  onClick={() => setRevealSecrets((v) => !v)}
                >
                  {revealSecrets ? <Icon.EyeOff size={13} /> : <Icon.Eye size={13} />}
                  <span>{revealSecrets ? "隐藏全部密钥" : "显示全部密钥"}</span>
                </button>
              )}
            </div>
          )}
          <div ref={sheetRef} className="view-sheet min-h-0 flex-1 overflow-auto">
            {(() => {
              const headers = result?.headers ?? []
              const mins = viewColumnMinWidths(headers, displayRows)
              const actLayout = layoutRowActs({
                sheetW,
                dataMin: mins.reduce((sum, width) => sum + width, 0),
                canWrite,
                pins: resolveRowActPins(actionPins.join(","), canWrite),
              })
              const actionsMin = actLayout.pinW
              return (
            <table className="w-max min-w-full text-left text-sm">
              <colgroup>
                {headers.map((header, index) => (
                  <col key={header.key} style={{ minWidth: mins[index] ?? 96 }} />
                ))}
                <col style={{ minWidth: actionsMin }} />
              </colgroup>
              <thead className="sticky top-0 z-[1] bg-card/95 backdrop-blur">
                <tr>
                  {headers.map((header, index) => {
                    const canSort = !!active?.columns.find((col) => col.key === header.key && col.show && col.sort)
                    const sortIndex = sorts.findIndex((item) => item.key === header.key)
                    const sort = sortIndex >= 0 ? sorts[sortIndex] : undefined
                    return (
                      <th key={header.key} className="border-b border-border px-4 py-3.5 text-[11px] font-medium tracking-[0.16em] text-muted-foreground" style={{ minWidth: mins[index] }}>
                        <span className="group inline-flex items-center gap-1.5 whitespace-nowrap">
                          {canSort ? (
                            <button type="button" className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-secondary hover:text-foreground" onClick={() => toggleSort(header.key)}>
                              <span>{header.label}</span>
                              {sort ? (
                                <span className="inline-flex shrink-0 items-center gap-0.5 text-foreground">
                                  <span className="grid h-4 min-w-4 place-items-center rounded-full bg-secondary text-[10px] tabular-nums">{sortIndex + 1}</span>
                                  {sort.dir === "asc" ? <Icon.ArrowUp size={12} /> : <Icon.ArrowDown size={12} />}
                                </span>
                              ) : (
                                <Icon.ArrowUpDown size={12} className="shrink-0 opacity-40 group-hover:opacity-80" />
                              )}
                            </button>
                          ) : (
                            <span>{header.label}</span>
                          )}
                          <button
                            type="button"
                            className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                            aria-label={"复制列 " + header.label}
                            onClick={() => void copyText((result?.rows ?? []).map((row) => row.cells[index]?.copy ?? "").join("\n"), "已复制列", header.label)}
                          >
                            <Icon.Copy size={12} />
                          </button>
                        </span>
                      </th>
                    )
                  })}
                  <th className="view-act-pin border-b border-border py-3.5 text-[11px] font-medium tracking-[0.16em] text-muted-foreground" style={{ minWidth: actionsMin }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((row) => (
                  <tr key={row.id} className="group border-b border-border last:border-0 hover:bg-secondary/50">
                    {row.cells.map((cell, index) => {
                      const colLabel = headers[index]?.label || headers[index]?.key || "单元格"
                      return (
                      <td key={index} className="px-4 py-4 align-middle" style={{ minWidth: mins[index] }}>
                        {cell.type === "secret" ? (
                          <ViewSecretCell text={cell.text} copy={cell.copy} forceOpen={revealSecrets} label={colLabel} />
                        ) : (
                          <span className="inline-flex max-w-full items-center gap-2">
                            <span className="whitespace-nowrap">{cell.text || "—"}</span>
                            {!!cell.copy && (
                              <button
                                type="button"
                                className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100"
                                aria-label={"复制单元格 " + colLabel}
                                onClick={() => void copyText(cell.copy, "已复制单元格", colLabel)}
                              >
                                <Icon.Copy size={13} />
                              </button>
                            )}
                          </span>
                        )}
                      </td>
                      )
                    })}
                    <td className="view-act-pin py-2 align-middle" style={{ minWidth: actionsMin }}>
                      <ViewRowActBar
                        layout={actLayout}
                        onRun={(id) => {
                          if (id === "copy") {
                            void copyText(row.cells.map((cell) => cell.copy).filter(Boolean).join("\t"), "已复制整行", headers.map((h) => h.label).join(" · ") || undefined)
                            return
                          }
                          if (id === "open") {
                            onOpen(row.id)
                            return
                          }
                          if (id === "delete") {
                            setPendingDeleteId(row.id)
                            return
                          }
                          void (async () => {
                            try {
                              const opened = await call<{ row: DataRow }>("openRecord", { id: row.id })
                              if (id === "clone") setEditor({ mode: "create", row: { ...opened.row, id: "", tags: [...(opened.row.tags ?? [])] } })
                              else setEditor({ mode: "edit", row: opened.row })
                            } catch (err) {
                              toast.add({ title: id === "clone" ? "无法克隆" : "打不开这条", description: String(err instanceof Error ? err.message : err), type: "error" })
                            }
                          })()
                        }}
                      />
                    </td>
                  </tr>
                ))}
                {!result?.rows.length && (
                  <tr>
                    <td className="px-5 py-16" colSpan={(result?.headers.length ?? 0) + 1}>
                      <div className="flex flex-col items-center justify-center gap-3 text-center">
                        <IlluEmpty className="w-40" />
                        <div>
                          <p className="text-base font-medium text-foreground">没有匹配</p>
                          <p className="mt-1 text-sm text-muted-foreground">试试清筛选，或换个关键词。</p>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
              )
            })()}
          </div>
        </div>
      </div>
      {editor && canWrite && writeSchema && (
        <ViewRecordDialog
          mode={editor.mode}
          schema={writeSchema}
          schemas={schemas}
          labels={overview?.labels ?? {}}
          initial={editor.row}
          onClose={() => setEditor(null)}
          onSaved={async () => {
            await onRefresh()
            if (active) await run(filters)
          }}
          onDeleted={editor.mode === "edit" ? async () => {
            await onRefresh()
            if (active) await run(filters)
          } : undefined}
        />
      )}
      {!!pendingDeleteId && (
        <div className="view-record-mask" onClick={() => setPendingDeleteId("")}>
          <div className="view-record-dialog max-w-sm" onClick={(event) => event.stopPropagation()}>
            <h2 className="text-lg font-semibold tracking-tight">删除这条记录？</h2>
            <p className="mt-2 text-sm text-muted-foreground">被其他行引用时可能失败；删除后不可恢复。</p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="h-10 rounded-xl border border-border px-4 text-sm" onClick={() => setPendingDeleteId("")}>取消</button>
              <button
                type="button"
                className="h-10 rounded-xl bg-destructive px-4 text-sm font-medium text-destructive-foreground"
                onClick={async () => {
                  const id = pendingDeleteId
                  setPendingDeleteId("")
                  try {
                    await call("deleteRecord", { id, mode: "clear" })
                    toast.add({ title: "已删除", type: "success" })
                    await onRefresh()
                    if (active) await run(filters)
                  } catch (err) {
                    toast.add({ title: "删除失败", description: String(err instanceof Error ? err.message : err), type: "error" })
                  }
                }}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function ViewEmptyStage({ kind, onPrimary, onSecondary, onTertiary, onRefresh, onInstalled }: {
  kind: "no-tables" | "no-views"
  onPrimary: () => void
  onSecondary: () => void
  onTertiary?: () => void
  onRefresh?: () => Promise<void>
  onInstalled?: (viewId?: string) => Promise<void> | void
}) {
  const { call, resolveAssetUrl } = useApp()
  const [modules, setModules] = useState<ModuleInfo[]>([])
  const [loadingModules, setLoadingModules] = useState(kind === "no-tables")
  const [modulesError, setModulesError] = useState("")
  const [includeSamples, setIncludeSamples] = useState<Record<string, boolean>>({})
  const [installingId, setInstallingId] = useState("")
  const illu = kind === "no-tables"
    ? viewIllustrationAsset("files", "empty-tables")
    : viewIllustrationAsset("filter", "empty-views")
  const title = kind === "no-tables" ? "按照工作场景一键安装" : "让我们设计一些数据视图吧"
  const lede = kind === "no-tables"
    ? "下方是内置的常见场景预置的数据表和视图模板，安装后可直接开始使用。也可以空白建表，或导入已有的 .caskpack。"
    : "勾选要展示与筛选的列，首页就会变成只读查数台。也支持快捷筛选、多级排序与插画。"

  useEffect(() => {
    if (kind !== "no-tables") return
    let alive = true
    setLoadingModules(true)
    setModulesError("")
    call<{ modules: ModuleInfo[]; debug?: Record<string, unknown> }>("listModules")
      .then((res) => {
        if (!alive) return
        const list = Array.isArray(res?.modules) ? res.modules : Array.isArray(res) ? res as unknown as ModuleInfo[] : []
        setModules(list)
        // Default on when the pack ships samples — user can chip-toggle off
        setIncludeSamples(Object.fromEntries(list.map((item) => [item.id, !!item.hasSamples])))
        if (!list.length && res?.debug) {
          setModulesError("未找到模块（appDir=" + String(res.debug.appDir ?? "?") + (res.debug.diskError ? "；disk: " + String(res.debug.diskError) : "") + "）")
        }
      })
      .catch((err) => {
        if (!alive) return
        setModules([])
        setModulesError(String(err instanceof Error ? err.message : err))
      })
      .finally(() => {
        if (alive) setLoadingModules(false)
      })
    return () => { alive = false }
  }, [kind])

  async function installModule(mod: ModuleInfo) {
    if (installingId) return
    setInstallingId(mod.id)
    try {
      const result = await call<{
        primaryViewId?: string
        created?: { schemas: number; views: number; samples: number }
        title?: string
      }>("installModule", {
        id: mod.id,
        includeSamples: !!includeSamples[mod.id] && mod.hasSamples,
        conflict: "skip",
      })
      const created = result?.created
      const bits = [
        created?.schemas ? created.schemas + " 张表" : "",
        created?.views ? created.views + " 个视图" : "",
        created?.samples ? created.samples + " 条示例" : "",
      ].filter(Boolean)
      toast.add({
        title: "已安装「" + (result?.title || mod.title) + "」",
        description: bits.length ? bits.join(" · ") : "同名表已复用",
        type: "success",
      })
      await onInstalled?.(result?.primaryViewId || undefined)
    } catch (err) {
      toast.add({ title: "安装失败", description: String(err instanceof Error ? err.message : err), type: "error" })
    } finally {
      setInstallingId("")
    }
  }

  const caps = kind === "no-tables"
    ? [
        { t: "空白手账", d: "自己建表与字段", action: "去建表", onClick: onPrimary },
        { t: "导入包", d: "文件 / 文本 / .caskpack", action: "去导入", onClick: onSecondary },
      ]
    : [
        { t: "列与筛选", d: "显示 / 搜索 / 排序", action: "去建视图", onClick: onPrimary },
        { t: "继续建表", d: "补字段或新表", action: "去建表", onClick: onSecondary },
        { t: "导入", d: "灌数或复刻包", action: "去导入", onClick: onTertiary || onSecondary },
      ]

  return (
    <section className="view-empty">
      <div className="view-empty-inner">
        <div className="view-empty-hero">
          <div className="view-empty-illu">
            <img src={resolveAssetUrl(illu.path)} alt="" />
          </div>
          <div className="view-empty-copy">
            <p className="view-empty-kicker">{kind === "no-tables" ? "HOME · SCENES" : "HOME · VIEWS"}</p>
            <h1>{title}</h1>
            <p className="view-empty-lede">{lede}</p>
            {kind !== "no-tables" && (
              <div className="view-empty-actions">
                <button type="button" className="h-10 rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground" onClick={onPrimary}>
                  去建视图
                </button>
                <button type="button" className="h-10 rounded-xl border border-border bg-card px-4 text-sm" onClick={onSecondary}>去建表</button>
                {onTertiary && <button type="button" className="h-10 rounded-xl border border-border bg-card px-4 text-sm" onClick={onTertiary}>导入</button>}
              </div>
            )}
          </div>
        </div>

        {kind === "no-tables" && (
          <div className="view-empty-modules">
            <p className="view-empty-modules-label">工作场景</p>
            {loadingModules && <p className="view-empty-modules-hint">正在读取 modules…</p>}
            {!loadingModules && modulesError && (
              <p className="view-empty-modules-hint" style={{ color: "var(--destructive, #b91c1c)" }}>加载模块失败：{modulesError}</p>
            )}
            {!loadingModules && !modules.length && !modulesError && (
              <p className="view-empty-modules-hint">还没有内置模块。把 .caskpack.json 放到应用的 modules/ 目录即可出现在这里。</p>
            )}
            <div className={"view-empty-module-grid" + (modules.length === 1 ? " is-one" : modules.length === 2 ? " is-two" : "")}>
              {modules.map((mod) => {
                const busy = installingId === mod.id
                const blurb = (mod.description || "").split(/[。.!？?]/)[0]?.trim() || mod.title
                const meta = [
                  mod.schemaNames.length ? mod.schemaNames.length + " 张表" : "",
                  mod.viewNames.length ? mod.viewNames.length + " 个视图" : "",
                ].filter(Boolean).join(" · ")
                const sampleOn = !!includeSamples[mod.id]
                return (
                  <div key={mod.id} className={"view-empty-module" + (mod.recommended ? " is-recommended" : "") + (mod.installed ? " is-installed" : "") + (busy ? " is-busy" : "")}>
                    <div className="view-empty-module-copy">
                      <div className="view-empty-module-title-row">
                        <strong>{mod.title}</strong>
                        {mod.recommended && !mod.installed && <span className="view-empty-module-tag">推荐</span>}
                        {mod.installed && <span className="view-empty-module-tag is-soft">已装</span>}
                      </div>
                      <span>{blurb}</span>
                      {meta && <span className="view-empty-module-meta">{meta}</span>}
                    </div>
                    <div className="view-empty-module-foot">
                      {mod.hasSamples ? (
                        <button
                          type="button"
                          className={"view-empty-module-chip" + (sampleOn ? " is-on" : "")}
                          disabled={!!installingId}
                          aria-pressed={sampleOn}
                          onClick={() => setIncludeSamples((prev) => ({ ...prev, [mod.id]: !prev[mod.id] }))}
                        >
                          {sampleOn ? <Icon.Check size={12} strokeWidth={2.6} /> : <Icon.Sparkles size={12} strokeWidth={2.2} />}
                          <span>示例数据</span>
                        </button>
                      ) : <span />}
                      <button
                        type="button"
                        className="view-empty-module-go"
                        disabled={!!installingId}
                        onClick={() => void installModule(mod)}
                      >
                        <span>{busy ? "安装中" : mod.installed ? "再次安装" : "安装场景"}</span>
                        {!busy && <Icon.ArrowRight size={15} strokeWidth={2.2} />}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div className={"view-empty-caps" + (caps.length <= 2 ? " is-two" : "")}>
          {caps.map((item) => (
            <button key={item.t} type="button" className="view-empty-cap" onClick={item.onClick}>
              <strong>{item.t}</strong>
              <span>{item.d}</span>
              <em>{item.action} →</em>
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

function ViewBuilder({ schemas, views, counts, focusViewId, onGoData, onGoImport, onSaved }: { schemas: SchemaRow[]; views: ViewDef[]; counts: Record<string, number>; focusViewId?: string; onGoData: () => void; onGoImport: () => void; onSaved: () => Promise<void> }) {
  const { call, resolveAssetUrl } = useApp()
  const [editing, setEditing] = useState(() => (focusViewId && views.some((item) => item.id === focusViewId) ? focusViewId : views[0]?.id ?? ""))
  const [creating, setCreating] = useState(!views.length && !focusViewId)
  const [openPaths, setOpenPaths] = useState<Record<string, boolean>>({})
  const current = creating ? undefined : views.find((item) => item.id === editing)
  const [name, setName] = useState(current?.name ?? "新增首页视图")
  const [description, setDescription] = useState(current?.description ?? "先筛再复制。需要改字段时，再进数据页。")
  const [illustration, setIllustration] = useState(current?.illustration ?? pickViewIllustration("new"))
  const [schemaId, setSchemaId] = useState(current?.schemaId ?? schemas[0]?.id ?? "")
  const [columns, setColumns] = useState<ViewColumn[]>(current?.columns ?? [])
  const [allowWrite, setAllowWrite] = useState(!!current?.allowWrite)
  const [saving, setSaving] = useState(false)
  const schema = schemas.find((item) => item.id === schemaId)
  const fieldOptions = schema ? flattenViewFields(schema, schemas) : []
  const visibleFields = fieldOptions.filter((field) => {
    if (field.depth === 0) return true
    const parts = field.path.split(".")
    for (let i = 1; i < parts.length; i++) {
      if (!openPaths[parts.slice(0, i).join(".")]) return false
    }
    return true
  })
  useEffect(() => {
    if (creating) return
    if (!views.length) { setCreating(true); setEditing(""); return }
    if (!views.some((item) => item.id === editing)) setEditing(views[0].id)
  }, [views, editing, creating])
  useEffect(() => {
    if (!focusViewId) return
    if (!views.some((item) => item.id === focusViewId)) return
    setCreating(false)
    setEditing(focusViewId)
  }, [focusViewId, views])
  function defaultColumns(target?: SchemaRow) {
    if (!target) return [] as ViewColumn[]
    return flattenViewFields(target, schemas).map((field) => {
      const searchable = field.depth === 0 && field.type !== "secret"
      // nested paths (role.name / system.env.code) or refs → enum suggestions by default
      const suggest = field.type !== "secret" && (field.type === "ref" || field.path.includes("."))
      return {
        key: field.path,
        as: "",
        show: field.depth === 0 && field.type !== "secret",
        search: searchable || suggest,
        sort: field.depth === 0 && field.type !== "secret",
        enum: (searchable || suggest) && suggest,
      }
    })
  }
  function defaultOpenPaths(target?: SchemaRow, cols: ViewColumn[] = []) {
    const open: Record<string, boolean> = {}
    if (target) {
      for (const field of flattenViewFields(target, schemas)) {
        if (field.depth === 0 && field.type === "ref") open[field.path] = true
      }
    }
    for (const col of cols) {
      if (!col.show && !col.search) continue
      const parts = col.key.split(".")
      for (let i = 1; i < parts.length; i++) open[parts.slice(0, i).join(".")] = true
    }
    return open
  }
  useEffect(() => {
    if (!current) {
      if (!schemas[0]) return
      setName("新增首页视图")
      setDescription("先筛再复制。需要改字段时，再进数据页。")
      setIllustration(pickViewIllustration("new-" + String(Date.now())))
      setSchemaId(schemas[0].id)
      setColumns(defaultColumns(schemas[0]))
      setAllowWrite(false)
      setOpenPaths(defaultOpenPaths(schemas[0]))
      return
    }
    setName(current.name)
    setDescription(current.description ?? "")
    setIllustration(current.illustration || pickViewIllustration(current.id))
    setSchemaId(current.schemaId)
    setAllowWrite(!!current.allowWrite)
    const target = schemas.find((item) => item.id === current.schemaId)
    const nextColumns = current.columns.length ? current.columns : defaultColumns(target)
    setColumns(nextColumns)
    setOpenPaths(defaultOpenPaths(target, nextColumns))
  }, [current?.id, current?.updatedAt, creating])
  useEffect(() => {
    if (!schema) return
    setColumns((prev) => {
      const byKey = new Map(prev.map((item) => [item.key, item]))
      return flattenViewFields(schema, schemas).map((field) => {
        const old = byKey.get(field.path)
        if (old) return { ...old, search: field.type === "secret" ? false : old.search, enum: field.type === "secret" ? false : !!old.search && !!old.enum }
        return { key: field.path, as: "", show: false, search: false, sort: false, enum: false }
      })
    })
  }, [schemaId])
  async function save() {
    if (saving) return
    setSaving(true)
    try {
      const saved = await call<{ id: string }>("saveView", { id: creating ? undefined : editing || undefined, name, description, illustration, schemaId, columns, allowWrite })
      setCreating(false)
      setEditing(saved.id)
      await onSaved()
      toast.add({ title: "视图已保存", description: name.trim() || "未命名视图", type: "success" })
    } catch (err) {
      toast.add({ title: "保存失败", description: String(err instanceof Error ? err.message : err), type: "error" })
    } finally {
      setSaving(false)
    }
  }
  useSaveHotkey(() => save(), !saving)
  async function remove() {
    if (creating || !editing || saving) return
    try {
      await call("deleteView", { id: editing })
      setCreating(true)
      setEditing("")
      await onSaved()
      toast.add({ title: "视图已删除", type: "success" })
    } catch (err) {
      toast.add({ title: "删除失败", description: String(err instanceof Error ? err.message : err), type: "error" })
    }
  }
  function create() {
    setCreating(true)
    setEditing("")
    setName("新增首页视图")
    setDescription("先筛再复制。需要改字段时，再进数据页。")
    setIllustration(pickViewIllustration("new-" + String(Date.now())))
    setSchemaId(schemas[0]?.id ?? "")
    setColumns(defaultColumns(schemas[0]))
    setAllowWrite(false)
    setOpenPaths(defaultOpenPaths(schemas[0]))
  }
  if (!schemas.length) {
    return <ViewEmptyStage kind="no-tables" onPrimary={onGoData} onSecondary={onGoImport} />
  }
  // has tables: builder can create views directly
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
      <aside className="flex h-full min-h-0 w-[268px] shrink-0 flex-col overflow-hidden border-r border-border bg-card/40 px-4 py-7">
        <p className="mb-4 px-2 text-xs tracking-[0.18em] text-muted-foreground">构建</p>
        <div className="min-h-0 flex-1 space-y-2 overflow-auto">
          {views.map((item) => {
            const illu = viewIllustrationAsset(item.illustration, item.id)
            return (
              <ViewRailCard
                key={item.id}
                on={!creating && item.id === editing}
                name={item.name}
                {...viewRelatedTables(item, schemas)}
                rows={counts[item.schemaId] ?? 0}
                illuUrl={resolveAssetUrl(illu.path)}
                onClick={() => { setCreating(false); setEditing(item.id) }}
              />
            )
          })}
          {!views.length && !creating && (
            <div className="mb-2 rounded-2xl border border-dashed border-border bg-card/60 px-3 py-4 text-center">
              <p className="text-sm font-medium">还没有视图</p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">勾选列与筛选，首页即可查数</p>
            </div>
          )}
          <button className={"w-full rounded-xl border border-dashed px-2.5 py-2.5 text-left text-sm " + (creating ? "border-border bg-card text-foreground shadow-sm" : "border-border text-muted-foreground hover:bg-secondary")} onClick={create}>新建视图</button>
        </div>
      </aside>
      <div className="h-full min-h-0 min-w-0 flex-1 overflow-auto px-10 py-8">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-xs tracking-[0.2em] text-muted-foreground">视图构建</p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight">设计首页报表</h2>
          </div>
          <p className="pb-0.5 text-xs text-muted-foreground">不改数据 · 预览即首页</p>
        </div>

        {(() => {
          const previewIllu = viewIllustrationAsset(illustration, editing || name || "preview")
          const previewRows = counts[schemaId] ?? 0
          const previewShortcuts = current?.shortcuts ?? []
          return (
            <div className="view-builder-hero mt-5 overflow-visible">
              <div className="view-mast w-full overflow-visible">
                <div className="view-mast-title min-w-0">
                  <div className="view-mast-copy">
                    <p className="invisible text-xs tracking-[0.2em] text-muted-foreground" aria-hidden="true">只读 · 来自占位</p>
                    <input
                      className="mt-2 w-full border-0 bg-transparent text-3xl font-medium tracking-tight text-foreground outline-none placeholder:text-muted-foreground/50"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder="视图名称"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                    <input
                      className="mt-2 w-full border-0 bg-transparent text-sm leading-relaxed text-muted-foreground outline-none placeholder:text-muted-foreground/50"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder="说明，显示在首页标题下方"
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                    />
                  </div>
                  <div className="view-mast-shortcuts pointer-events-none select-none opacity-45" aria-hidden="true">
                    <span className="view-chip view-chip-muted">全部</span>
                    {previewShortcuts.map((item) => (
                      <span key={item.id} className="view-chip view-chip-muted max-w-[180px] truncate">{item.name}</span>
                    ))}
                    <span className="view-chip view-chip-muted-dash">
                      <Icon.Plus size={11} />
                      存为快捷
                    </span>
                  </div>
                </div>
                <div className="view-mast-gap" aria-hidden="true" />
                <div className="view-mast-illu" aria-hidden="true">
                  <img src={resolveAssetUrl(previewIllu.path)} alt="" />
                </div>
                <div className="view-mast-seal">
                  <div className="view-stamp grid h-[116px] w-[116px] place-items-center rounded-[28px] border border-border">
                    <div className="text-center">
                      <p className="text-[10px] tracking-[0.22em] text-muted-foreground">VIEW</p>
                      <strong className="mt-1 block text-[28px] font-medium tracking-tight leading-none">{previewRows}<span className="text-lg text-muted-foreground">/{previewRows}</span></strong>
                      <p className="mt-1.5 text-[10px] tracking-[0.18em] text-muted-foreground">MATCH</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )
        })()}

        <div className="view-builder-panel mt-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] tracking-[0.16em] text-muted-foreground">插画</p>
              <p className="mt-0.5 text-sm text-foreground/80">选一张气质图，首页列表与标题都会用到</p>
            </div>
          </div>
          <div className="view-illu-bar mt-3">
            {VIEW_ILLUSTRATIONS.map((item) => {
              const on = illustration === item.id
              return (
                <button key={item.id} type="button" className={on ? "is-on" : ""} onClick={() => setIllustration(item.id)}>
                  <div className="thumb"><img src={resolveAssetUrl("./assets/illu/" + item.file)} alt="" /></div>
                  <span>{item.label}</span>
                </button>
              )
            })}
          </div>
        </div>

        <div className="view-builder-panel mt-5 grid gap-4 md:grid-cols-2">
          <div className="flex min-w-0 items-center gap-4">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] tracking-[0.16em] text-muted-foreground">数据来源</p>
              <p className="mt-0.5 text-sm text-foreground/80">这张视图从哪张表读行</p>
            </div>
            <div className="w-[min(200px,42%)] shrink-0">
              <AppSelect height={40} value={schemaId} allowEmpty={false} onChange={(value) => { setSchemaId(value); setOpenPaths(defaultOpenPaths(schemas.find((item) => item.id === value))) }} options={schemas.map((item) => ({ value: item.id, label: item.name }))} />
            </div>
          </div>
          <div className="flex min-w-0 items-center gap-4 border-t border-border pt-4 md:border-l md:border-t-0 md:pl-4 md:pt-0">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] tracking-[0.16em] text-muted-foreground">首页操作</p>
              <p className="mt-0.5 text-sm text-foreground/80">在首页表格显示新增 / 编辑 / 删除</p>
            </div>
            <label className="inline-flex shrink-0 cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={allowWrite} onCheckedChange={(checked) => setAllowWrite(!!checked)} />
              <span>允许写入</span>
            </label>
          </div>
        </div>

        <div className="view-builder-fields mt-5 w-full overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
            <div>
              <p className="text-[11px] tracking-[0.16em] text-muted-foreground">字段</p>
              <p className="mt-0.5 text-sm text-foreground/80">勾选显示与搜索列</p>
            </div>
          </div>
          <div className="grid grid-cols-[1.4fr_1fr_56px_56px_56px_56px] gap-2 border-b border-border bg-secondary/30 px-5 py-2.5 text-[11px] tracking-[0.14em] text-muted-foreground"><span>字段</span><span>显示为</span><span className="text-center">显示</span><span className="text-center">搜索</span><span className="text-center" title="搜索时提供枚举建议">枚举</span><span className="text-center">排序</span></div>
          {visibleFields.map((field) => {
            const col = columns.find((item) => item.key === field.path) ?? { key: field.path, as: "", show: false, search: false, sort: false, enum: false }
            const secret = field.type === "secret"
            const leaf = field.path.split(".").at(-1) ?? field.path
            const hasChildren = fieldOptions.some((item) => item.path.startsWith(field.path + ".") && item.depth === field.depth + 1)
            const opened = !!openPaths[field.path]
            function ensure(prev: ViewColumn[]) {
              return prev.some((item) => item.key === field.path) ? prev : [...prev, { key: field.path, as: "", show: false, search: false, sort: false, enum: false }]
            }
            return (
              <div key={field.path} className="grid grid-cols-[1.4fr_1fr_56px_56px_56px_56px] items-center gap-2 border-b border-border px-5 py-3 last:border-0 hover:bg-secondary/20">
                <span className="flex min-w-0 items-center gap-2" style={{ paddingLeft: field.depth * 20 }}>
                  {hasChildren ? (
                    <button type="button" className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-secondary" aria-label={opened ? "收起" : "展开"} onClick={() => setOpenPaths((prev) => ({ ...prev, [field.path]: !prev[field.path] }))}>
                      {opened ? <Icon.ChevronDown size={14} /> : <Icon.ChevronRight size={14} />}
                    </button>
                  ) : <span className="w-6 shrink-0" />}
                  <span className="min-w-0">
                    <b className="block truncate text-sm leading-5">{leaf}</b>
                    <span className="mt-0.5 block truncate text-[11px] leading-4 text-muted-foreground">{field.note}</span>
                  </span>
                </span>
                <input className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus:border-foreground/30" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder={leaf} value={col.as} onChange={(event) => setColumns((prev) => ensure(prev).map((item) => item.key === field.path ? { ...item, as: event.target.value } : item))} />
                <div className="flex justify-center">
                  <Checkbox checked={col.show} onCheckedChange={(checked) => setColumns((prev) => ensure(prev).map((item) => item.key === field.path ? { ...item, show: !!checked, sort: checked ? item.sort : false } : item))} />
                </div>
                <div className="flex justify-center">
                  <Checkbox disabled={secret} checked={!secret && col.search} onCheckedChange={(checked) => setColumns((prev) => ensure(prev).map((item) => item.key === field.path ? { ...item, search: !!checked, enum: checked ? item.enum : false } : item))} />
                </div>
                <div className="flex justify-center">
                  <Checkbox disabled={secret || !col.search} checked={!secret && !!col.search && !!col.enum} onCheckedChange={(checked) => setColumns((prev) => ensure(prev).map((item) => item.key === field.path ? { ...item, enum: !!checked, search: checked ? true : item.search } : item))} />
                </div>
                <div className="flex justify-center">
                  <Checkbox disabled={secret || !col.show} checked={!secret && col.show && !!col.sort} onCheckedChange={(checked) => setColumns((prev) => ensure(prev).map((item) => item.key === field.path ? { ...item, sort: !!checked } : item))} />
                </div>
              </div>
            )
          })}
        </div>

        <div className="mt-6 flex w-full items-center justify-between gap-4">
          <p className="text-xs leading-relaxed text-muted-foreground">有箭头的是关联字段。显示 / 搜索 / 枚举 / 排序：列、筛选、可输入下拉建议、表头排序。</p>
          <div className="flex shrink-0 gap-2">
            {!creating && editing && <button className="h-10 rounded-xl px-4 text-sm text-muted-foreground hover:bg-secondary hover:text-destructive disabled:opacity-40" disabled={saving} onClick={() => remove()}>删除</button>}
            <button className="inline-flex h-10 items-center gap-2 rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground shadow-sm disabled:opacity-60" disabled={saving} onClick={() => save()}>
              {saving ? <Icon.Loader2 size={15} className="animate-spin" /> : null}
              {saving ? "保存中…" : "保存视图"}
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

function moveId(ids: string[], fromId: string, toId: string) {
  if (fromId === toId) return ids
  const next = [...ids]
  const from = next.indexOf(fromId)
  const to = next.indexOf(toId)
  if (from < 0 || to < 0) return ids
  next.splice(from, 1)
  next.splice(to, 0, fromId)
  return next
}

function ListSearch({ title, count, value, onChange, sortMode, onToggleSort, canSort }: { title: string; count: number; icon?: ReactNode; value: string; onChange: (q: string) => void; sortMode?: boolean; onToggleSort?: () => void; canSort?: boolean }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState("")
  const [tick, setTick] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const root = useRef<HTMLElement>(null)
  const prevCount = useRef(count)
  const parsed = parseQuery(value)
  const words = parsed.text.split(/\s+/).filter(Boolean)
  const hasFilters = !!(parsed.table || parsed.tag || parsed.cites || words.length)

  useEffect(() => {
    if (prevCount.current === count) return
    prevCount.current = count
    setTick(true)
    const timer = window.setTimeout(() => setTick(false), 420)
    return () => window.clearTimeout(timer)
  }, [count])

  useEffect(() => {
    if (!open) setDraft(parsed.text)
  }, [value, open, parsed.text])

  useEffect(() => {
    if (open) input.current?.focus()
  }, [open])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  function close() {
    setOpen(false)
    setDraft(parsed.text)
  }

  function applyDraft(nextText?: string) {
    const text = (nextText ?? draft).trim()
    onChange(formatQuery({ ...parsed, text }))
    setOpen(false)
  }

  function clearAll() {
    onChange(formatQuery({ table: "", tag: "", cites: "", text: "" }))
    setDraft("")
    setOpen(false)
  }

  const sub = parsed.cites
    ? "来自 " + parsed.cites + " 的引用"
    : parsed.tag
      ? "标签 " + parsed.tag
      : words.length
        ? "关键词 " + words.join(" ")
        : "全部记录"

  const chips = [
    parsed.table ? { key: "table", lab: "表", val: parsed.table, cite: false, next: formatQuery({ ...parsed, table: "" }) } : null,
    parsed.cites ? { key: "cites", lab: "引用", val: parsed.cites, cite: true, next: formatQuery({ ...parsed, cites: "" }) } : null,
    parsed.tag ? { key: "tag", lab: "标签", val: parsed.tag, cite: false, next: formatQuery({ ...parsed, tag: "" }) } : null,
    ...words.map((word, index) => ({
      key: "text-" + index,
      lab: "词",
      val: word,
      cite: false,
      next: formatQuery({ ...parsed, text: words.filter((_, item) => item !== index).join(" ") }),
    })),
  ].filter((item) => item !== null)

  return (
    <header ref={root} className={"list-head-r1 " + (open ? "is-seek " : "") + (tick ? "is-count-tick" : "")}>
      <div className="list-head-mast">
        <div className="list-head-seal" aria-hidden="true">
          <span className="list-head-seal-ring" />
          <span className="list-head-seal-ring list-head-seal-ring-dashed" />
          <span className="list-head-seal-core">
            <span className="list-head-seal-num">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.b
                  key={count}
                  initial={{ opacity: 0, y: 8, scale: 0.86, filter: "blur(3px)" }}
                  animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
                  exit={{ opacity: 0, y: -8, scale: 0.9, filter: "blur(2px)" }}
                  transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                >
                  {count}
                </motion.b>
              </AnimatePresence>
            </span>
            <small>HIT</small>
          </span>
        </div>
        <div className="list-head-id min-w-0 flex-1">
          <p className="list-head-eyebrow">{sortMode ? "SORT" : "TABLE"}</p>
          <h3 className="list-head-title">{title || "记录"}</h3>
          <p className="list-head-sub">{sortMode ? "拖动手柄调整顺序" : sub}</p>
        </div>
        <div className="list-head-actions">
          {canSort && onToggleSort && (
            <button
              type="button"
              className={"list-head-fab " + (sortMode ? "is-on" : "")}
              aria-label={sortMode ? "完成排序" : "排序"}
              title={sortMode ? "完成排序" : "拖拽排序"}
              onClick={onToggleSort}
            >
              {sortMode ? <Icon.Check size={16} /> : <Icon.ArrowUpDown size={16} />}
            </button>
          )}
          <button
            type="button"
            className="list-head-fab list-head-fab-seek"
            aria-label={open ? "关闭搜索" : "搜索"}
            title={open ? "关闭" : "搜索 (/)"}
            onClick={() => open ? close() : setOpen(true)}
          >
            {open ? <Icon.X size={16} /> : <Icon.Search size={16} />}
          </button>
        </div>
      </div>

      <div className="list-head-drawer">
        <div className="list-head-drawer-clip">
          <div className="list-head-drawer-inner">
            <div className="list-head-field">
              <Icon.Search size={15} className="shrink-0 text-muted-foreground" />
              <input
                ref={input}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="在当前结果中找…"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault()
                    close()
                  }
                  if (event.key === "Enter") {
                    event.preventDefault()
                    applyDraft()
                  }
                }}
              />
              <button type="button" className="list-head-done" onClick={() => applyDraft()}>完成</button>
            </div>
          </div>
        </div>
      </div>

      {hasFilters && (
        <div className="list-head-filters">
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className={"list-fchip " + (chip.cite ? "is-cite" : "")}
              onClick={() => onChange(chip.next)}
              title="移除条件"
            >
              <span className="list-fchip-lab">{chip.lab}</span>
              <span className="list-fchip-val">{chip.val}</span>
              <span className="list-fchip-x" aria-hidden="true"><Icon.X size={11} /></span>
            </button>
          ))}
          <button type="button" className="list-head-clear" onClick={() => clearAll()}>清除</button>
        </div>
      )}
    </header>
  )
}

function ago(ts: number) {
  if (!ts) return ""
  const delta = Date.now() - ts
  if (delta < 60_000) return "刚刚"
  if (delta < 3_600_000) return Math.floor(delta / 60_000) + " 分钟前"
  if (delta < 86_400_000) return Math.floor(delta / 3_600_000) + " 小时前"
  return new Date(ts).toLocaleDateString()
}

function DataDesk(props: {
  schemas: SchemaRow[]
  counts: Record<string, number>
  tags: Record<string, number>
  recent: DataRow[]
  views: ViewDef[]
  rows: DataRow[]
  schemaId: string
  tag: string
  q: string
  selected?: DataRow
  hits: { recordId: string; schemaId: string; schemaName: string; field: string; name: string }[]
  schemasAll: SchemaRow[]
  labels: Record<string, string>
  onSchema: (id: string) => void
  onTag: (id: string) => void
  onQuery: (q: string) => void
  onOpen: (id: string) => void
  onCite: (id: string, tableName: string) => void
  onCiteGroup: (id: string, tableName: string) => void
  onBuild: (schema: SchemaRow) => void
  onDropSchema: (schema: SchemaRow) => void
  onCreate: () => void
  onImport: () => void
  onViews: () => void
  onOpenView: (id: string) => void
  onEditView: (id: string) => void
  onClose: () => void
  onDelete: () => void
  onSave: (data: Record<string, string>, tags: string[]) => Promise<void>
  onSaveAsNew: (data: Record<string, string>, tags: string[]) => Promise<void>
  onReorderSchemas: (ids: string[]) => Promise<void>
  onReorderRecords: (ids: string[]) => Promise<void>
  onAdd: () => void
}) {
  const schema = props.schemas.find((item) => item.id === props.selected?.schemaId)
  const activeSchema = props.schemaId === "all" ? undefined : props.schemas.find((item) => item.id === props.schemaId)
  const [schemaSortMode, setSchemaSortMode] = useState(false)
  const [rowSortMode, setRowSortMode] = useState(false)
  const [dragSchemaId, setDragSchemaId] = useState("")
  const [dragRowId, setDragRowId] = useState("")
  const parsedQ = parseQuery(props.q)
  const canSortRows = props.schemaId !== "all" && props.tag === "all" && !parsedQ.table && !parsedQ.tag && !parsedQ.cites && !parsedQ.text.trim()
  useEffect(() => {
    setRowSortMode(false)
    setDragRowId("")
  }, [props.schemaId, props.tag, props.q])
  useEffect(() => {
    if (!canSortRows) setRowSortMode(false)
  }, [canSortRows])

  async function dropSchemaOn(targetId: string) {
    if (!dragSchemaId || dragSchemaId === targetId) return
    const ids = moveId(props.schemas.map((item) => item.id), dragSchemaId, targetId)
    setDragSchemaId("")
    await props.onReorderSchemas(ids)
  }
  async function dropRowOn(targetId: string) {
    if (!dragRowId || dragRowId === targetId) return
    const ids = moveId(props.rows.map((item) => item.id), dragRowId, targetId)
    setDragRowId("")
    await props.onReorderRecords(ids)
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
      <aside className="flex h-full min-h-0 w-[250px] shrink-0 flex-col gap-1 overflow-auto border-r border-border bg-card px-3 py-4">
        <div className="mb-0.5 flex items-center justify-between gap-2 px-2">
          <p className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">{schemaSortMode ? "拖表排序" : "表"}</p>
          <button
            type="button"
            className={"nav-sort-toggle " + (schemaSortMode ? "is-on" : "")}
            title={schemaSortMode ? "完成表排序" : "拖拽排序表"}
            aria-label={schemaSortMode ? "完成表排序" : "排序表"}
            onClick={() => setSchemaSortMode((v) => !v)}
          >
            {schemaSortMode ? <Icon.Check size={14} /> : <Icon.ArrowUpDown size={14} />}
          </button>
        </div>
        {!schemaSortMode && (
          <NavRow icon={<Icon.Layers size={16} />} label="全部" count={Object.values(props.counts).reduce((sum, n) => sum + n, 0)} on={props.schemaId === "all"} onClick={() => props.onSchema("all")} />
        )}
        {props.schemas.map((item) => (
          schemaSortMode ? (
            <div
              key={item.id}
              className={"nav-sort-row " + (dragSchemaId === item.id ? "is-dragging" : "")}
              draggable
              onDragStart={(event) => {
                setDragSchemaId(item.id)
                event.dataTransfer.effectAllowed = "move"
                try { event.dataTransfer.setData("text/plain", item.id) } catch { /* ignore */ }
              }}
              onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move" }}
              onDrop={(event) => { event.preventDefault(); dropSchemaOn(item.id) }}
              onDragEnd={() => setDragSchemaId("")}
            >
              <span className="nav-sort-grip" aria-hidden="true"><Icon.GripVertical size={14} /></span>
              <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
              <span className="text-xs text-muted-foreground">{props.counts[item.id] ?? 0}</span>
            </div>
          ) : (
            <NavRow key={item.id} icon={<Icon.Table2 size={16} />} label={item.name} count={props.counts[item.id] ?? 0} on={props.schemaId === item.id} onClick={() => props.onSchema(item.id)} action={<button className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-secondary" aria-label="编辑字段" onClick={() => props.onBuild(item)}><Icon.Pencil size={14} /></button>} />
          )
        ))}
        {!schemaSortMode && (
          <button className="mt-1 flex items-center gap-2 rounded-lg px-2 py-2 text-sm text-muted-foreground hover:bg-secondary" onClick={props.onCreate}><Icon.Plus size={16} />新建表</button>
        )}
        <Separator className="my-3" />
        <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">标签</p>
        <NavRow icon={<Icon.Tag size={16} />} label="全部" on={props.tag === "all"} onClick={() => props.onTag("all")} />
        {Object.entries(props.tags).map(([name, count]) => <NavRow key={name} icon={<Icon.Tag size={16} />} label={name} count={count} on={props.tag === name} onClick={() => props.onTag(name)} />)}
        <Separator className="my-3" />
        <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">最近打开</p>
        {props.recent.map((row) => <NavRow key={row.id} icon={<Icon.Clock size={16} />} label={props.labels[row.id] || labelOf(props.schemas.find((item) => item.id === row.schemaId), row, (id) => props.labels[id])} on={false} onClick={() => props.onOpen(row.id)} />)}
      </aside>
      <section className="flex h-full min-h-0 w-[300px] shrink-0 flex-col overflow-hidden border-r border-border bg-card/80">
        <ListSearch
          title={props.schemaId === "all" ? "全部记录" : props.schemas.find((item) => item.id === props.schemaId)?.name ?? ""}
          count={props.rows.length}
          value={props.q}
          onChange={props.onQuery}
          canSort={canSortRows}
          sortMode={rowSortMode}
          onToggleSort={() => setRowSortMode((v) => !v)}
        />
        <div className={"min-h-0 flex-1 overflow-auto px-2 py-2 " + (rowSortMode ? "is-row-sort" : "")}>
          {props.rows.map((row) => {
            const schemaRow = props.schemas.find((item) => item.id === row.schemaId)
            const title = props.labels[row.id] || labelOf(schemaRow, row, (id) => props.labels[id])
            const schemaName = props.schemas.find((item) => item.id === row.schemaId)?.name
            const on = props.selected?.id === row.id
            const showMeta = props.schemaId === "all" || row.tags.length > 0
            if (rowSortMode) {
              return (
                <div
                  key={row.id}
                  className={"record-row record-row-sort " + (showMeta ? "record-row-meta " : "") + (on ? "is-on " : "") + (dragRowId === row.id ? "is-dragging" : "")}
                  draggable
                  onDragStart={(event) => {
                    setDragRowId(row.id)
                    event.dataTransfer.effectAllowed = "move"
                    try { event.dataTransfer.setData("text/plain", row.id) } catch { /* ignore */ }
                  }}
                  onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move" }}
                  onDrop={(event) => { event.preventDefault(); dropRowOn(row.id) }}
                  onDragEnd={() => setDragRowId("")}
                >
                  <span className="record-row-grip" aria-hidden="true"><Icon.GripVertical size={15} /></span>
                  <span className="record-row-stack">
                    <span className="record-row-main">
                      <b className="record-row-title">{title || "未命名"}</b>
                      <span className="record-row-time">{ago(row.updatedAt)}</span>
                    </span>
                    {showMeta && (
                      <span className="record-row-sub">
                        {row.tags.slice(0, 3).map((tag) => (
                          <span key={tag} className="record-row-tag">{tag}</span>
                        ))}
                      </span>
                    )}
                  </span>
                </div>
              )
            }
            return (
              <button
                key={row.id}
                type="button"
                className={"record-row " + (showMeta ? "record-row-meta " : "") + (on ? "is-on" : "")}
                onClick={() => props.onOpen(row.id)}
              >
                <span className="record-row-main">
                  <b className="record-row-title">{title || "未命名"}</b>
                  <span className="record-row-time">{ago(row.updatedAt)}</span>
                </span>
                {showMeta && (
                  <span className="record-row-sub">
                    {props.schemaId === "all" && (
                      <span className="record-row-table"><Icon.Table2 size={11} />{schemaName}</span>
                    )}
                    {row.tags.slice(0, 3).map((tag) => (
                      <span key={tag} className="record-row-tag">{tag}</span>
                    ))}
                  </span>
                )}
              </button>
            )
          })}
        </div>
        {props.schemaId !== "all" && !rowSortMode && (
          <div className="border-t border-border/70 p-2">
            <button type="button" className="flex h-9 w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border text-sm text-muted-foreground hover:border-foreground/25 hover:bg-secondary hover:text-foreground" onClick={props.onAdd}>
              <Icon.Plus size={14} />新建一行
            </button>
          </div>
        )}
      </section>
      <section className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-card">
        <AnimatePresence initial={false}>
          {props.selected && schema ? (
            <motion.div
              key={props.selected.id}
              className="absolute inset-0 overflow-auto bg-card"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{
                opacity: { duration: 0.22, ease: [0.22, 1, 0.36, 1] },
                y: { duration: 0.28, ease: [0.22, 1, 0.36, 1] },
              }}
            >
              <RecordDetail row={props.selected} schema={schema} schemas={props.schemasAll} labels={props.labels} hits={props.hits} onOpen={props.onOpen} onCite={props.onCite} onCiteGroup={props.onCiteGroup} onClose={() => props.onClose()} onDelete={props.onDelete} onSave={props.onSave} onSaveAsNew={props.onSaveAsNew} />
            </motion.div>
          ) : (
            <motion.div
              key={"desk-" + props.schemaId}
              className="absolute inset-0 overflow-hidden bg-card"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                opacity: { duration: 0.22, ease: [0.22, 1, 0.36, 1] },
                y: { duration: 0.28, ease: [0.22, 1, 0.36, 1] },
              }}
            >
              <DataDeskOverview
                all={props.schemaId === "all"}
                schema={activeSchema}
                schemas={props.schemas}
                counts={props.counts}
                recent={props.recent}
                views={props.views}
                rows={props.rows}
                labels={props.labels}
                onSchema={props.onSchema}
                onOpen={props.onOpen}
                onAdd={props.onAdd}
                onCreate={props.onCreate}
                onBuild={props.onBuild}
                onImport={props.onImport}
                onViews={props.onViews}
                onOpenView={props.onOpenView}
                onEditView={props.onEditView}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </section>
    </div>
  )
}

function DataDeskOverview(props: {
  all: boolean
  schema?: SchemaRow
  schemas: SchemaRow[]
  counts: Record<string, number>
  recent: DataRow[]
  views: ViewDef[]
  rows: DataRow[]
  labels: Record<string, string>
  onSchema: (id: string) => void
  onOpen: (id: string) => void
  onAdd: () => void
  onCreate: () => void
  onBuild: (schema: SchemaRow) => void
  onImport: () => void
  onViews: () => void
  onOpenView: (id: string) => void
  onEditView: (id: string) => void
}) {
  const { resolveAssetUrl } = useApp()
  const totalRecords = Object.values(props.counts).reduce((sum, n) => sum + n, 0)
  const tableCount = props.schemas.length
  const rowCount = props.all ? totalRecords : (props.counts[props.schema?.id ?? ""] ?? props.rows.length)
  const relatedViews = props.all
    ? props.views
    : props.views.filter((item) => item.schemaId === props.schema?.id)
  const recent = props.all
    ? props.recent
    : props.recent.filter((row) => row.schemaId === props.schema?.id)
  const emptyTable = !props.all && rowCount === 0
  const noSchemas = props.all && tableCount === 0

  const title = props.all ? (noSchemas ? "还没有表" : "你的数据图鉴") : (props.schema?.name || "未命名表")
  const lede = props.all
    ? (noSchemas ? "先建一张表，或从文件导入。这里会成为库级入口。" : "还没选中记录。从下面进表，或打开最近用过的行。")
    : (emptyTable ? "表结构已就绪，还没有行。新建一条或导入填充。" : "已进入本表，点中间列表任一行即可编辑。")

  const tiles = props.all
    ? [
        { key: "import", icon: <Icon.Download size={16} />, title: "导入", desc: "文件 / 文本 / 解析器", onClick: props.onImport },
        { key: "schema", icon: <Icon.Plus size={16} />, title: "新建表", desc: "字段、引用、显示名", onClick: props.onCreate },
        { key: "views", icon: <Icon.SwatchBook size={16} />, title: "视图", desc: relatedViews.length ? relatedViews.length + " 个可打开" : "去配置查询视图", onClick: props.onViews },
      ]
    : [
        { key: "add", icon: <Icon.Plus size={16} />, title: emptyTable ? "新建第一行" : "新建一行", desc: "在本表追加记录", onClick: props.onAdd },
        { key: "import", icon: <Icon.Download size={16} />, title: "导入到此", desc: "映射列与引用", onClick: props.onImport },
        { key: "build", icon: <Icon.Pencil size={16} />, title: "编辑结构", desc: (props.schema?.fields.length ?? 0) + " 个字段", onClick: () => { if (props.schema) props.onBuild(props.schema) } },
      ]

  return (
    <div className="desk-overview">
      <div className="desk-overview-inner">
        <p className="desk-overview-kicker">{props.all ? "DATA DESK" : "TABLE"}</p>
        <h1 className="desk-overview-title">{title}</h1>
        <p className="desk-overview-lede">{lede}</p>

        <div className="desk-overview-tiles">
          {tiles.map((tile) => (
            <button key={tile.key} type="button" className="desk-tile" onClick={tile.onClick}>
              <span className="desk-tile-ico">{tile.icon}</span>
              <span className="desk-tile-title">{tile.title}</span>
              <span className="desk-tile-desc">{tile.desc}</span>
            </button>
          ))}
        </div>

        <section className="desk-overview-sec">
          <h2>{props.all ? "按表浏览" : "关联视图"}</h2>
          {props.all ? (
            tableCount ? (
              <div className="desk-table-grid">
                {props.schemas.map((item) => (
                  <button key={item.id} type="button" className="desk-table-card" onClick={() => props.onSchema(item.id)}>
                    <span className="min-w-0">
                      <span className="desk-table-name">{item.name}</span>
                      <span className="desk-table-meta">{item.fields.length} 字段 · {props.counts[item.id] ?? 0} 行</span>
                    </span>
                    <span className="desk-table-n">{props.counts[item.id] ?? 0}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="desk-overview-empty-card">
                <p className="desk-overview-empty-title">还没有表</p>
                <p className="desk-overview-empty-desc">点上方磁贴「新建表」，或从导入带入结构。</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" className="h-8 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground" onClick={props.onCreate}>新建表</button>
                  <button type="button" className="h-8 rounded-lg border border-border px-3 text-xs" onClick={props.onImport}>去导入</button>
                </div>
              </div>
            )
          ) : relatedViews.length ? (
            <div className="desk-view-list">
              {relatedViews.map((item) => {
                const illu = viewIllustrationAsset(item.illustration, item.id)
                const desc = (item.description || "").trim()
                return (
                  <div key={item.id} className="desk-view-row">
                    <span className="view-illu-stamp view-illu-stamp-sm shrink-0">
                      <img src={resolveAssetUrl(illu.path)} alt="" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="desk-view-name">{item.name || "未命名视图"}</span>
                      {!!desc && <span className="desk-view-meta">{desc}</span>}
                    </span>
                    <span className="desk-view-actions">
                      <button
                        type="button"
                        className="desk-view-act"
                        title="在首页查看"
                        aria-label="在首页查看"
                        onClick={() => props.onOpenView(item.id)}
                      >
                        <Icon.Home size={14} />
                      </button>
                      <button
                        type="button"
                        className="desk-view-act"
                        title="编辑视图"
                        aria-label="编辑视图"
                        onClick={() => props.onEditView(item.id)}
                      >
                        <Icon.Pencil size={14} />
                      </button>
                    </span>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="desk-overview-soft">
              <p>还没有基于本表的视图。</p>
              <button type="button" className="mt-3 text-sm font-medium text-foreground underline underline-offset-4" onClick={props.onViews}>去创建视图</button>
            </div>
          )}
        </section>

        <section className="desk-overview-sec">
          <h2>最近打开</h2>
          {recent.length ? (
            <div className="desk-recent-list">
              {recent.map((row) => {
                const schema = props.schemas.find((item) => item.id === row.schemaId)
                const name = props.labels[row.id] || labelOf(schema, row, (id) => props.labels[id]) || "未命名"
                return (
                  <button key={row.id} type="button" className="desk-recent-row" onClick={() => props.onOpen(row.id)}>
                    <span className="desk-recent-name">{name}</span>
                    {props.all && <span className="desk-recent-table">{schema?.name ?? ""}</span>}
                    <span className="desk-recent-ago">{ago(row.updatedAt)}</span>
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="desk-overview-empty-card is-soft">
              <p className="desk-overview-empty-title">{props.all ? "还没有最近打开" : "本表还没有打开记录"}</p>
              <p className="desk-overview-empty-desc">{props.all ? "点开任意一行后，会按时间出现在这里，方便回访。" : "在中间列表打开一行后，这里会留下痕迹。"}</p>
            </div>
          )}
        </section>

        {emptyTable && (
          <div className="desk-overview-banner">
            <p className="font-medium text-foreground">这张表还是空的</p>
            <p className="mt-1 text-sm text-muted-foreground">结构已就绪 · 等待第一条记录</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <button type="button" className="inline-flex h-9 items-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground" onClick={props.onAdd}>新建一行</button>
              <button type="button" className="inline-flex h-9 items-center rounded-xl border border-border bg-card px-4 text-sm" onClick={props.onImport}>导入</button>
            </div>
          </div>
        )}

        {!emptyTable && !noSchemas && (
          <p className="desk-overview-foot">当前范围 {rowCount} 条 · 点列表查看详情</p>
        )}
      </div>
    </div>
  )
}

function NavRow({ icon, label, count, on, onClick, action }: { icon: ReactNode; label: string; count?: number; on: boolean; onClick: () => void; action?: ReactNode }) {
  return (
    <div className={"flex items-center gap-1 rounded-lg px-2 " + (on ? "bg-muted text-foreground" : "text-muted-foreground")}>
      <button className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left text-sm" onClick={onClick}>
        {icon}
        <span className="truncate text-foreground">{label}</span>
      </button>
      {action}
      {count != null && <Badge variant="secondary">{count}</Badge>}
    </div>
  )
}

function TagRow({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState("")
  function add() {
    const next = draft.trim()
    if (next && !tags.includes(next)) onChange([...tags, next])
    setDraft("")
    setAdding(false)
  }
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {tags.map((tag) => (
        <Badge key={tag} variant="secondary">
          {tag}
          <button className="ml-1" aria-label={"去掉 " + tag} onClick={() => onChange(tags.filter((item) => item !== tag))}>×</button>
        </Badge>
      ))}
      {adding ? (
        <input autoFocus className="h-7 w-24 rounded-full border border-border bg-card px-2 text-xs outline-none" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={draft} placeholder="标签" onChange={(event) => setDraft(event.target.value)} onBlur={add} onKeyDown={(event) => { if (event.key === "Enter") add() }} />
      ) : (
        <button className="h-7 rounded-full border border-dashed border-border px-2 text-xs text-muted-foreground" onClick={() => setAdding(true)}>加标签</button>
      )}
    </div>
  )
}

function SecretField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="record-control record-control-secret">
      <input className="min-w-0 flex-1 bg-transparent text-sm outline-none" autoCapitalize="none" autoCorrect="off" spellCheck={false} type={open ? "text" : "password"} value={value} onChange={(event) => onChange(event.target.value)} />
      <button type="button" className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] tracking-[0.06em] text-muted-foreground hover:bg-secondary hover:text-foreground" onClick={() => setOpen(!open)}>{open ? "隐藏" : "显示"}</button>
    </span>
  )
}

function ViewSecretCell({ text, copy, forceOpen = false, label = "密码" }: { text: string; copy: string; forceOpen?: boolean; label?: string }) {
  const [open, setOpen] = useState(false)
  // Global toggle owns the page: when it flips, drop per-cell overrides so none become islands
  useEffect(() => {
    setOpen(false)
  }, [forceOpen])
  const shown = forceOpen || open
  if (!copy && !text) return <span className="text-muted-foreground">—</span>
  return (
    <span className="inline-flex max-w-full items-center gap-1.5">
      <span className={"min-w-0 truncate font-mono text-[13px] tracking-wide " + (shown ? "text-foreground" : "text-muted-foreground")}>
        {shown ? (copy || text) : (text || "••••••")}
      </span>
      <button
        type="button"
        className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] tracking-[0.06em] text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-40"
        disabled={forceOpen}
        onClick={() => setOpen((v) => !v)}
      >
        {shown ? "隐藏" : "显示"}
      </button>
      {!!copy && (
        <button
          type="button"
          className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100"
          aria-label={"复制单元格 " + label}
          onClick={() => void copyText(copy, "已复制单元格", label)}
        >
          <Icon.Copy size={13} />
        </button>
      )}
    </span>
  )
}

function AppSelect({ value, onChange, placeholder = "选择", options, className, allowEmpty = true, emptyLabel, height = 40 }: { value: string; onChange: (value: string) => void; placeholder?: string; options: { value: string; label: string }[]; className?: string; allowEmpty?: boolean; emptyLabel?: string; height?: number }) {
  const empty = "__none__"
  const items = Object.fromEntries([
    ...(allowEmpty ? [[empty, emptyLabel || placeholder] as const] : []),
    ...options.map((item) => [item.value, item.label] as const),
  ])
  const current = value || (allowEmpty ? empty : options[0]?.value || empty)
  return (
    <div className={"box-border w-full overflow-hidden rounded-xl border border-border bg-card " + (className ?? "")} style={{ height }}>
      <Select items={items} value={current} onValueChange={(next) => onChange(next === empty ? "" : String(next ?? ""))}>
        <SelectTrigger className="h-full min-h-0 w-full rounded-xl border-0 bg-transparent px-3 py-0 shadow-none ring-0 focus-visible:border-0 focus-visible:ring-0 data-[size=default]:h-full data-[size=sm]:h-full dark:bg-transparent dark:hover:bg-transparent"><SelectValue placeholder={placeholder} /></SelectTrigger>
        <SelectContent>
          {allowEmpty && <SelectItem value={empty}>{emptyLabel || placeholder}</SelectItem>}
          {options.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  )
}

function FieldBox({ children, height = 40 }: { children: ReactNode; height?: number }) {
  return <div className="box-border flex w-full items-center overflow-hidden rounded-xl border border-border bg-card px-3" style={{ height }}>{children}</div>
}

function CopyButton({ value }: { value: string }) {
  const [done, setDone] = useState(false)
  return (
    <button type="button" aria-label="复制" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-secondary" onClick={() => {
      navigator.clipboard.writeText(value).then(() => { setDone(true); window.setTimeout(() => setDone(false), 1200) }).catch(() => {})
    }}>
      {done ? <Icon.Check size={16} /> : <Icon.Copy size={16} />}
    </button>
  )
}

function SideButton({ on, onClick, label, count }: { on: boolean; onClick: () => void; label: string; count?: number }) {
  return <button className={"flex w-full items-center px-4 py-2 text-left text-sm " + (on ? "bg-muted text-foreground" : "")} onClick={onClick}><span className="flex-1">{label}</span>{count != null && <span className="text-xs text-muted-foreground">{count}</span>}</button>
}

function RecordDetail({ row, schema, schemas, labels, hits, onOpen, onCite, onCiteGroup, onClose, onDelete, onSave, onSaveAsNew }: { row: DataRow; schema: SchemaRow; schemas: SchemaRow[]; labels: Record<string, string>; hits: { recordId: string; schemaId: string; schemaName: string; field: string; name: string }[]; onOpen: (id: string) => void; onCite: (id: string, tableName: string) => void; onCiteGroup: (id: string, tableName: string) => void; onClose: () => void; onDelete: () => void; onSave: (data: Record<string, string>, tags: string[]) => Promise<void>; onSaveAsNew: (data: Record<string, string>, tags: string[]) => Promise<void> }) {
  const [data, setData] = useState(row.data)
  const [tags, setTags] = useState(row.tags)
  const [saving, setSaving] = useState(false)
  const [cloning, setCloning] = useState(false)
  useEffect(() => {
    setData(row.data)
    setTags(row.tags)
    setCloning(false)
  }, [row.id, row.updatedAt])
  const dirty = cloning || JSON.stringify(data) !== JSON.stringify(row.data) || JSON.stringify(tags) !== JSON.stringify(row.tags)
  // Prefer server label index (has ref walk ctx). Live labelOf without records cannot resolve {ref.field}.
  const title = (!dirty && labels[row.id]) || labelOf(schema, { ...row, data }, (id) => labels[id]) || labels[row.id] || "未命名"
  function startClone() {
    // 浅拷贝当前表单；进入副本态，保存时新建 id
    setData({ ...row.data, ...data })
    setTags([...(tags.length ? tags : row.tags)])
    setCloning(true)
  }
  function cancelClone() {
    setData(row.data)
    setTags(row.tags)
    setCloning(false)
  }
  async function save() {
    if (!dirty || saving) return
    setSaving(true)
    try {
      if (cloning) {
        await onSaveAsNew(data, tags)
        toast.add({ title: "已保存为新记录", description: title || "未命名", type: "success" })
      } else {
        await onSave(data, tags)
        toast.add({ title: "记录已保存", description: title || "未命名", type: "success" })
      }
    } catch (err) {
      toast.add({ title: "保存失败", description: String(err instanceof Error ? err.message : err), type: "error" })
    } finally {
      setSaving(false)
    }
  }
  useSaveHotkey(() => save(), dirty && !saving)
  return (
    <div className="px-8 py-8">
      <div className="mx-auto w-full max-w-3xl">
        <div className="record-hero">
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-xs tracking-[0.18em] text-muted-foreground">
                <Icon.Table2 size={14} />{schema.name}
                {cloning ? <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] tracking-normal text-foreground">副本</span> : null}
              </p>
              <h1 className="mt-3 break-words text-3xl font-medium tracking-tight">{title || "未命名"}{cloning ? " · 副本" : ""}</h1>
              <div className="mt-4"><TagRow tags={tags} onChange={setTags} /></div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {!cloning && (
                <button
                  type="button"
                  className="inline-flex h-9 items-center gap-1.5 rounded-xl px-2.5 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
                  title="复制为新记录"
                  onClick={startClone}
                >
                  <Icon.Copy size={14} />
                  复制
                </button>
              )}
              <button
                type="button"
                className="inline-flex h-9 items-center gap-1.5 rounded-xl px-2.5 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
                aria-label="关闭详情"
                title="回到总览"
                onClick={onClose}
              >
                <Icon.X size={14} />
                关闭
              </button>
            </div>
          </div>
          {cloning && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/60 px-3.5 py-2.5 text-sm">
              <p className="text-muted-foreground">正在编辑副本，改完后点保存会<strong className="text-foreground">新建一条</strong>，不改动原记录。</p>
              <button type="button" className="h-8 shrink-0 rounded-lg px-2.5 text-xs text-muted-foreground hover:bg-card hover:text-foreground" onClick={cancelClone}>取消副本</button>
            </div>
          )}
        </div>

        <div className="mt-6">
          <RecordFormFields schema={schema} schemas={schemas} labels={labels} data={data} setData={setData} onOpen={onOpen} />
        </div>

        <div className="mt-5 flex items-center justify-between gap-4">
          {cloning ? (
            <button
              type="button"
              className="h-10 rounded-xl px-3 text-sm text-muted-foreground hover:bg-secondary"
              onClick={cancelClone}
            >
              取消副本
            </button>
          ) : (
            <button
              type="button"
              className="h-10 rounded-xl px-3 text-sm text-muted-foreground hover:bg-secondary hover:text-destructive"
              onClick={onDelete}
            >
              删除记录
            </button>
          )}
          <div className="flex items-center gap-3">
            <p className={"text-xs " + (dirty ? "text-amber-700/80 dark:text-amber-200/80" : "text-muted-foreground")}>
              {saving ? "正在保存…" : cloning ? "保存后将新建记录" : dirty ? "有未保存的修改" : "已与本地同步"}
            </p>
            <button className="inline-flex h-10 items-center gap-2 rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground shadow-sm disabled:opacity-40" disabled={!dirty || saving} onClick={() => save()}>
              {saving ? <Icon.Loader2 size={15} className="animate-spin" /> : null}
              {saving ? "保存中…" : cloning ? "保存为新记录" : "保存"}
            </button>
          </div>
        </div>

        {!cloning && (
          <div className="mt-10">
            <RefHits hits={hits} onOpen={onCite} onGroup={onCiteGroup} />
          </div>
        )}
      </div>
    </div>
  )
}

function RefHits({ hits, onOpen, onGroup }: { hits: { recordId: string; schemaId: string; schemaName: string; field: string; name: string }[]; onOpen: (id: string, tableName: string) => void; onGroup: (id: string, tableName: string) => void }) {
  const groups = new Map<string, typeof hits>()
  for (const hit of hits) {
    const list = groups.get(hit.schemaId) ?? []
    list.push(hit)
    groups.set(hit.schemaId, list)
  }
  const entries = [...groups.entries()]
  const total = hits.length
  function samples(list: typeof hits) {
    const names = list.map((hit) => hit.name).filter(Boolean)
    const unique = [...new Set(names)]
    const head = unique.slice(0, 3)
    const rest = Math.max(0, unique.length - head.length)
    if (!head.length) return "—"
    return head.join(", ") + (rest ? "…" : "")
  }
  return (
    <section className="cite-seal">
      {!total ? (
        <div className="cite-seal-empty">
          <span className="cite-seal-empty-ico"><Icon.Link2 size={16} /></span>
          <div>
            <p className="text-sm font-medium text-foreground">暂无反向引用</p>
            <p className="mt-1 text-xs text-muted-foreground">没有其他行指向这里。</p>
          </div>
        </div>
      ) : (
        <div className="cite-seal-wrap">
          <div className="cite-seal-mark" aria-hidden="true">
            <span className="cite-seal-ring" />
            <span className="cite-seal-ring cite-seal-ring-dashed" />
            <span className="cite-seal-nodes">
              <i /><i /><i /><i />
            </span>
            <span className="cite-seal-core">
              <b>{total}</b>
              <small>LINKS</small>
            </span>
          </div>
          <div className="cite-seal-copy">
            <h2>当前数据有 {total} 处引用</h2>
            <p>以下是引用了当前数据的数据表统计，点击后跳转到引用源。</p>
            <div className="cite-seal-list">
              {entries.map(([schemaId, list]) => (
                <button
                  key={schemaId}
                  type="button"
                  className="cite-seal-item"
                  onClick={() => onGroup(schemaId, list[0].schemaName)}
                  title={"在数据中打开 " + list[0].schemaName}
                >
                  <span className="cite-seal-nm">{list[0].schemaName}</span>
                  <span className="cite-seal-ex">{samples(list)}</span>
                  <span className="cite-seal-ct">{list.length}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function RecordFormFields({ schema, schemas, labels, data, setData, onOpen }: {
  schema: SchemaRow
  schemas: SchemaRow[]
  labels: Record<string, string>
  data: Record<string, string>
  setData: (data: Record<string, string>) => void
  onOpen?: (id: string) => void
}) {
  return (
    <div className="record-fields overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      {schema.fields.map((field) => field.type === "ref" ? null : (
        <div key={field.key} className="grid grid-cols-[132px_minmax(0,1fr)_auto] items-center gap-4 border-b border-border px-5 py-3.5 last:border-0">
          <span className="text-[11px] tracking-[0.14em] text-muted-foreground">{field.key}</span>
          {field.type === "text" ? (
            <textarea className="record-control record-control-area" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={data[field.key] ?? ""} onChange={(event) => setData({ ...data, [field.key]: event.target.value })} />
          ) : field.type === "secret" ? (
            <SecretField value={data[field.key] ?? ""} onChange={(value) => setData({ ...data, [field.key]: value })} />
          ) : field.type === "date" ? (
            <DatePicker className="record-control record-control-picker" {...asDate(data[field.key]) ? { value: asDate(data[field.key]) } : {}} onChange={(value) => setData({ ...data, [field.key]: value ? stampDate(value) : "" })} />
          ) : field.type === "datetime" ? (
            <DateTimePicker className="record-control record-control-picker" {...asDate(data[field.key]) ? { value: asDate(data[field.key]) } : {}} onChange={(value) => setData({ ...data, [field.key]: value ? stampDateTime(value) : "" })} />
          ) : field.type === "time" ? (
            <TimePicker className="record-control record-control-picker" value={data[field.key] ?? ""} onChange={(value) => setData({ ...data, [field.key]: value })} />
          ) : (
            <input className="record-control" type={field.type === "number" ? "number" : "text"} inputMode={field.type === "number" ? "decimal" : undefined} autoCapitalize="none" autoCorrect="off" spellCheck={false} value={data[field.key] ?? ""} onChange={(event) => setData({ ...data, [field.key]: event.target.value })} />
          )}
          <div className="flex w-[76px] shrink-0 items-center justify-end gap-0.5">
            <CopyButton value={data[field.key] ?? ""} />
          </div>
        </div>
      ))}
      <RefFields schema={schema} schemas={schemas} labels={labels} data={data} setData={setData} onOpen={onOpen} />
    </div>
  )
}

function ViewRecordDialog({
  mode,
  schema,
  schemas,
  labels,
  initial,
  onClose,
  onSaved,
  onDeleted,
}: {
  mode: "create" | "edit"
  schema: SchemaRow
  schemas: SchemaRow[]
  labels: Record<string, string>
  initial?: DataRow
  onClose: () => void
  onSaved: () => Promise<void>
  onDeleted?: () => Promise<void>
}) {
  const { call } = useApp()
  const [data, setData] = useState<Record<string, string>>(() => ({ ...(initial?.data ?? {}) }))
  const [tags, setTags] = useState<string[]>(() => [...(initial?.tags ?? [])])
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  useEffect(() => {
    setData({ ...(initial?.data ?? {}) })
    setTags([...(initial?.tags ?? [])])
  }, [initial?.id, initial?.updatedAt, mode])
  const title = mode === "create"
    ? "新增 · " + schema.name
    : (labels[initial?.id ?? ""] || labelOf(schema, initial ? { ...initial, data } : undefined, (id) => labels[id]) || "编辑")
  async function save() {
    if (saving) return
    setSaving(true)
    try {
      if (mode === "create") {
        await call("saveRecord", { schemaId: schema.id, data, tags })
        toast.add({ title: "已新增", type: "success" })
      } else if (initial) {
        await call("saveRecord", { id: initial.id, schemaId: schema.id, data, tags })
        toast.add({ title: "已保存", type: "success" })
      }
      await onSaved()
      onClose()
    } catch (err) {
      toast.add({ title: "保存失败", description: String(err instanceof Error ? err.message : err), type: "error" })
    } finally {
      setSaving(false)
    }
  }
  async function remove() {
    if (!initial || deleting || !onDeleted) return
    if (!window.confirm("删除这条记录？被引用时可能失败。")) return
    setDeleting(true)
    try {
      await call("deleteRecord", { id: initial.id, mode: "clear" })
      toast.add({ title: "已删除", type: "success" })
      await onDeleted()
      onClose()
    } catch (err) {
      toast.add({ title: "删除失败", description: String(err instanceof Error ? err.message : err), type: "error" })
    } finally {
      setDeleting(false)
    }
  }
  useSaveHotkey(() => save(), !saving)
  return (
    <div className="view-record-mask" onClick={onClose}>
      <div className="view-record-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs tracking-[0.16em] text-muted-foreground">{schema.name}</p>
            <h2 className="mt-1 truncate text-xl font-semibold tracking-tight">{title}</h2>
          </div>
          <button type="button" className="grid h-9 w-9 place-items-center rounded-xl text-muted-foreground hover:bg-secondary" aria-label="关闭" onClick={onClose}>
            <Icon.X size={16} />
          </button>
        </div>
        <div className="mt-4"><TagRow tags={tags} onChange={setTags} /></div>
        <div className="mt-4 max-h-[min(60vh,560px)] overflow-auto pr-1">
          <RecordFormFields schema={schema} schemas={schemas} labels={labels} data={data} setData={setData} />
        </div>
        <div className="mt-5 flex items-center justify-between gap-3">
          {mode === "edit" && onDeleted ? (
            <button type="button" className="h-10 rounded-xl px-3 text-sm text-destructive hover:bg-secondary" disabled={deleting || saving} onClick={() => void remove()}>
              {deleting ? "删除中…" : "删除"}
            </button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <button type="button" className="h-10 rounded-xl border border-border px-4 text-sm" disabled={saving || deleting} onClick={onClose}>取消</button>
            <button type="button" className="h-10 rounded-xl bg-foreground px-5 text-sm font-medium text-background disabled:opacity-50" disabled={saving || deleting} onClick={() => void save()}>
              {saving ? "保存中…" : mode === "create" ? "创建" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** When target table T and current row both ref the same parent schema S, keep only T rows whose parent matches the current value. E.g. role.system ↔ account.system. */
function filterRefOptions(field: Field, targetSchema: SchemaRow | undefined, currentSchema: SchemaRow, data: Record<string, string>, rows: DataRow[]) {
  if (!targetSchema || !rows.length) return rows
  const parentLinks: { targetKey: string; currentKey: string; parentId: string }[] = []
  for (const targetField of targetSchema.fields) {
    if (targetField.type !== "ref" || !targetField.schema) continue
    const currentField = currentSchema.fields.find((item) => item.type === "ref" && item.schema === targetField.schema && item.key !== field.key)
    if (!currentField) continue
    const parentId = String(data[currentField.key] ?? "").trim()
    if (!parentId) continue
    parentLinks.push({ targetKey: targetField.key, currentKey: currentField.key, parentId })
  }
  if (!parentLinks.length) return rows
  return rows.filter((row) => parentLinks.every((link) => String(row.data[link.targetKey] ?? "") === link.parentId))
}

function RefFields({ schema, schemas, labels, data, setData, onOpen }: { schema: SchemaRow; schemas: SchemaRow[]; labels: Record<string, string>; data: Record<string, string>; setData: (data: Record<string, string>) => void; onOpen?: (id: string) => void }) {
  const { call } = useApp()
  const [options, setOptions] = useState<Record<string, DataRow[]>>({})
  useEffect(() => {
    const targets = schema.fields.filter((field) => field.type === "ref" && field.schema)
    Promise.all(targets.map(async (field) => {
      const listed = await call<{ rows: DataRow[] }>("records", { schemaId: field.schema })
      return [field.key, listed.rows] as const
    })).then((pairs) => setOptions(Object.fromEntries(pairs)))
  }, [schema.id])
  function setRefValue(field: Field, value: string) {
    const next: Record<string, string> = { ...data, [field.key]: value }
    // Changing a parent ref clears child refs that hang off the same parent schema on the target table
    if (field.schema) {
      for (const other of schema.fields) {
        if (other.key === field.key || other.type !== "ref" || !other.schema) continue
        const target = schemas.find((item) => item.id === other.schema)
        const depends = target?.fields.some((item) => item.type === "ref" && item.schema === field.schema)
        if (depends) next[other.key] = ""
      }
    }
    setData(next)
  }
  return <>
    {schema.fields.filter((field) => field.type === "ref").map((field) => {
      const refId = data[field.key] ?? ""
      const targetSchema = schemas.find((item) => item.id === field.schema)
      const listed = options[field.key] ?? []
      const filtered = filterRefOptions(field, targetSchema, schema, data, listed)
      const parentHint = (() => {
        if (!targetSchema) return ""
        for (const targetField of targetSchema.fields) {
          if (targetField.type !== "ref" || !targetField.schema) continue
          const currentField = schema.fields.find((item) => item.type === "ref" && item.schema === targetField.schema && item.key !== field.key)
          if (!currentField) continue
          if (!String(data[currentField.key] ?? "").trim()) return "先选 " + currentField.key
        }
        return ""
      })()
      return (
        <div key={field.key} className="grid grid-cols-[132px_minmax(0,1fr)_auto] items-center gap-4 border-b border-border px-5 py-3.5 last:border-0">
          <span className="text-[11px] tracking-[0.14em] text-muted-foreground">{field.key}</span>
          <AppSelect
            height={44}
            className="record-control-select"
            value={refId}
            placeholder={parentHint || "空"}
            emptyLabel="空"
            onChange={(value) => setRefValue(field, value)}
            options={filtered.map((row) => ({
              value: row.id,
              // Prefer server label index (nested display templates need full record walk)
              label: labels[row.id] || labelOf(targetSchema, row, (id) => labels[id]) || row.id,
            }))}
          />
          <div className="flex w-[76px] shrink-0 items-center justify-end gap-0.5">
            <button
              type="button"
              aria-label="打开关联记录"
              title="打开关联记录"
              disabled={!refId || !onOpen}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-30"
              onClick={() => { if (refId && onOpen) onOpen(refId) }}
            >
              <Icon.ArrowUpRight size={15} />
            </button>
            <CopyButton value={labels[refId] || refId || ""} />
          </div>
        </div>
      )
    })}
  </>
}

function Builder({ schema, schemas, onClose, onSaved, onDelete }: { schema: SchemaRow; schemas: SchemaRow[]; onClose: () => void; onSaved: (id: string) => void; onDelete: () => void }) {
  const { call } = useApp()
  const [name, setName] = useState(schema.name)
  const [fields, setFields] = useState<Field[]>(schema.fields)
  const [display, setDisplay] = useState(schema.display ?? "")
  const [renames, setRenames] = useState<{ from: string; to: string }[]>([])
  const [saving, setSaving] = useState(false)
  const used = schemas.some((item) => item.fields.some((field) => field.type === "ref" && field.schema === schema.id))
  async function save() {
    if (saving) return
    setSaving(true)
    try {
      const saved = await call<{ id: string }>("saveSchema", { id: schema.id || undefined, name, fields, display, renames })
      onSaved(saved.id)
      toast.add({ title: "表已保存", description: name.trim() || "未命名表", type: "success" })
    } catch (err) {
      toast.add({ title: "保存失败", description: String(err instanceof Error ? err.message : err), type: "error" })
    } finally {
      setSaving(false)
    }
  }
  useSaveHotkey(() => save(), !saving)
  const labelCount = fields.filter((field) => field.label).length
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card/60 px-6 backdrop-blur">
        <button className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border bg-card px-3 text-sm hover:bg-secondary" onClick={onClose}>
          <Icon.ChevronLeft size={16} />返回
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] tracking-[0.16em] text-muted-foreground">表结构</p>
          <strong className="block text-sm font-semibold tracking-tight">编辑表</strong>
        </div>
        <span className="rounded-full border border-border bg-secondary/60 px-2.5 py-1 text-[11px] text-muted-foreground">{used ? "被引用 · 表名锁定" : "可改名"}</span>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-5xl px-8 py-8">
        <div className="schema-hero">
          <p className="text-[11px] tracking-[0.16em] text-muted-foreground">基本信息</p>
          <label className="mt-3 block">
            <span className="text-xs text-muted-foreground">表名</span>
            <div className="mt-1.5 max-w-sm">
              <FieldBox height={44}>
                <input
                  className="h-full w-full border-0 bg-transparent text-base font-medium outline-none disabled:opacity-60"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={name}
                  disabled={used && !!schema.id}
                  onChange={(event) => setName(event.target.value)}
                />
              </FieldBox>
            </div>
          </label>
        </div>

        <div className="schema-fields mt-5 overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
            <div>
              <p className="text-[11px] tracking-[0.16em] text-muted-foreground">字段</p>
              <p className="mt-0.5 text-sm text-foreground/80">定义列类型、显示名与搜索</p>
            </div>
            <button className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border bg-background px-3 text-sm hover:bg-secondary" onClick={() => setFields([...fields, { key: "col" + (fields.length + 1), type: "string" }])}>
              <Icon.Plus size={14} />加一列
            </button>
          </div>

          <div className="grid grid-cols-[1.1fr_140px_1fr_64px_64px_56px] gap-3 border-b border-border bg-secondary/30 px-5 py-2.5 text-[11px] tracking-[0.14em] text-muted-foreground">
            <span>字段名</span><span>类型</span><span>引用到</span><span className="text-center">显示</span><span className="text-center">搜索</span><span />
          </div>

          {fields.map((field, index) => (
            <div key={index} className="grid grid-cols-[1.1fr_140px_1fr_64px_64px_56px] items-center gap-3 border-b border-border px-5 py-3 last:border-0 hover:bg-secondary/15">
              <FieldBox height={40}>
                <input
                  className="h-full w-full border-0 bg-transparent text-sm outline-none"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={field.key}
                  onChange={(event) => {
                    const next = fields.slice()
                    const from = schema.fields[index]?.key
                    if (from && from !== event.target.value) setRenames([...renames.filter((item) => item.from !== from), { from, to: event.target.value }])
                    next[index] = { ...field, key: event.target.value }
                    setFields(next)
                  }}
                />
              </FieldBox>
              <AppSelect height={40} value={field.type} allowEmpty={false} onChange={(value) => {
                const next = fields.slice()
                const type = value as Field["type"]
                next[index] = { ...field, type, search: type === "secret" ? false : field.search }
                setFields(next)
              }} options={["string", "secret", "url", "text", "date", "datetime", "time", "ref"].map((type) => ({ value: type, label: type }))} />
              <div>
                {field.type === "ref" ? (
                  <AppSelect height={40} value={field.schema ?? ""} placeholder="选择表" emptyLabel="选择表" onChange={(value) => {
                    const next = fields.slice()
                    next[index] = { ...field, schema: value }
                    setFields(next)
                  }} options={schemas.filter((item) => item.id !== schema.id).map((item) => ({ value: item.id, label: item.name }))} />
                ) : (
                  <span className="text-sm text-muted-foreground">—</span>
                )}
              </div>
              <div className="flex justify-center">
                <Checkbox
                  checked={!!field.label}
                  onCheckedChange={(checked) => {
                    const next = fields.map((item, itemIndex) => itemIndex === index ? { ...item, label: !!checked } : item)
                    if (!next.some((item) => item.label)) return
                    setFields(next)
                    if (next.filter((item) => item.label).length > 1 && !display) setDisplay(next.filter((item) => item.label).map((item) => "{" + item.key + "}").join("_"))
                  }}
                />
              </div>
              <div className="flex justify-center">
                <Checkbox
                  disabled={field.type === "secret"}
                  checked={field.type !== "secret" && !!field.search}
                  onCheckedChange={(checked) => {
                    const next = fields.slice()
                    next[index] = { ...field, search: !!checked }
                    setFields(next)
                  }}
                />
              </div>
              <div className="flex justify-center">
                <button className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-destructive" aria-label="删除字段" onClick={() => setFields(fields.filter((_, itemIndex) => itemIndex !== index))}>
                  <Icon.Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}

          {(labelCount > 1 || fields.some((field) => field.type === "ref") || !!display.trim()) && (
            <div className="border-t border-border bg-secondary/20 px-5 py-4">
              <p className="text-[11px] tracking-[0.14em] text-muted-foreground">显示模板</p>
              <div className="mt-2">
                <FieldBox height={40}>
                  <input
                    className="h-full w-full border-0 bg-transparent text-sm outline-none"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={display}
                    placeholder={fields.filter((field) => field.label).map((field) => "{" + field.key + "}").join("_") || "{name}"}
                    onChange={(event) => setDisplay(event.target.value)}
                  />
                </FieldBox>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {flattenViewFields({ id: schema.id || "draft", name, fields, sortOrder: 0, createdAt: 0, updatedAt: 0 }, schemas, "", 0, 2)
                  .filter((item) => item.type !== "secret")
                  .slice(0, 24)
                  .map((item) => (
                    <button
                      key={item.path}
                      type="button"
                      className="rounded-full border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                      title={"插入 {" + item.path + "}"}
                      onClick={() => {
                        const token = "{" + item.path + "}"
                        setDisplay((prev) => prev ? (prev.endsWith("_") || prev.endsWith("{") ? prev + token : prev + "_" + token) : token)
                      }}
                    >
                      {"{" + item.path + "}"}
                    </button>
                  ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                用 {'{字段}'} 拼列表名；引用可点到关联表，例如 {'{service.name}_{serviceUrl.env}'}。
              </p>
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center justify-between gap-4">
          <p className="text-xs text-muted-foreground">显示勾选的字段会出现在列表标题；搜索勾选的字段可被查询。</p>
          <button className="inline-flex h-10 items-center gap-2 rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground shadow-sm disabled:opacity-60" disabled={saving} onClick={() => save()}>
            {saving ? <Icon.Loader2 size={15} className="animate-spin" /> : null}
            {saving ? "保存中…" : "保存表"}
          </button>
        </div>

        {schema.id && (
          <div className="mt-12 rounded-2xl border border-dashed border-border px-5 py-4">
            <p className="text-sm font-medium">危险操作</p>
            <p className="mt-1 text-xs text-muted-foreground">删除表会清掉它的全部行，且无法恢复。</p>
            <button className="mt-3 h-9 rounded-xl px-3 text-sm text-muted-foreground hover:bg-secondary hover:text-destructive" onClick={onDelete}>删除这张表</button>
          </div>
        )}
      </div>
      </div>
    </section>
  )
}

function SettingsDesk({ schemas, views, onDefaultsChanged, onOpenImport, onResetDone }: {
  schemas: SchemaRow[]
  views: ViewDef[]
  onDefaultsChanged?: (next: { defaultSchemaId?: string; defaultViewId?: string }) => void
  onOpenImport: () => void
  onResetDone: () => Promise<void>
}) {
  const { call } = useApp()
  const [section, setSection] = useState<"general" | "data" | "about">("general")
  const [startupNav, setStartupNav] = useState<Nav>("home")
  const [defaultSchemaId, setDefaultSchemaId] = useState("all")
  const [defaultViewId, setDefaultViewId] = useState("")
  const [rowActLeft, setRowActLeft] = useState<RowActId>("edit")
  const [rowActRight, setRowActRight] = useState<RowActId>("copy")
  const [backupDir, setBackupDir] = useState("")
  const [lastBackupPath, setLastBackupPath] = useState("")
  const [busy, setBusy] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [resetText, setResetText] = useState("")
  const confirmPhrase = "清空全部数据"

  async function load() {
    const settings = await call<{ startupNav: Nav; defaultSchemaId?: string; defaultViewId?: string; rowActionPins?: string; backupDir: string; lastBackupPath?: string }>("getSettings")
    setStartupNav(settings.startupNav || "home")
    const pins = parseRowActPins(settings.rowActionPins)
    setRowActLeft(pins[0])
    setRowActRight(pins[1])
    const schemaPin = String(settings.defaultSchemaId ?? "all") || "all"
    const viewPin = String(settings.defaultViewId ?? "")
    // Heal UI if pin was auto-cleared server-side
    const schemaOk = schemaPin === "all" || schemas.some((item) => item.id === schemaPin)
    const viewOk = !viewPin || views.some((item) => item.id === viewPin)
    setDefaultSchemaId(schemaOk ? schemaPin : "all")
    setDefaultViewId(viewOk ? viewPin : "")
    setBackupDir(settings.backupDir || "")
    setLastBackupPath(settings.lastBackupPath || "")
  }
  useEffect(() => { load().catch(() => {}) }, [schemas, views])

  async function saveStartup(nav: Nav) {
    setStartupNav(nav)
    await call("saveSettings", { startupNav: nav })
    toast.add({ title: "已保存启动页", type: "success" })
  }

  async function saveDefaultSchema(id: string) {
    const next = id || "all"
    setDefaultSchemaId(next)
    await call("saveSettings", { defaultSchemaId: next })
    onDefaultsChanged?.({ defaultSchemaId: next })
    toast.add({ title: "已保存默认数据表", type: "success" })
  }

  async function saveDefaultView(id: string) {
    // Empty string = first view (auto)
    const next = id || ""
    setDefaultViewId(next)
    await call("saveSettings", { defaultViewId: next || null })
    onDefaultsChanged?.({ defaultViewId: next })
    toast.add({ title: "已保存默认启动视图", type: "success" })
  }

  async function saveRowActPins(left: RowActId, right: RowActId) {
    let nextRight = right
    if (nextRight === left) nextRight = (left === "copy" ? "open" : "copy")
    setRowActLeft(left)
    setRowActRight(nextRight)
    await call("saveSettings", { rowActionPins: left + "," + nextRight })
    toast.add({ title: "已保存窄列保留", type: "success" })
  }

  async function pickDir() {
    setBusy(true)
    try {
      const res = await call<{ dir: string }>("pickBackupDirectory")
      setBackupDir(res.dir)
      toast.add({ title: "已记住备份目录", type: "success" })
    } catch (err) {
      toast.add({ title: "未选择目录", description: String(err instanceof Error ? err.message : err), type: "error" })
    } finally {
      setBusy(false)
    }
  }

  async function runBackup() {
    setBusy(true)
    try {
      const res = await call<{ filePath: string; fileName: string }>("backupNow")
      setLastBackupPath(res.filePath)
      toast.add({ title: "备份完成", description: res.fileName, type: "success" })
    } catch (err) {
      toast.add({ title: "备份失败", description: String(err instanceof Error ? err.message : err), type: "error" })
    } finally {
      setBusy(false)
    }
  }

  async function confirmReset() {
    if (resetText.trim() !== confirmPhrase) return
    setBusy(true)
    try {
      await call("resetAllData", { confirm: confirmPhrase })
      setResetOpen(false)
      setResetText("")
      toast.add({ title: "已清空全部数据", type: "success" })
      await onResetDone()
    } catch (err) {
      toast.add({ title: "清空失败", description: String(err instanceof Error ? err.message : err), type: "error" })
    } finally {
      setBusy(false)
    }
  }

  const navLabel: Record<Nav, string> = { home: "首页", data: "数据", views: "视图", import: "导入", settings: "设置" }

  return (
    <div className="settings-s1">
      <aside className="settings-nav">
        <p className="settings-kicker">SETTINGS</p>
        {([
          ["general", "通用", "◎"],
          ["data", "数据与备份", "▦"],
          ["about", "关于", "i"],
        ] as const).map(([id, label, ico]) => (
          <button key={id} type="button" className={"settings-nav-item " + (section === id ? "is-on" : "")} onClick={() => setSection(id)}>
            <span className="settings-nav-ico">{ico}</span>{label}
          </button>
        ))}
      </aside>
      <main className="settings-main">
        {section === "general" && (
          <>
            <p className="settings-eyebrow">GENERAL</p>
            <h1 className="settings-title">通用</h1>
            <p className="settings-lede">不影响数据本身的行为偏好。</p>
            <div className="settings-block">
              <div className="settings-row">
                <div className="settings-row-copy">
                  <div className="settings-row-t">启动页</div>
                  <div className="settings-row-d">打开应用时默认进入的模块</div>
                </div>
                <div className="settings-row-control">
                  <AppSelect
                    height={36}
                    value={startupNav}
                    allowEmpty={false}
                    onChange={(value) => saveStartup(value as Nav)}
                    options={(["home", "data", "views", "import", "settings"] as Nav[]).map((id) => ({ value: id, label: navLabel[id] }))}
                  />
                </div>
              </div>
              <div className="settings-row">
                <div className="settings-row-copy">
                  <div className="settings-row-t">默认启动数据表</div>
                  <div className="settings-row-d">打开「数据」时默认进入的表；默认是全部</div>
                </div>
                <div className="settings-row-control">
                  <AppSelect
                    height={36}
                    value={defaultSchemaId}
                    allowEmpty={false}
                    onChange={(value) => void saveDefaultSchema(value)}
                    options={[{
                      value: "all",
                      label: "全部",
                    }, ...schemas.map((item) => ({ value: item.id, label: item.name }))]} 
                  />
                </div>
              </div>
              <div className="settings-row">
                <div className="settings-row-copy">
                  <div className="settings-row-t">默认启动视图</div>
                  <div className="settings-row-d">打开「首页」时默认进入的视图；默认是第一个视图</div>
                </div>
                <div className="settings-row-control">
                  <AppSelect
                    height={36}
                    value={defaultViewId || (views[0]?.id ?? "")}
                    allowEmpty={false}
                    onChange={(value) => void saveDefaultView(value === views[0]?.id ? "" : value)}
                    options={views.length
                      ? views.map((item, index) => ({
                          value: item.id,
                          label: item.name + (index === 0 ? "（默认）" : ""),
                        }))
                      : [{ value: "", label: "暂无视图" }]}
                  />
                </div>
              </div>
              <div className="settings-row">
                <div className="settings-row-copy">
                  <div className="settings-row-t">窄列保留</div>
                  <div className="settings-row-d">收到最窄时留下的两枚，中间只是分隔，不代表写入/只读。展开时同类从对应一侧冒出；两侧同一类，另一类从外侧冒出</div>
                </div>
                <div className="settings-row-control flex !w-auto items-center gap-1.5">
                  <div className="w-[108px]">
                    <AppSelect height={36} value={rowActLeft} allowEmpty={false} onChange={(value) => void saveRowActPins(value as RowActId, rowActRight)} options={[{ value: "edit", label: "编辑" }, { value: "clone", label: "克隆" }, { value: "delete", label: "删除" }, { value: "copy", label: "复制" }, { value: "open", label: "跳转" }]} />
                  </div>
                  <span className="text-muted-foreground">|</span>
                  <div className="w-[108px]">
                    <AppSelect height={36} value={rowActRight} allowEmpty={false} onChange={(value) => void saveRowActPins(rowActLeft, value as RowActId)} options={[{ value: "edit", label: "编辑" }, { value: "clone", label: "克隆" }, { value: "delete", label: "删除" }, { value: "copy", label: "复制" }, { value: "open", label: "跳转" }]} />
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
        {section === "data" && (
          <>
            <p className="settings-eyebrow">DATA & BACKUP</p>
            <h1 className="settings-title">数据与备份</h1>
            <p className="settings-lede">一键备份到你指定的目录；测试完可清空恢复空白手账。</p>
            <div className="settings-block">
              <div className="settings-block-h">
                <h2>备份</h2>
                <p>选择目录并记住；之后一键写入完整包（表 · 视图 · 数据）</p>
              </div>
              <div className="settings-row">
                <div className="min-w-0 flex-1">
                  <div className="settings-row-t">备份目录</div>
                  <div className="settings-row-d break-all">{backupDir || "尚未选择"}</div>
                </div>
                <button type="button" className="settings-btn" disabled={busy} onClick={() => pickDir()}>{backupDir ? "更改…" : "选择…"}</button>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-row-t">一键备份</div>
                  <div className="settings-row-d">导出当前全部结构与数据到备份目录</div>
                </div>
                <button type="button" className="settings-btn settings-btn-primary" disabled={busy || !backupDir} onClick={() => runBackup()}>{busy ? "备份中…" : "立即备份"}</button>
              </div>
              {!!lastBackupPath && (
                <div className="settings-row">
                  <div className="min-w-0 flex-1">
                    <div className="settings-row-t">最近备份</div>
                    <div className="settings-row-d break-all">{lastBackupPath}</div>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" className="settings-btn" onClick={() => call("revealExportPath", { path: lastBackupPath, mode: "folder" })}>打开位置</button>
                    <button type="button" className="settings-btn" onClick={() => call("revealExportPath", { path: lastBackupPath, mode: "file" })}>打开文件</button>
                  </div>
                </div>
              )}
              <div className="settings-row">
                <div>
                  <div className="settings-row-t">精细导出 / 导入</div>
                  <div className="settings-row-d">需要勾选部分表或视图时，请用导入模块</div>
                </div>
                <button type="button" className="settings-btn" onClick={onOpenImport}>打开导入</button>
              </div>
            </div>
            <div className="settings-danger">
              <div className="settings-block-h">
                <h2>危险区域</h2>
                <p>测试结束后可一键恢复空白。需输入确认文案，不可撤销。</p>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-row-t">清空所有数据</div>
                  <div className="settings-row-d">删除全部表、行、视图与查询历史</div>
                </div>
                <button type="button" className="settings-btn settings-btn-danger" onClick={() => { setResetText(""); setResetOpen(true) }}>清空…</button>
              </div>
            </div>
          </>
        )}
        {section === "about" && (
          <>
            <p className="settings-eyebrow">ABOUT</p>
            <h1 className="settings-title">关于</h1>
            <p className="settings-lede">版本与本地说明。</p>
            <div className="settings-block">
              <div className="settings-row">
                <div>
                  <div className="settings-row-t">数据手账</div>
                  <div className="settings-row-d">本地优先 · 无云同步</div>
                </div>
                <span className="text-xs text-muted-foreground">com.pwang.data-cask</span>
              </div>
            </div>
          </>
        )}
      </main>

      {resetOpen && (
        <div className="settings-mask" onClick={(event) => { if (event.target === event.currentTarget) setResetOpen(false) }}>
          <div className="settings-modal">
            <h3>清空所有数据？</h3>
            <p>将删除全部表、记录、视图与相关本地内容。此操作不可撤销。</p>
            <p className="mt-3">请输入 <strong>清空全部数据</strong> 以确认：</p>
            <div className="settings-phrase">清空全部数据</div>
            <input
              className="settings-confirm-input"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="在此输入确认文案"
              value={resetText}
              onChange={(event) => setResetText(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") confirmReset() }}
            />
            <div className="settings-modal-acts">
              <button type="button" className="settings-btn" onClick={() => setResetOpen(false)}>取消</button>
              <button type="button" className="settings-btn settings-btn-danger-solid" disabled={busy || resetText.trim() !== confirmPhrase} onClick={() => confirmReset()}>
                {busy ? "清空中…" : "确认清空"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ImportDesk({ schemas, views, counts, onDone }: { schemas: SchemaRow[]; views: ViewDef[]; counts: Record<string, number>; onDone: () => void; onBuild: () => void }) {
  const { call } = useApp()
  const [deskMode, setDeskMode] = useState<ImportDeskMode>("landing")
  const [source, setSource] = useState<ImportSource>("file")
  const [step, setStep] = useState<Step>("home")
  const [sheets, setSheets] = useState<Sheet[]>([])
  const [chosen, setChosen] = useState<number[]>([])
  const [targets, setTargets] = useState<Record<number, string>>({})
  const [maps, setMaps] = useState<Record<number, Record<string, string>>>({})
  /** sheetIndex → fileColumn → path of keys on nested schemas for ref match */
  const [refPaths, setRefPaths] = useState<Record<number, Record<string, string[]>>>({})
  const [miss, setMiss] = useState<"blank" | "skip">("blank")
  const [active, setActive] = useState(0)
  const [message, setMessage] = useState("")
  const [rawText, setRawText] = useState("")
  const [parsers, setParsers] = useState<TextParserDef[]>([])
  const [parserId, setParserId] = useState("")
  const [preprocessSource, setPreprocessSource] = useState("")
  const [parseLineSource, setParseLineSource] = useState("")
  const [scriptTab, setScriptTab] = useState<"line" | "pre">("line")
  const [tryResult, setTryResult] = useState<TextParseResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [aiNotes, setAiNotes] = useState("")
  const [packStep, setPackStep] = useState<PackStep>("source")
  const [pack, setPack] = useState<CaskPack | null>(null)
  const [packFiles, setPackFiles] = useState<File[]>([])
  const [dataFiles, setDataFiles] = useState<File[]>([])
  const [packConflict, setPackConflict] = useState<"skip" | "rename">("skip")
  const [packResult, setPackResult] = useState<{ created: { schemas: number; views: number; samples: number }; skipped: { schemas: number; views: number } } | null>(null)
  const [exportStep, setExportStep] = useState<ExportStep>("select")
  const [exportName, setExportName] = useState("数据手账包")
  const [exportSchemas, setExportSchemas] = useState<string[]>([])
  const [exportViews, setExportViews] = useState<string[]>([])
  /** viewId -> whether to export all shortcuts with this view */
  const [exportViewShortcutsOn, setExportViewShortcutsOn] = useState<Record<string, boolean>>({})
  /** tables included in data section */
  const [exportDataTables, setExportDataTables] = useState<string[]>([])
  /** per-table: real rows vs auto sample */
  const [exportDataMode, setExportDataMode] = useState<Record<string, "real" | "sample">>({})
  const [exportForced, setExportForced] = useState<string[]>([])
  const [exportPreview, setExportPreview] = useState<CaskPack | null>(null)
  const [exportFilePath, setExportFilePath] = useState("")
  const [exportDir, setExportDir] = useState("")

  const path = source === "text" ? textSteps : fileSteps
  const reached = Math.max(0, path.indexOf(step))
  const dataPathMeta = path.map((id) => ({ id, title: stepName[id], desc: id === "home" ? "文件或动态文本" : id === "file" ? "CSV / Excel" : id === "text" ? "粘贴原文" : id === "ai" ? "生成解析脚本" : id === "parser" ? "试跑 / 改脚本" : id === "targets" ? "写入 schema" : id === "map" ? "列 → 字段" : id === "refs" ? "引用对值" : id === "preview" ? "确认写入" : "完成" }))
  const packPathMeta: { id: PackStep; title: string; desc: string }[] = [
    { id: "source", title: "选择包", desc: "模板或 .caskpack" },
    { id: "preview", title: "预览蓝图", desc: "有则导入 · 无则跳过" },
    { id: "conflict", title: "冲突策略", desc: "同名如何处理" },
    { id: "done", title: "完成", desc: "写入本地" },
  ]
  const packReached = Math.max(0, packPathMeta.findIndex((item) => item.id === packStep))

  useEffect(() => {
    if (source !== "text") return
    call<{ parsers: TextParserDef[] }>("listTextParsers").then((res) => {
      setParsers(res.parsers)
      if (!parserId && res.parsers[0]) applyParser(res.parsers[0])
    }).catch((err) => setMessage(String(err instanceof Error ? err.message : err)))
  }, [source])

  function applyParser(p: TextParserDef) {
    setParserId(p.id)
    setPreprocessSource(p.preprocessSource)
    setParseLineSource(p.parseLineSource)
    if (!rawText.trim() && p.sampleRaw) setRawText(p.sampleRaw)
  }

  async function pick(file: File) {
    const data = await file.arrayBuffer()
    const bytes = new Uint8Array(data)
    let binary = ""
    bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
    const parsed = await call<{ sheets: Sheet[] }>("parseImport", { filename: file.name, base64: btoa(binary) })
    setSheets(parsed.sheets)
    setChosen(parsed.sheets.map((_, index) => index))
    setSource("file")
    setStep("file")
  }

  async function runParser() {
    setBusy(true)
    setMessage("")
    try {
      const result = await call<TextParseResult>("runTextParser", {
        raw: rawText,
        preprocessSource,
        parseLineSource,
        parserId: parserId || undefined,
        sheetName: parsers.find((p) => p.id === parserId)?.name || "文本",
        firstRowIsHeader: "auto",
      })
      setTryResult(result)
      if (!result.hardFail) {
        setSheets([result.sheet])
        setChosen([0])
      } else {
        setMessage(result.errors[0]?.message || "解析失败")
      }
      return result
    } catch (err) {
      setMessage(String(err instanceof Error ? err.message : err))
      return null
    } finally {
      setBusy(false)
    }
  }

  async function runAi() {
    setBusy(true)
    setMessage("")
    setAiNotes("")
    setStep("ai")
    try {
      const gen = await call<{
        preprocessSource: string
        parseLineSource: string
        notes: string
        result: TextParseResult
      }>("generateTextParser", { raw: rawText })
      setPreprocessSource(gen.preprocessSource)
      setParseLineSource(gen.parseLineSource)
      setAiNotes(gen.notes || "")
      setParserId("")
      setTryResult(gen.result)
      if (!gen.result.hardFail) {
        setSheets([gen.result.sheet])
        setChosen([0])
      } else {
        setMessage(gen.result.errors[0]?.message || "识别后试跑未通过，可打开脚本修改")
      }
    } catch (err) {
      setMessage(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }

  function resetImport() {
    setDeskMode("landing")
    setStep("home")
    setSheets([])
    setChosen([])
    setTargets({})
    setMaps({})
    setRefPaths({})
    setTryResult(null)
    setMessage("")
    setAiNotes("")
    setPackStep("source")
    setPack(null)
    setPackFiles([])
    setDataFiles([])
    setPackResult(null)
    setPackConflict("skip")
    setExportStep("select")
    setExportPreview(null)
    setExportForced([])
  }

  function openDataFlow() {
    setDeskMode("data")
    setStep("home")
    setMessage("")
  }

  function openPackFlow() {
    setDeskMode("pack")
    setPackStep("source")
    setPack(null)
    setPackResult(null)
    setMessage("")
  }

  function openExportFlow() {
    setDeskMode("export")
    setExportStep("select")
    setExportName("数据手账包")
    setExportSchemas(schemas.map((item) => item.id))
    setExportViews(views.map((item) => item.id))
    setExportViewShortcutsOn(Object.fromEntries(views.map((view) => [view.id, true])))
    const withData = schemas.filter((item) => (counts[item.id] ?? 0) > 0).map((item) => item.id)
    setExportDataTables(withData)
    setExportDataMode(Object.fromEntries(withData.map((id) => [id, "real" as const])))
    setExportPreview(null)
    setExportFilePath("")
    setExportDir("")
    setExportForced([])
    setMessage("")
  }

  function schemaRefDeps(schemaId: string, seen = new Set<string>()): string[] {
    if (seen.has(schemaId)) return []
    seen.add(schemaId)
    const schema = schemas.find((item) => item.id === schemaId)
    if (!schema) return []
    const out: string[] = []
    for (const field of schema.fields) {
      if (field.type === "ref" && field.schema && schemas.some((item) => item.id === field.schema)) {
        out.push(field.schema, ...schemaRefDeps(field.schema, seen))
      }
    }
    return out
  }

  function isSchemaRequiredBySelection(id: string, selectedSchemas: string[], selectedViews: string[], selectedData: string[]) {
    for (const sid of selectedSchemas) {
      if (sid === id) continue
      if (schemaRefDeps(sid).includes(id)) return true
    }
    for (const vid of selectedViews) {
      const view = views.find((item) => item.id === vid)
      if (!view) continue
      if (view.schemaId === id || schemaRefDeps(view.schemaId).includes(id)) return true
    }
    for (const sid of selectedData) {
      if (sid === id) continue
      if (schemaRefDeps(sid).includes(id)) return true
    }
    return false
  }

  function toggleExportSchema(id: string) {
    setExportSchemas((prev) => {
      if (prev.includes(id)) {
        if (isSchemaRequiredBySelection(id, prev.filter((sid) => sid !== id), exportViews, exportDataTables)) {
          toast.add({ title: "无法取消", description: "仍有已选表/视图/数据依赖它", type: "error" })
          return prev
        }
        setExportDataTables((tables) => tables.filter((sid) => sid !== id))
        setExportDataMode((mode) => {
          const next = { ...mode }
          delete next[id]
          return next
        })
        return prev.filter((sid) => sid !== id)
      }
      const deps = schemaRefDeps(id)
      return [...new Set([...prev, id, ...deps])]
    })
  }

  function toggleExportDataTable(id: string) {
    setExportDataTables((prev) => {
      if (prev.includes(id)) {
        setExportDataMode((mode) => {
          const next = { ...mode }
          delete next[id]
          return next
        })
        return prev.filter((sid) => sid !== id)
      }
      const deps = [id, ...schemaRefDeps(id)]
      setExportSchemas((schemasSel) => [...new Set([...schemasSel, ...deps])])
      setExportDataMode((mode) => ({ ...mode, [id]: mode[id] ?? ((counts[id] ?? 0) > 0 ? "real" : "sample") }))
      return [...prev, id]
    })
  }

  function setExportTableDataMode(id: string, mode: "real" | "sample") {
    if (mode === "real" && !(counts[id] ?? 0)) {
      toast.add({ title: "无实际数据", description: "该表为空，已保持样例模式", type: "error" })
      return
    }
    setExportDataMode((prev) => ({ ...prev, [id]: mode }))
    if (!exportDataTables.includes(id)) toggleExportDataTable(id)
  }

  function toggleExportView(id: string) {
    setExportViews((prev) => {
      if (prev.includes(id)) {
        setExportViewShortcutsOn((map) => {
          const next = { ...map }
          delete next[id]
          return next
        })
        return prev.filter((vid) => vid !== id)
      }
      const view = views.find((item) => item.id === id)
      if (view) {
        const deps = [view.schemaId, ...schemaRefDeps(view.schemaId)]
        setExportSchemas((schemasSel) => [...new Set([...schemasSel, ...deps])])
        setExportViewShortcutsOn((map) => ({ ...map, [id]: true }))
      }
      return [...prev, id]
    })
  }

  function setExportViewIncludeShortcuts(viewId: string, on: boolean) {
    setExportViewShortcutsOn((prev) => ({ ...prev, [viewId]: on }))
  }

  function backFromTargets() {
    setStep(source === "text" ? "parser" : "file")
  }

  async function buildExportPreview() {
    if (!exportSchemas.length && !exportViews.length) {
      setMessage("至少选择一张表或一个视图")
      return
    }
    setBusy(true)
    setMessage("")
    try {
      const res = await call<{ pack: CaskPack; meta: { forcedSchemaIds: string[] } }>("exportCaskPack", {
        name: exportName,
        schemaIds: exportSchemas,
        viewIds: exportViews,
        viewShortcutIds: Object.fromEntries(exportViews.map((id) => {
          const view = views.find((item) => item.id === id)
          // default include shortcuts unless explicitly turned off
          const ids = exportViewShortcutsOn[id] === false ? [] : (view?.shortcuts ?? []).map((item) => item.id)
          return [id, ids]
        })),
        realSchemaIds: exportDataTables.filter((id) => exportDataMode[id] === "real"),
        sampleSchemaIds: exportDataTables.filter((id) => exportDataMode[id] !== "real"),
      })
      setExportPreview(res.pack)
      setExportForced(res.meta?.forcedSchemaIds ?? [])
      // sync selection with server closure
      const nameToId = Object.fromEntries(schemas.map((item) => [item.name, item.id]))
      setExportSchemas(res.pack.schemas.map((item) => nameToId[item.name]).filter(Boolean) as string[])
      setExportStep("preview")
    } catch (err) {
      setMessage(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }

  async function downloadExportPack() {
    setBusy(true)
    try {
      const res = await call<{ pack: CaskPack; json: string; filePath: string; exportDir: string; fileName: string }>("exportCaskPack", {
        name: exportName,
        schemaIds: exportSchemas,
        viewIds: exportViews,
        viewShortcutIds: Object.fromEntries(exportViews.map((id) => {
          const view = views.find((item) => item.id === id)
          const ids = exportViewShortcutsOn[id] === false ? [] : (view?.shortcuts ?? []).map((item) => item.id)
          return [id, ids]
        })),
        realSchemaIds: exportDataTables.filter((id) => exportDataMode[id] === "real"),
        sampleSchemaIds: exportDataTables.filter((id) => exportDataMode[id] !== "real"),
      })
      setExportPreview(res.pack)
      setExportFilePath(res.filePath || "")
      setExportDir(res.exportDir || "")
      setExportStep("done")
      toast.add({ title: "包已导出", description: res.fileName || (res.pack.schemas.length + " 表 · " + res.pack.views.length + " 视图"), type: "success" })
    } catch (err) {
      toast.add({ title: "导出失败", description: String(err instanceof Error ? err.message : err), type: "error" })
    } finally {
      setBusy(false)
    }
  }

  async function openExported(mode: "file" | "folder") {
    const path = mode === "folder" ? (exportFilePath || exportDir) : exportFilePath
    if (!path) {
      toast.add({ title: "没有可打开的路径", type: "error" })
      return
    }
    try {
      await call("revealExportPath", { path, mode })
    } catch (err) {
      toast.add({ title: "打开失败", description: String(err instanceof Error ? err.message : err), type: "error" })
    }
  }

  async function pickPack(file: File) {
    setBusy(true)
    setMessage("")
    setPackFiles([file])
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as CaskPack
      if (!parsed || parsed.kind !== "caskpack" || parsed.version !== 1) throw new Error("不是有效的 caskpack")
      if (!Array.isArray(parsed.schemas) || !parsed.schemas.length) throw new Error("包里没有表定义")
      setPack({
        version: 1,
        kind: "caskpack",
        name: String(parsed.name || file.name || "未命名包"),
        exportedAt: Number(parsed.exportedAt) || Date.now(),
        schemas: parsed.schemas,
        views: Array.isArray(parsed.views) ? parsed.views : [],
        samples: Array.isArray(parsed.samples) ? parsed.samples.map((item) => ({
          ...item,
          packId: String(item.packId ?? "") || ("legacy:" + String(item.schemaName) + ":" + Math.random().toString(36).slice(2, 8)),
        })) : [],
      })
      setPackStep("preview")
    } catch (err) {
      setPack(null)
      setMessage(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }

  async function runPackImport() {
    if (!pack) return
    setBusy(true)
    setMessage("")
    try {
      const res = await call<{
        created: { schemas: number; views: number; samples: number }
        skipped: { schemas: number; views: number }
      }>("importCaskPack", { pack, conflict: packConflict })
      setPackResult(res)
      setPackStep("done")
      toast.add({ title: "包已导入", description: "新建 " + res.created.schemas + " 表 · " + res.created.views + " 视图", type: "success" })
    } catch (err) {
      setMessage(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }

  if (deskMode === "landing") {
    return (
      <div className="import-landing">
        <div className="import-story">
          <p className="import-kicker">IMPORT · ONBOARD</p>
          <h1 className="import-title">表格和数据<br />从这里一键导入</h1>
          <p className="import-quote">不用先懂字段类型。一键复刻数据体系。</p>
          <p className="import-sub">让 AI 帮你自动识别格式，定制导入方案。</p>
          <div className="import-story-steps">
            <div className="import-story-step"><span>01</span><div><b>选意图</b><p>灌数据，或导入可分享的包</p></div></div>
            <div className="import-story-step"><span>02</span><div><b>预览将发生的事</b><p>表、视图、样例 · 有则导入</p></div></div>
            <div className="import-story-step"><span>03</span><div><b>写入本地</b><p>稍后可在数据 / 视图里细调</p></div></div>
          </div>
          <p className="import-story-foot">本地优先 · 无云同步 · 适合分享复刻</p>
        </div>
        <div className="import-panel">
          <div className="import-panel-head">
            <h2>从哪里开始</h2>
            <span>点卡片进入流程</span>
          </div>
          <button type="button" className="import-mode-card" onClick={openDataFlow}>
            <span className="import-mode-tag">DATA</span>
            <strong>导入数据</strong>
            <p>除了常见的 CSV/Excel 文件导入，还支持 AI 自动识别格式导入。</p>
            <div className="import-mode-meta"><i>文件</i><i>动态文本</i><i>列匹配</i><i>引用路径</i></div>
            <span className="import-mode-go">选择来源 →</span>
          </button>
          <button type="button" className="import-mode-card" onClick={openPackFlow}>
            <span className="import-mode-tag">PACK</span>
            <strong>导入 / 复刻包</strong>
            <p>一个包可含表、视图、样例。从别人已经构建好的体系一键导入。</p>
            <div className="import-mode-meta"><i>表</i><i>视图可选</i><i>样例可选</i><i>.caskpack</i></div>
            <span className="import-mode-go">选择包 →</span>
          </button>
          <div className="import-export-row">
            <div>
              <b>导出我的包</b>
              <p>自选表、视图与样例数据，打成可分享包。</p>
            </div>
            <button type="button" className="h-9 shrink-0 rounded-xl border border-border bg-card px-3 text-sm" disabled={!schemas.length} onClick={openExportFlow}>开始导出</button>
          </div>
        </div>
      </div>
    )
  }

  if (deskMode === "export") {
    const exportPath: { id: ExportStep; title: string; desc: string }[] = [
      { id: "select", title: "勾选内容", desc: "表 · 视图 · 数据" },
      { id: "preview", title: "预览包", desc: "确认后再下载" },
      { id: "done", title: "完成", desc: "已生成文件" },
    ]
    const exportReached = Math.max(0, exportPath.findIndex((item) => item.id === exportStep))
    const forcedSet = new Set(exportForced)
    return (
      <div className="import-flow">
        <aside className="import-flow-left">
          <div className="import-flow-brand">
            <p className="import-kicker">EXPORT</p>
            <button type="button" className="import-back" onClick={resetImport}>返回入口</button>
          </div>
          <h1 className="import-flow-title">导出我的包</h1>
          <p className="import-flow-lede">精细勾选要带走的结构、视图与样例。关联表会自动带上。</p>
          <div className="import-paths">
            {exportPath.map((item, index) => {
              const on = item.id === exportStep
              const done = index < exportReached
              return (
                <button key={item.id} type="button" className={"import-path " + (on ? "is-on" : "") + (done ? " is-done" : "")} disabled={index > exportReached} onClick={() => index <= exportReached && setExportStep(item.id)}>
                  <span className="import-path-row"><span className="import-path-num">{done && !on ? "✓" : index + 1}</span><span className="import-path-t">{item.title}</span></span>
                  <span className="import-path-d">{item.desc}</span>
                </button>
              )
            })}
          </div>
        </aside>
        <section className="import-flow-right">
          <div className="import-flow-top">
            <h2>{exportPath[exportReached]?.title ?? "导出"}</h2>
            <span className="import-pill">步骤 {exportReached + 1} / {exportPath.length}</span>
          </div>
          <div className="import-flow-body">
            {exportStep === "select" && (
              <>
                <p className="import-hint">先选大类，再勾二级项。勾选带引用的表时，依赖表会自动选中且不可单独取消。</p>
                <label className="mb-5 block max-w-md">
                  <span className="text-[11px] tracking-[0.12em] text-muted-foreground">包名称</span>
                  <input className="mt-1.5 h-11 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={exportName} onChange={(event) => setExportName(event.target.value)} />
                </label>

                <div className="export-sections">
                  <section className="export-section">
                    <div className="export-section-head">
                      <div>
                        <h3>数据结构</h3>
                        <p>表定义与字段 · 引用依赖自动包含</p>
                      </div>
                      <div className="export-section-actions">
                        <button type="button" className="export-mini" onClick={() => setExportSchemas(schemas.map((item) => item.id))}>全选</button>
                        <button type="button" className="export-mini" onClick={() => { setExportSchemas([]); setExportSamples([]) }}>清空</button>
                      </div>
                    </div>
                    <div className="export-grid">
                      {schemas.map((item) => {
                        const on = exportSchemas.includes(item.id)
                        const forced = forcedSet.has(item.id) && on
                        const refs = item.fields.filter((field) => field.type === "ref").map((field) => schemas.find((row) => row.id === field.schema)?.name).filter(Boolean)
                        return (
                          <button key={item.id} type="button" className={"export-item " + (on ? "is-on" : "")} onClick={() => toggleExportSchema(item.id)}>
                            <span className="export-check">{on ? "✓" : ""}</span>
                            <span className="min-w-0 flex-1 text-left">
                              <span className="export-item-title">{item.name}</span>
                              <span className="export-item-meta">{item.fields.length} 字段 · {counts[item.id] ?? 0} 行{refs.length ? " · 引用 " + refs.join("、") : ""}{forced ? " · 依赖带入" : ""}</span>
                            </span>
                          </button>
                        )
                      })}
                      {!schemas.length && <p className="text-sm text-muted-foreground">还没有表</p>}
                    </div>
                  </section>

                  <section className="export-section">
                    <div className="export-section-head">
                      <div>
                        <h3>视图</h3>
                        <p>勾选视图会自动带上其数据表；可再选择是否一并导出快捷条件</p>
                      </div>
                      <div className="export-section-actions">
                        <button type="button" className="export-mini" onClick={() => {
                          setExportViews(views.map((item) => item.id))
                          setExportViewShortcutsOn(Object.fromEntries(views.map((view) => [view.id, true])))
                          const deps = views.flatMap((view) => [view.schemaId, ...schemaRefDeps(view.schemaId)])
                          setExportSchemas((prev) => [...new Set([...prev, ...deps])])
                        }}>全选</button>
                        <button type="button" className="export-mini" onClick={() => { setExportViews([]); setExportViewShortcutsOn({}) }}>清空</button>
                      </div>
                    </div>
                    <div className="export-view-list">
                      {views.map((item) => {
                        const on = exportViews.includes(item.id)
                        const tableName = schemas.find((row) => row.id === item.schemaId)?.name ?? "表"
                        const shortcuts = item.shortcuts ?? []
                        const scOn = exportViewShortcutsOn[item.id] !== false
                        return (
                          <div key={item.id} className={"export-data-row " + (on ? "is-on" : "")}>
                            <button type="button" className="export-data-main" onClick={() => toggleExportView(item.id)}>
                              <span className={"export-check export-check-data " + (on ? "is-on" : "")} aria-hidden="true">{on ? <Icon.Check size={13} strokeWidth={2.5} /> : null}</span>
                              <span className="min-w-0 flex-1 text-left">
                                <span className="export-item-title">{item.name || "未命名视图"}</span>
                                <span className="export-item-meta">来自 {tableName} · 快捷 {shortcuts.length} 个{(item.description || "").trim() ? " · " + item.description.trim() : ""}</span>
                              </span>
                            </button>
                            <div className={"export-mode-toggle " + (on && shortcuts.length ? "" : "is-disabled")} onClick={(event) => event.stopPropagation()}>
                              <button type="button" className={scOn && on ? "is-on" : ""} disabled={!on || !shortcuts.length} onClick={() => setExportViewIncludeShortcuts(item.id, true)}>含快捷</button>
                              <button type="button" className={!scOn && on ? "is-on" : ""} disabled={!on || !shortcuts.length} onClick={() => setExportViewIncludeShortcuts(item.id, false)}>不含</button>
                            </div>
                          </div>
                        )
                      })}
                      {!views.length && <p className="text-sm text-muted-foreground">还没有视图</p>}
                    </div>
                  </section>

                  <section className="export-section">
                    <div className="export-section-head">
                      <div>
                        <h3>数据</h3>
                        <p>按表决定是否带走行数据：实际数据，或系统生成的脱敏样例</p>
                      </div>
                      <div className="export-section-actions">
                        <button type="button" className="export-mini" onClick={() => {
                          const ids = schemas.map((item) => item.id)
                          setExportDataTables(ids)
                          setExportDataMode(Object.fromEntries(ids.map((id) => [id, (counts[id] ?? 0) > 0 ? "real" : "sample"] as const)))
                          const deps = ids.flatMap((id) => [id, ...schemaRefDeps(id)])
                          setExportSchemas((prev) => [...new Set([...prev, ...deps])])
                        }}>全部带上</button>
                        <button type="button" className="export-mini" onClick={() => {
                          setExportDataTables([])
                          setExportDataMode({})
                        }}>全部不带</button>
                      </div>
                    </div>
                    <div className="export-data-list">
                      {schemas.map((item) => {
                        const n = counts[item.id] ?? 0
                        const on = exportDataTables.includes(item.id)
                        const mode = exportDataMode[item.id] ?? (n > 0 ? "real" : "sample")
                        return (
                          <div key={item.id} className={"export-data-row " + (on ? "is-on" : "")}>
                            <button type="button" className="export-data-main" onClick={() => toggleExportDataTable(item.id)}>
                              <span className={"export-check export-check-data " + (on ? "is-on" : "")} aria-hidden="true">
                                {on ? <Icon.Check size={13} strokeWidth={2.5} /> : null}
                              </span>
                              <span className="min-w-0 flex-1 text-left">
                                <span className="export-item-title">{item.name}</span>
                                <span className="export-item-meta">{n ? n + " 行在库" : "表内暂无行"}{on ? (mode === "real" ? " · 将导出全部实际数据" : " · 将生成样例数据") : " · 不导出数据"}</span>
                              </span>
                            </button>
                            <div className={"export-mode-toggle " + (on ? "" : "is-disabled")} onClick={(event) => event.stopPropagation()}>
                              <button type="button" className={mode === "real" && on ? "is-on" : ""} disabled={!on || !n} onClick={() => setExportTableDataMode(item.id, "real")}>实际数据</button>
                              <button type="button" className={mode === "sample" && on ? "is-on" : ""} disabled={!on} onClick={() => setExportTableDataMode(item.id, "sample")}>自动样例</button>
                            </div>
                          </div>
                        )
                      })}
                      {!schemas.length && <p className="text-sm text-muted-foreground">还没有表</p>}
                    </div>
                  </section>
                </div>
                {message && <p className="mt-4 text-sm text-destructive">{message}</p>}
              </>
            )}
            {exportStep === "preview" && exportPreview && (
              <>
                <p className="import-hint">将下载的包内容如下。关联表若被依赖带入，会标在策略里。</p>
                <div className="import-blueprint">
                  <div className="import-blueprint-bar"><b>{exportPreview.name}</b><span>{exportPreview.schemas.length} 表 · {exportPreview.views.length} 视图 · {exportPreview.samples.length} 样例</span></div>
                  <table>
                    <thead><tr><th>类型</th><th>名称</th><th>说明</th></tr></thead>
                    <tbody>
                      {exportPreview.schemas.map((item) => <tr key={item.name}><td><span className="import-chip">表</span></td><td>{item.name}</td><td>{item.fields.length} 字段</td></tr>)}
                      {exportPreview.views.map((item) => <tr key={"v-" + item.name}><td><span className="import-chip">视图</span></td><td>{item.name}</td><td>→ {item.schemaName} · 快捷 {(item.shortcuts ?? []).length}</td></tr>)}
                      {exportPreview.samples.length ? <tr><td><span className="import-chip">样例</span></td><td>{exportPreview.samples.length} 行</td><td>跨表演示数据</td></tr> : <tr><td><span className="import-chip">样例</span></td><td>—</td><td>未包含</td></tr>}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {exportStep === "done" && exportPreview && (
              <div className="import-done">
                <h3>已导出</h3>
                <p>文件已写入应用 exports 目录，可发给同事用「导入 / 复刻包」打开。</p>
                <div className="import-done-stats">
                  <div><b>{exportPreview.schemas.length}</b><span>表</span></div>
                  <div><b>{exportPreview.views.length}</b><span>视图</span></div>
                  <div><b>{exportPreview.samples.length}</b><span>样例</span></div>
                </div>
                {!!exportFilePath && (
                  <div className="export-path-box">
                    <span className="export-path-label">文件位置</span>
                    <code className="export-path-value">{exportFilePath}</code>
                  </div>
                )}
                <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                  <button type="button" className="h-10 rounded-xl border border-border bg-card px-4 text-sm" disabled={!exportFilePath} onClick={() => openExported("folder")}>
                    打开所在位置
                  </button>
                  <button type="button" className="h-10 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground" disabled={!exportFilePath} onClick={() => openExported("file")}>
                    打开导出文件
                  </button>
                </div>
              </div>
            )}
          </div>
          <div className="import-flow-actions">
            <button type="button" className="h-10 rounded-xl px-3 text-sm text-muted-foreground hover:bg-secondary" onClick={() => {
              if (exportStep === "select") resetImport()
              else if (exportStep === "preview") setExportStep("select")
              else resetImport()
            }}>{exportStep === "select" || exportStep === "done" ? "返回入口" : "上一步"}</button>
            <div className="flex gap-2">
              {exportStep === "select" && <button type="button" className="h-10 rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground disabled:opacity-40" disabled={busy} onClick={() => buildExportPreview()}>{busy ? "生成中…" : "预览包"}</button>}
              {exportStep === "preview" && <button type="button" className="h-10 rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground disabled:opacity-40" disabled={busy} onClick={() => downloadExportPack()}>{busy ? "导出中…" : "导出 .caskpack"}</button>}
              {exportStep === "done" && <button type="button" className="h-10 rounded-xl border border-border px-4 text-sm" onClick={openExportFlow}>再导出</button>}
            </div>
          </div>
        </section>
      </div>
    )
  }

  if (deskMode === "pack") {
    return (
      <div className="import-flow">
        <aside className="import-flow-left">
          <div className="import-flow-brand">
            <p className="import-kicker">PACK</p>
            <button type="button" className="import-back" onClick={resetImport}>返回入口</button>
          </div>
          <h1 className="import-flow-title">导入 / 复刻包</h1>
          <p className="import-flow-lede">有则导入，无则跳过。不必再拆结构与体系。</p>
          <div className="import-paths">
            {packPathMeta.map((item, index) => {
              const on = item.id === packStep
              const done = index < packReached
              return (
                <button key={item.id} type="button" className={"import-path " + (on ? "is-on" : "") + (done ? " is-done" : "")} disabled={index > packReached} onClick={() => index <= packReached && setPackStep(item.id)}>
                  <span className="import-path-row"><span className="import-path-num">{done && !on ? "✓" : index + 1}</span><span className="import-path-t">{item.title}</span></span>
                  <span className="import-path-d">{item.desc}</span>
                </button>
              )
            })}
          </div>
        </aside>
        <section className="import-flow-right">
          <div className="import-flow-top">
            <h2>{packPathMeta[packReached]?.title ?? "包"}</h2>
            <span className="import-pill">步骤 {packReached + 1} / {packPathMeta.length}</span>
          </div>
          <div className="import-flow-body">
            {packStep === "source" && (
              <>
                <p className="import-hint">拖放 .caskpack / .json 包文件，或点击选择。</p>
                <div className="import-drop rounded-2xl bg-muted p-2">
                  <FileDropzone
                    className="bg-muted"
                    multiple={false}
                    maxFiles={1}
                    files={packFiles}
                    accept={{
                      "application/json": [".json", ".caskpack.json"],
                      "application/octet-stream": [".caskpack"],
                    }}
                    onFiles={(files) => {
                      const file = files[0]
                      if (!file) {
                        setPackFiles([])
                        return
                      }
                      pickPack(file).catch((err) => setMessage(String(err instanceof Error ? err.message : err)))
                    }}
                    onReject={() => setMessage("不支持的文件类型，请使用 .caskpack.json")}
                  />
                </div>
                {message && <p className="mt-3 text-sm text-destructive">{message}</p>}
              </>
            )}
            {packStep === "preview" && pack && (
              <>
                <p className="import-hint">包内对象一览。缺省类型会自动跳过。</p>
                <div className="import-blueprint">
                  <div className="import-blueprint-bar"><b>{pack.name}</b><span>{pack.schemas.length} 表 · {pack.views.length} 视图 · {pack.samples.length} 样例</span></div>
                  <table>
                    <thead><tr><th>类型</th><th>名称</th><th>策略</th></tr></thead>
                    <tbody>
                      {pack.schemas.map((item) => <tr key={"s-" + item.name}><td><span className="import-chip">表</span></td><td>{item.name}</td><td>{item.fields.length} 字段 · 将创建</td></tr>)}
                      {pack.views.length ? pack.views.map((item) => <tr key={"v-" + item.name}><td><span className="import-chip">视图</span></td><td>{item.name}</td><td>→ {item.schemaName} · 将创建</td></tr>) : <tr><td><span className="import-chip">视图</span></td><td>—</td><td>包内无 · 跳过</td></tr>}
                      {pack.samples.length ? <tr><td><span className="import-chip">样例</span></td><td>{pack.samples.length} 行</td><td>写入新建表</td></tr> : <tr><td><span className="import-chip">样例</span></td><td>—</td><td>包内无 · 跳过</td></tr>}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {packStep === "conflict" && (
              <>
                <p className="import-hint">本地已有同名表或视图时：</p>
                <div className="import-conflict">
                  <button type="button" className={"import-conflict-item " + (packConflict === "skip" ? "is-on" : "")} onClick={() => setPackConflict("skip")}>
                    <b>同名则跳过</b><span>保留本地已有，只补包里多出来的对象</span>
                  </button>
                  <button type="button" className={"import-conflict-item " + (packConflict === "rename" ? "is-on" : "")} onClick={() => setPackConflict("rename")}>
                    <b>始终新建副本</b><span>名称自动加后缀，不覆盖本地</span>
                  </button>
                </div>
                {message && <p className="mt-3 text-sm text-destructive">{message}</p>}
              </>
            )}
            {packStep === "done" && packResult && (
              <div className="import-done">
                <h3>已按包写入</h3>
                <p>仅创建包内存在的对象；缺省部分已跳过。</p>
                <div className="import-done-stats">
                  <div><b>{packResult.created.schemas}</b><span>新建表</span></div>
                  <div><b>{packResult.created.views}</b><span>新建视图</span></div>
                  <div><b>{packResult.created.samples}</b><span>样例行</span></div>
                </div>
                {(packResult.skipped.schemas > 0 || packResult.skipped.views > 0) && (
                  <p className="mt-4 text-xs text-muted-foreground">跳过 {packResult.skipped.schemas} 表 · {packResult.skipped.views} 视图（同名）</p>
                )}
              </div>
            )}
          </div>
          <div className="import-flow-actions">
            <button type="button" className="h-10 rounded-xl px-3 text-sm text-muted-foreground hover:bg-secondary" onClick={() => {
              if (packStep === "source") resetImport()
              else if (packStep === "preview") setPackStep("source")
              else if (packStep === "conflict") setPackStep("preview")
              else resetImport()
            }}>{packStep === "done" || packStep === "source" ? "返回入口" : "上一步"}</button>
            <div className="flex gap-2">
              {packStep === "preview" && <button type="button" className="h-10 rounded-xl border border-border px-4 text-sm" onClick={() => setPackStep("conflict")}>继续</button>}
              {packStep === "conflict" && <button type="button" className="h-10 rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground disabled:opacity-40" disabled={busy || !pack} onClick={() => runPackImport()}>{busy ? "写入中…" : "执行导入"}</button>}
              {packStep === "done" && <button type="button" className="h-10 rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground" onClick={onDone}>去数据里查看</button>}
            </div>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="import-flow">
      <aside className="import-flow-left">
        <div className="import-flow-brand">
          <p className="import-kicker">DATA</p>
          <button type="button" className="import-back" onClick={resetImport}>返回入口</button>
        </div>
        <h1 className="import-flow-title">导入数据</h1>
        <p className="import-flow-lede">文件或动态文本，再进入目标表与匹配。</p>
        <div className="import-paths">
          {dataPathMeta.map((item, index) => {
            const on = item.id === step
            const done = index < reached
            return (
              <button key={item.id} type="button" className={"import-path " + (on ? "is-on" : "") + (done ? " is-done" : "")} disabled={index > reached} onClick={() => index <= reached && setStep(item.id)}>
                <span className="import-path-row"><span className="import-path-num">{done && !on ? "✓" : index + 1}</span><span className="import-path-t">{item.title}</span></span>
                <span className="import-path-d">{item.desc}</span>
              </button>
            )
          })}
        </div>
      </aside>
      <section className="import-flow-right">
        <div className="import-flow-top">
          <h2>{stepName[step]}</h2>
          <span className="import-pill">步骤 {reached + 1} / {path.length}</span>
        </div>
        <div className="import-flow-body !p-0">
        {step === "home" && (
          <div className="p-6">
            <p className="import-hint">先选数据形态。文件走表格解析；动态文本用脚本（或 AI）拆成列，再进入同一套匹配与关联。</p>
            <div className="mt-2 grid max-w-3xl gap-4 md:grid-cols-2">
              <button type="button" className={"rounded-3xl border p-6 text-left transition-all " + (source === "file" ? "border-foreground bg-card shadow-sm" : "border-border hover:border-foreground/30")} onClick={() => setSource("file")}>
                <span className={"inline-flex h-6 items-center rounded-full px-2.5 text-[11px] tracking-wide " + (source === "file" ? "bg-foreground text-background" : "bg-secondary text-muted-foreground")}>结构化</span>
                <strong className="mt-4 block text-2xl font-semibold tracking-tight">文件</strong>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">CSV 或 Excel。适合已有表头、列清晰的工作表。</p>
                <div className="mt-5 flex flex-wrap gap-2 text-[11px] text-muted-foreground"><span className="rounded-full border border-border px-2 py-0.5">CSV</span><span className="rounded-full border border-border px-2 py-0.5">XLSX</span><span className="rounded-full border border-border px-2 py-0.5">多 Sheet</span></div>
              </button>
              <button type="button" className={"rounded-3xl border p-6 text-left transition-all " + (source === "text" ? "border-foreground bg-card shadow-sm" : "border-border hover:border-foreground/30")} onClick={() => setSource("text")}>
                <span className={"inline-flex h-6 items-center rounded-full px-2.5 text-[11px] tracking-wide " + (source === "text" ? "bg-foreground text-background" : "bg-secondary text-muted-foreground")}>可编程</span>
                <strong className="mt-4 block text-2xl font-semibold tracking-tight">动态文本</strong>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">粘贴日志、键值串。用模板、手写脚本或 AI 生成解析器。</p>
                <div className="mt-5 flex flex-wrap gap-2 text-[11px] text-muted-foreground"><span className="rounded-full border border-border px-2 py-0.5">脚本</span><span className="rounded-full border border-border px-2 py-0.5">AI 识别</span><span className="rounded-full border border-border px-2 py-0.5">模板</span></div>
              </button>
            </div>
            <div className="mt-8 flex justify-end">
              <button className="h-10 rounded-xl bg-primary px-5 text-sm text-primary-foreground" onClick={() => setStep(source === "text" ? "text" : "file")}>继续</button>
            </div>
            {message && <p className="mt-4 text-sm text-destructive">{message}</p>}
          </div>
        )}

        {step === "file" && !sheets.length && (
          <StepFrame title="选择文件">
            <p className="text-sm text-muted-foreground">拖入 CSV / Excel。</p>
            <div className="mt-4 rounded-2xl bg-muted p-2">
              <FileDropzone
                className="bg-muted"
                multiple={false}
                maxFiles={1}
                files={dataFiles}
                accept={{
                  "text/csv": [".csv"],
                  "application/vnd.ms-excel": [".xls"],
                  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
                }}
                onFiles={(files) => {
                  const file = files[0]
                  if (!file) {
                    setDataFiles([])
                    return
                  }
                  setDataFiles([file])
                  pick(file).catch((err) => setMessage(String(err instanceof Error ? err.message : err)))
                }}
                onReject={() => setMessage("请拖入 CSV 或 Excel 文件")}
              />
            </div>
            <StepNav onBack={() => setStep("home")} />
            {message && <p className="mt-3 text-sm text-destructive">{message}</p>}
          </StepFrame>
        )}

        {step === "file" && !!sheets.length && (
          <StepFrame title="工作表">
            <p className="text-sm text-muted-foreground">勾选要导入的工作表。上面的先写入，下面的可以引用它。</p>
            <ul className="mt-4 space-y-2">{sheets.map((sheet, index) => <li key={sheet.name}><label className="flex items-center gap-2 text-sm"><Checkbox checked={chosen.includes(index)} onCheckedChange={(checked) => setChosen(checked ? [...new Set([...chosen, index])] : chosen.filter((item) => item !== index))} />{sheet.name} · {sheet.rows.length} 行</label></li>)}</ul>
            <StepNav onBack={() => { setSheets([]); setStep("home") }} onNext={() => setStep("targets")} />
          </StepFrame>
        )}

        {step === "text" && (
          <StepFrame title="粘贴原文">
            <p className="text-sm text-muted-foreground">任意文本。AI 或解析器会拆成列，不会直接写库。</p>
            <textarea className="mt-4 min-h-[220px] w-full resize-y rounded-2xl border border-border bg-background p-4 text-sm leading-relaxed outline-none" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="在此粘贴…" value={rawText} onChange={(event) => setRawText(event.target.value)} />
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-secondary/30 px-4 py-3">
              <div>
                <p className="text-sm font-medium">AI 自动识别结构</p>
                <p className="mt-0.5 text-xs text-muted-foreground">生成 preprocess + parseLine，试跑通过后再采用。</p>
              </div>
              <button className="h-9 rounded-xl bg-foreground px-4 text-sm text-background disabled:opacity-40" disabled={!rawText.trim() || busy} onClick={() => runAi()}>{busy ? "识别中…" : "AI 识别"}</button>
            </div>
            <div className="mt-6 flex flex-wrap gap-2">
              <button className="h-9 rounded-lg border border-border px-4 text-sm" onClick={() => setStep("home")}>上一步</button>
              <button className="h-9 rounded-lg border border-border px-4 text-sm" disabled={!rawText.trim()} onClick={() => setStep("parser")}>手动选择解析器</button>
              <button className="h-9 rounded-lg bg-primary px-4 text-sm text-primary-foreground disabled:opacity-40" disabled={!rawText.trim() || busy} onClick={() => runAi()}>AI 识别并继续</button>
            </div>
            {message && <p className="mt-3 text-sm text-destructive">{message}</p>}
          </StepFrame>
        )}

        {step === "ai" && (
          <StepFrame title="AI 识别">
            <p className="text-sm text-muted-foreground">AI 只写解析脚本，不写数据。必须试跑成功才能继续。</p>
            <div className="mt-4 rounded-2xl border border-border bg-foreground px-5 py-5 text-background">
              <p className="text-[11px] tracking-[0.16em] text-background/60">{busy ? "GENERATING" : tryResult && !tryResult.hardFail ? "READY" : "IDLE"}</p>
              <p className="mt-2 text-lg font-medium">{busy ? "正在阅读原文并起草脚本…" : tryResult && !tryResult.hardFail ? "识别完成 · 试跑通过" : message || "等待识别"}</p>
              {aiNotes && <p className="mt-2 text-sm text-background/70">{aiNotes}</p>}
            </div>
            {tryResult && !tryResult.hardFail && (
              <div className="mt-4 overflow-hidden rounded-2xl border border-border">
                <div className="flex flex-wrap gap-2 border-b border-border bg-secondary/30 px-4 py-2 text-[11px] text-muted-foreground">
                  <span>{tryResult.stats.linesIn} lines in</span>
                  <span>{tryResult.stats.rowsOut} rows out</span>
                  <span>{tryResult.stats.skipped} skipped</span>
                  <span>width {tryResult.stats.width}</span>
                </div>
                <div className="max-h-64 overflow-auto">
                  <table className="w-full text-sm">
                    <thead><tr>{tryResult.sheet.columns.map((c) => <th key={c} className="border-b border-border px-3 py-2 text-left text-xs text-muted-foreground">{c}</th>)}</tr></thead>
                    <tbody>{tryResult.sheet.rows.slice(0, 8).map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j} className="border-b border-border px-3 py-2">{cell || "—"}</td>)}</tr>)}</tbody>
                  </table>
                </div>
              </div>
            )}
            <div className="mt-6 flex flex-wrap gap-2">
              <button className="h-9 rounded-lg border border-border px-4 text-sm" onClick={() => setStep("text")}>返回原文</button>
              <button className="h-9 rounded-lg border border-border px-4 text-sm" disabled={busy} onClick={() => runAi()}>重新识别</button>
              <button className="h-9 rounded-lg border border-border px-4 text-sm" onClick={() => setStep("parser")}>打开脚本</button>
              <button className="h-9 rounded-lg bg-primary px-4 text-sm text-primary-foreground disabled:opacity-40" disabled={!tryResult || tryResult.hardFail} onClick={() => setStep("targets")}>采用并继续</button>
            </div>
            {message && <p className="mt-3 text-sm text-destructive">{message}</p>}
          </StepFrame>
        )}

        {step === "parser" && (
          <StepFrame title="解析器">
            <p className="text-sm text-muted-foreground">选模板或改脚本，试跑通过后再进目标表。</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {parsers.map((p) => (
                <button key={p.id} type="button" className={"h-8 rounded-full border px-3 text-xs " + (parserId === p.id ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")} onClick={() => applyParser(p)}>
                  {p.name}{p.builtIn ? "" : " · 我的"}
                </button>
              ))}
              <button type="button" className="h-8 rounded-full border border-dashed border-border px-3 text-xs text-muted-foreground" onClick={() => { setParserId(""); setPreprocessSource(""); setParseLineSource("export function parseLine(line) {\n  return line.split(/,/)\n}\n") }}>空白脚本</button>
              <button type="button" className="h-8 rounded-full border border-border px-3 text-xs" disabled={!rawText.trim() || busy} onClick={() => runAi()}>AI 再识别</button>
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <div className="rounded-2xl border border-border bg-background p-3">
                <div className="mb-2 flex gap-2">
                  <button type="button" className={"h-7 rounded-full px-2.5 text-[11px] " + (scriptTab === "line" ? "bg-foreground text-background" : "text-muted-foreground")} onClick={() => setScriptTab("line")}>parseLine</button>
                  <button type="button" className={"h-7 rounded-full px-2.5 text-[11px] " + (scriptTab === "pre" ? "bg-foreground text-background" : "text-muted-foreground")} onClick={() => setScriptTab("pre")}>preprocess</button>
                </div>
                <textarea
                  className="min-h-[260px] w-full resize-y rounded-xl border-0 bg-transparent font-mono text-xs leading-relaxed outline-none"
                  autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  value={scriptTab === "line" ? parseLineSource : preprocessSource}
                  onChange={(event) => scriptTab === "line" ? setParseLineSource(event.target.value) : setPreprocessSource(event.target.value)}
                  placeholder={scriptTab === "line" ? "export function parseLine(line) { ... }" : "export function preprocess(raw) { ... }（可空）"}
                />
              </div>
              <div className="rounded-2xl border border-border bg-background p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] tracking-[0.14em] text-muted-foreground">TRY RUN</p>
                  <button className="h-8 rounded-lg bg-foreground px-3 text-xs text-background disabled:opacity-40" disabled={busy || !rawText.trim() || !parseLineSource.trim()} onClick={() => runParser()}>{busy ? "…" : "试跑"}</button>
                </div>
                {tryResult && (
                  <>
                    <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                      <span className="rounded-full bg-secondary px-2 py-0.5">{tryResult.stats.linesIn} in</span>
                      <span className="rounded-full bg-secondary px-2 py-0.5">{tryResult.stats.rowsOut} out</span>
                      <span className="rounded-full bg-secondary px-2 py-0.5">{tryResult.stats.skipped} skipped</span>
                      <span className="rounded-full bg-secondary px-2 py-0.5">w{tryResult.stats.width}</span>
                      {tryResult.hardFail && <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-destructive">失败</span>}
                    </div>
                    {!tryResult.hardFail && (
                      <div className="mt-3 max-h-56 overflow-auto rounded-xl border border-border">
                        <table className="w-full text-xs">
                          <thead><tr>{tryResult.sheet.columns.map((c) => <th key={c} className="border-b border-border px-2 py-1.5 text-left text-muted-foreground">{c}</th>)}</tr></thead>
                          <tbody>{tryResult.sheet.rows.slice(0, 12).map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j} className="border-b border-border px-2 py-1.5">{cell || "—"}</td>)}</tr>)}</tbody>
                        </table>
                      </div>
                    )}
                    {!!tryResult.errors.length && (
                      <ul className="mt-3 space-y-1 text-xs text-destructive">
                        {tryResult.errors.slice(0, 5).map((err, i) => <li key={i}>{err.phase}{err.lineNo ? " L" + err.lineNo : ""}: {err.message}</li>)}
                      </ul>
                    )}
                  </>
                )}
                {!tryResult && <p className="mt-8 text-sm text-muted-foreground">点试跑查看结果表。</p>}
              </div>
            </div>
            <div className="mt-6 flex flex-wrap gap-2">
              <button className="h-9 rounded-lg border border-border px-4 text-sm" onClick={() => setStep("text")}>上一步</button>
              <button className="h-9 rounded-lg border border-border px-4 text-sm" disabled={busy || !parseLineSource.trim()} onClick={async () => {
                const name = window.prompt("保存为模板名称", parsers.find((p) => p.id === parserId)?.name || "我的解析器")
                if (!name?.trim()) return
                try {
                  const saved = await call<{ id: string }>("saveTextParser", { name: name.trim(), preprocessSource, parseLineSource, sampleRaw: rawText })
                  const list = await call<{ parsers: TextParserDef[] }>("listTextParsers")
                  setParsers(list.parsers)
                  setParserId(saved.id)
                  toast.add({ title: "解析器已保存", type: "success" })
                } catch (err) {
                  toast.add({ title: "保存失败", description: String(err instanceof Error ? err.message : err), type: "error" })
                }
              }}>保存为模板</button>
              <button className="h-9 rounded-lg bg-primary px-4 text-sm text-primary-foreground disabled:opacity-40" disabled={!tryResult || tryResult.hardFail} onClick={() => setStep("targets")}>下一步 · 目标表</button>
            </div>
            {message && <p className="mt-3 text-sm text-destructive">{message}</p>}
          </StepFrame>
        )}

        {step === "targets" && <StepFrame title="目标表"><p className="text-sm text-muted-foreground">每张结果表写入一个已有 schema。</p><div className="mt-4 space-y-3">{chosen.map((index) => <label key={index} className="flex items-center justify-between gap-3 text-sm"><span>{sheets[index]?.name ?? "表"}</span><AppSelect className="h-9 w-[180px] rounded-lg" value={targets[index] ?? ""} placeholder="选择" emptyLabel="选择" onChange={(value) => setTargets({ ...targets, [index]: value })} options={schemas.map((schema) => ({ value: schema.id, label: schema.name }))} /></label>)}</div><StepNav onBack={backFromTargets} onNext={() => setStep("map")} /></StepFrame>}
        {step === "map" && <StepFrame title="列匹配"><MapStep sheets={sheets} chosen={chosen} schemas={schemas} targets={targets} maps={maps} setMaps={setMaps} refPaths={refPaths} setRefPaths={setRefPaths} onBack={() => setStep("targets")} onNext={() => setStep("refs")} /></StepFrame>}
        {step === "refs" && <StepFrame title="关联"><p className="text-sm text-muted-foreground">引用列按你在列匹配里选的路径，用原文去对目标表字段值。对不上就留空，或跳过整行。</p><label className="mt-4 flex items-center gap-3 text-sm text-muted-foreground">对不上 <AppSelect className="h-9 w-[160px] rounded-lg" value={miss} allowEmpty={false} onChange={(value) => setMiss(value as "blank" | "skip")} options={[{ value: "blank", label: "这一格留空" }, { value: "skip", label: "跳过整行" }]} /></label><StepNav onBack={() => setStep("map")} onNext={() => { setActive(chosen[0] ?? 0); setStep("preview") }} /></StepFrame>}
        {step === "preview" && <Preview sheets={sheets} chosen={chosen} schemas={schemas} targets={targets} maps={maps} refPaths={refPaths} miss={miss} active={active} setActive={setActive} onBack={() => setStep("refs")} onCommit={async (rows) => { await call("commitImport", { rows }); setMessage("已写入 " + rows.length + " 行"); setStep("done") }} />}
        {step === "done" && <StepFrame title="完成"><p className="text-sm text-muted-foreground">{message || "已写入。"}</p><div className="mt-4 flex gap-2"><button className="h-9 rounded-lg bg-primary px-4 text-sm text-primary-foreground" onClick={onDone}>去数据里查看</button><button className="h-9 rounded-lg border border-border px-3 text-sm" onClick={resetImport}>再导入</button></div></StepFrame>}
        </div>
      </section>
    </div>
  )
}

function StepNav({ onBack, onNext, next = "下一步" }: { onBack?: () => void; onNext?: () => void; next?: string }) {
  return (
    <div className="mt-6 flex gap-2">
      {onBack && <button className="h-9 rounded-lg border border-border px-4 text-sm" onClick={onBack}>上一步</button>}
      {onNext && <button className="h-9 rounded-lg bg-primary px-4 text-sm text-primary-foreground" onClick={onNext}>{next}</button>}
    </div>
  )
}

function StepFrame({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="p-6"><p className="mb-4 text-sm text-muted-foreground">{title}</p>{children}</div>
}

function defaultRefMatchPath(target: SchemaRow | undefined): string[] {
  if (!target?.fields.length) return []
  const labeled = target.fields.filter((field) => field.label)
  const leaf = labeled.find((field) => field.type !== "ref") || target.fields.find((field) => field.type !== "ref")
  if (leaf) return [leaf.key]
  return target.fields[0] ? [target.fields[0].key] : []
}

function fieldAlongPath(root: SchemaRow | undefined, path: string[], schemas: SchemaRow[]): Field | undefined {
  if (!path.length) return undefined
  let current = root
  let field: Field | undefined
  for (let i = 0; i < path.length; i++) {
    field = current?.fields.find((item) => item.key === path[i])
    if (!field) return undefined
    if (i < path.length - 1) {
      if (field.type !== "ref") return undefined
      current = schemas.find((item) => item.id === field.schema)
    }
  }
  return field
}

function valueAlongRefPath(row: DataRow, schema: SchemaRow, path: string[], schemas: SchemaRow[], pool: DataRow[]): string {
  let currentRow: DataRow | undefined = row
  let currentSchema: SchemaRow | undefined = schema
  for (let i = 0; i < path.length; i++) {
    if (!currentRow || !currentSchema) return ""
    const key = path[i]
    const field = currentSchema.fields.find((item) => item.key === key)
    if (!field) return ""
    const raw = currentRow.data[key] ?? ""
    if (i === path.length - 1) return raw
    if (field.type !== "ref" || !raw) return ""
    currentRow = pool.find((item) => item.id === raw)
    currentSchema = schemas.find((item) => item.id === field.schema)
  }
  return ""
}

function RefMatchPathPicker({ path, rootSchema, schemas, onChange }: { path: string[]; rootSchema: SchemaRow; schemas: SchemaRow[]; onChange: (path: string[]) => void }) {
  const levels: { schema: SchemaRow; value: string }[] = []
  let schema: SchemaRow | undefined = rootSchema
  for (let i = 0; i < path.length; i++) {
    if (!schema) break
    levels.push({ schema, value: path[i] })
    const field = schema.fields.find((item) => item.key === path[i])
    if (!field || field.type !== "ref") {
      schema = undefined
      break
    }
    schema = schemas.find((item) => item.id === field.schema)
  }
  if (schema) levels.push({ schema, value: "" })
  if (!levels.length && rootSchema) levels.push({ schema: rootSchema, value: "" })

  function setLevel(level: number, key: string) {
    const next = path.slice(0, level)
    if (!key) {
      onChange(next)
      return
    }
    next[level] = key
    const field = levels[level]?.schema.fields.find((item) => item.key === key)
    if (field?.type === "ref") {
      const child = schemas.find((item) => item.id === field.schema)
      const auto = defaultRefMatchPath(child)
      onChange(auto.length ? [...next, ...auto] : next)
    } else {
      onChange(next)
    }
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <span className="text-[11px] text-muted-foreground">用值匹配</span>
      {levels.map((level, i) => (
        <AppSelect
          key={level.schema.id + "-" + i}
          className="h-9 min-w-[120px] rounded-lg"
          height={36}
          value={level.value}
          placeholder="选字段"
          emptyLabel="选字段"
          allowEmpty={false}
          onChange={(value) => setLevel(i, value)}
          options={level.schema.fields.map((field) => ({
            value: field.key,
            label: field.key + (field.type === "ref" ? " →" : ""),
          }))}
        />
      ))}
      {!!path.length && (
        <span className="text-[11px] text-muted-foreground">{path.join(" → ")}</span>
      )}
    </div>
  )
}

function MapStep({ sheets, chosen, schemas, targets, maps, setMaps, refPaths, setRefPaths, onBack, onNext }: {
  sheets: Sheet[]
  chosen: number[]
  schemas: SchemaRow[]
  targets: Record<number, string>
  maps: Record<number, Record<string, string>>
  setMaps: (maps: Record<number, Record<string, string>>) => void
  refPaths: Record<number, Record<string, string[]>>
  setRefPaths: (paths: Record<number, Record<string, string[]>>) => void
  onBack: () => void
  onNext: () => void
}) {
  const [index, setIndex] = useState(chosen[0] ?? 0)
  const sheet = sheets[index]
  const schema = schemas.find((item) => item.id === targets[index])
  if (!sheet || !schema) return <p className="text-sm text-muted-foreground">先在上一步为每张表选好目标。</p>
  const mapping = maps[index] ?? Object.fromEntries(sheet.columns.map((column) => [column, schema.fields.find((field) => field.key === column)?.key ?? ""]))
  const paths = refPaths[index] ?? {}

  function setField(column: string, fieldKey: string) {
    const nextMap = { ...mapping, [column]: fieldKey }
    setMaps({ ...maps, [index]: nextMap })
    const field = schema.fields.find((item) => item.key === fieldKey)
    if (field?.type === "ref") {
      const target = schemas.find((item) => item.id === field.schema)
      setRefPaths({ ...refPaths, [index]: { ...paths, [column]: defaultRefMatchPath(target) } })
    } else {
      const nextPaths = { ...paths }
      delete nextPaths[column]
      setRefPaths({ ...refPaths, [index]: nextPaths })
    }
  }

  return <>
    <p className="mb-3 text-sm text-muted-foreground">写入字段若是引用，继续选「用哪一列的值来对」；选到非引用列为止。</p>
    <div className="mb-3 flex gap-2">{chosen.map((item) => <button key={item} className={"h-8 rounded-lg border px-3 text-sm " + (item === index ? "border-primary text-primary" : "border-border")} onClick={() => setIndex(item)}>{sheets[item].name}</button>)}</div>
    <Table>
      <TableHeader><TableRow><TableHead>文件列</TableHead><TableHead>样例</TableHead><TableHead>写入字段 / 匹配路径</TableHead></TableRow></TableHeader>
      <TableBody>
        {sheet.columns.map((column) => {
          const fieldKey = mapping[column] ?? ""
          const field = schema.fields.find((item) => item.key === fieldKey)
          const target = field?.type === "ref" ? schemas.find((item) => item.id === field.schema) : undefined
          const path = paths[column] ?? (target ? defaultRefMatchPath(target) : [])
          return (
            <TableRow key={column}>
              <TableCell className="align-top">{column}</TableCell>
              <TableCell className="align-top text-muted-foreground">{sheet.rows[0]?.[sheet.columns.indexOf(column)] ?? ""}</TableCell>
              <TableCell className="align-top">
                <AppSelect className="h-9 min-w-[140px] rounded-lg" value={fieldKey} placeholder="不导入" emptyLabel="不导入" onChange={(value) => setField(column, value)} options={schema.fields.map((item) => ({ value: item.key, label: item.key + (item.type === "ref" ? " (引用)" : "") }))} />
                {field?.type === "ref" && target && (
                  <RefMatchPathPicker
                    path={path}
                    rootSchema={target}
                    schemas={schemas}
                    onChange={(next) => setRefPaths({ ...refPaths, [index]: { ...paths, [column]: next } })}
                  />
                )}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
    <StepNav onBack={onBack} onNext={onNext} />
  </>
}

function Preview({ sheets, chosen, schemas, targets, maps, refPaths, miss, active, setActive, onBack, onCommit }: {
  sheets: Sheet[]
  chosen: number[]
  schemas: SchemaRow[]
  targets: Record<number, string>
  maps: Record<number, Record<string, string>>
  refPaths: Record<number, Record<string, string[]>>
  miss: "blank" | "skip"
  active: number
  setActive: (index: number) => void
  onBack: () => void
  onCommit: (rows: DataRow[]) => Promise<void>
}) {
  const { call } = useApp()
  const [pool, setPool] = useState<DataRow[]>([])
  useEffect(() => { call<{ rows: DataRow[] }>("records", {}).then((result) => setPool(result.rows)) }, [])
  const planned = planImport(sheets, chosen, schemas, targets, maps, refPaths, miss, pool)
  const sheetIndex = chosen.includes(active) ? active : chosen[0]
  const table = planned.filter((item) => item.sheet === sheetIndex)
  const schema = schemas.find((item) => item.id === targets[sheetIndex])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-[60px] items-center border-b border-border px-5 font-semibold">确认</header>
      <div className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)]">
        <aside className="overflow-auto border-r border-border bg-muted p-4">
          <p className="text-xs text-muted-foreground">当前表</p>
          {chosen.map((index) => <button key={index} className={"mt-2 flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm " + (index === sheetIndex ? "border-border bg-muted text-foreground" : "border-border bg-card")} onClick={() => setActive(index)}><span>{sheets[index].name}</span><span>{planned.filter((item) => item.sheet === index && !item.skip).length} 行</span></button>)}
          <p className="mt-4 text-sm text-muted-foreground">左边确认引用。对不上的行按「{miss === "skip" ? "跳过" : "留空"}」处理。不删除文件里没有的旧行。</p>
          <ul className="mt-3 space-y-2 text-sm">{table.filter((item) => item.refNote).map((item, index) => <li key={index} className="flex justify-between gap-2"><span>{item.title}</span><span className="text-muted-foreground">{item.refNote}</span></li>)}</ul>
          <StepNav onBack={onBack} onNext={() => onCommit(planned.filter((item) => !item.skip).map((item) => item.row))} next="写入" />
        </aside>
        <div className="overflow-auto p-4">
          <p className="mb-3 text-sm text-muted-foreground">将写入的行。引用列显示对上的名字。</p>
          <table className="w-full text-sm"><thead><tr>{schema?.fields.map((field) => <th key={field.key} className="pb-2 text-left text-xs text-muted-foreground">{field.key}</th>)}</tr></thead>
            <tbody>{table.map((item, index) => <tr key={index} className={item.skip ? "text-muted-foreground" : ""}>{schema?.fields.map((field) => <td key={field.key} className="border-b border-border py-2">{item.display[field.key] || "—"}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function planImport(
  sheets: Sheet[],
  chosen: number[],
  schemas: SchemaRow[],
  targets: Record<number, string>,
  maps: Record<number, Record<string, string>>,
  refPaths: Record<number, Record<string, string[]>>,
  miss: "blank" | "skip",
  existing: DataRow[],
) {
  const staged: DataRow[] = []
  const planned: { sheet: number; skip: boolean; title: string; refNote: string; display: Record<string, string>; row: DataRow }[] = []
  for (const index of chosen) {
    const schema = schemas.find((item) => item.id === targets[index])
    const sheet = sheets[index]
    if (!schema || !sheet) continue
    const mapping = maps[index] ?? {}
    const paths = refPaths[index] ?? {}
    sheet.rows.forEach((cells, rowIndex) => {
      const data: Record<string, string> = {}
      const display: Record<string, string> = {}
      let refNote = ""
      let skip = false
      schema.fields.forEach((field) => {
        const column = Object.entries(mapping).find(([, key]) => key === field.key)?.[0]
        const raw = column ? cells[sheet.columns.indexOf(column)] ?? "" : ""
        if (field.type === "ref" && raw) {
          const targetSchema = schemas.find((item) => item.id === field.schema)
          const pool = [...existing, ...staged]
          const path = (column && paths[column]?.length) ? paths[column] : defaultRefMatchPath(targetSchema)
          const leaf = fieldAlongPath(targetSchema, path, schemas)
          const pathOk = !!leaf && leaf.type !== "ref" && path.length > 0
          const found = pathOk && targetSchema
            ? pool.find((item) => item.schemaId === field.schema && valueAlongRefPath(item, targetSchema, path, schemas, pool) === raw.trim())
            : undefined
          if (found) {
            data[field.key] = found.id
            display[field.key] = importLabel(targetSchema, found, schemas, pool) || raw
            refNote = raw + (path.length ? " → " + path.join(".") : "")
          } else if (miss === "skip") skip = true
          else display[field.key] = ""
        } else {
          data[field.key] = raw
          display[field.key] = raw
        }
      })
      const row: DataRow = { id: "n" + index + "_" + rowIndex + "_" + Math.random().toString(36).slice(2, 6), schemaId: schema.id, data, tags: [], openedAt: 0, sortOrder: 0, createdAt: 0, updatedAt: 0 }
      if (!skip) staged.push(row)
      planned.push({ sheet: index, skip, title: importLabel(schema, row, schemas, [...existing, ...staged]) || rawTitle(cells), refNote, display, row })
    })
  }
  return planned
}

function importLabel(schema: SchemaRow | undefined, row: DataRow, schemas: SchemaRow[], pool: DataRow[]) {
  const seen = new Set<string>()
  const byId = new Map(pool.map((item) => [item.id, item] as const))
  const ctx = { schemas, recordById: (id: string) => byId.get(id) }
  const lookup = (id: string): string | undefined => {
    const target = byId.get(id)
    const targetSchema = schemas.find((item) => item.id === target?.schemaId)
    return target && targetSchema ? labelOf(targetSchema, target, lookup, seen, ctx) : undefined
  }
  return labelOf(schema, row, lookup, seen, ctx)
}

function rawTitle(cells: string[]) { return cells.find(Boolean) ?? "未命名" }

function DeleteDialog({ hits, name, onClose, onChoose }: { hits: { name?: string; field: string }[]; name: string; onClose: () => void; onChoose: (mode: "clear" | "cascade" | "abort") => void }) {
  return (
    <motion.div className="fixed inset-0 grid place-items-center bg-foreground/40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div className="w-[440px] rounded-2xl bg-card p-5 shadow-xl" initial={{ opacity: 0, y: 10, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: "spring", stiffness: 420, damping: 32 }}>
        <h3 className="text-lg font-semibold">删除 {name}</h3>
        <p className="mt-2 text-sm text-muted-foreground">{hits.length ? "还有别的行指向它。" : "没有别的行指向它。"}</p>
        <div className="mt-4 flex flex-col gap-2">
          {hits.length ? <>
            <button className="rounded-lg border border-border px-3 py-3 text-left text-sm" onClick={() => onChoose("clear")}>仍然删除，引用列留空</button>
            <button className="rounded-lg border border-destructive px-3 py-3 text-left text-sm text-destructive" onClick={() => onChoose("cascade")}>仍然删除，连同引用它的行一起删除</button>
            <button className="rounded-lg border border-border px-3 py-3 text-left text-sm" onClick={onClose}>放弃删除，自行处理</button>
          </> : <>
            <button className="rounded-lg border border-destructive px-3 py-3 text-left text-sm text-destructive" onClick={() => onChoose("clear")}>删除</button>
            <button className="rounded-lg border border-border px-3 py-3 text-left text-sm" onClick={() => onChoose("abort")}>取消</button>
          </>}
        </div>
      </motion.div>
    </motion.div>
  )
}
