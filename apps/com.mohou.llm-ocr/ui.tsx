import { useEffect, useRef, useState } from "react"

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Icon,
  Kbd,
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  Switch,
  Textarea,
  Toaster,
  toast,
  useApp,
} from "@mohou/ui"

import {
  DEFAULT_PREFS,
  EMPTY_LAYOUT,
  isLargeCapture,
  isSplitLayout,
  isTemplateLayout,
  listTemplates,
  resolveMode,
  type CustomTemplate,
  type Prefs,
  type RecentItem,
  type SplitLayout,
  type TemplateLayout,
} from "./shared/modes.ts"
import { imageFileFromClipboard, imageFileFromList, isClipboardBlocked, isTextField, loadImage, readImageFile, writeClipboard } from "./ui/clipboard.ts"
import { exportRegion } from "./ui/export-image.ts"
import { nudge, type Region } from "./ui/region.ts"
import { Stage } from "./ui/stage.tsx"
import { TemplatesSheet } from "./ui/templates.tsx"

type Held = { preview: string; name: string; width: number; height: number }
type Scope = "full" | "selection"

type Snapshot = { prefs: Prefs; templates: CustomTemplate[]; recent: RecentItem[]; split: SplitLayout | null; layout: TemplateLayout }
type RecognizeResult = { text?: string; chars?: number; durationMs?: number; recent?: RecentItem[] }
type SaveResult = { template: CustomTemplate; templates: CustomTemplate[]; layout: TemplateLayout }
type DeleteResult = { templates: CustomTemplate[]; prefs: Prefs; layout: TemplateLayout }

function chipClass(on: boolean): string {
  return on
    ? "shrink-0 rounded-full bg-primary px-2.5 py-1 text-xs text-primary-foreground"
    : "shrink-0 rounded-full px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
}

function isCancel(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false
  const code = "code" in cause ? cause.code : ""
  const message = cause instanceof Error ? cause.message : ""
  return code === "cancelled" || message === "已停止"
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message
  return "识别失败"
}

function asSnapshot(value: unknown): Snapshot | null {
  if (!value || typeof value !== "object") return null
  const row = value as Partial<Snapshot>
  if (!row.prefs || !Array.isArray(row.templates) || !Array.isArray(row.recent)) return null
  return {
    prefs: { ...DEFAULT_PREFS, ...row.prefs },
    templates: row.templates,
    recent: row.recent,
    split: isSplitLayout(row.split) ? row.split : null,
    layout: isTemplateLayout(row.layout) ? row.layout : { ...EMPTY_LAYOUT },
  }
}

function countText(text: string): string {
  const chars = Array.from(text.replace(/\s/g, "")).length
  const lines = text.trim() ? text.split("\n").length : 0
  if (!chars) return ""
  return chars + " 字 · " + lines + " 行"
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
}

export default function App() {
  const { call, streamCall } = useApp()
  const root = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const seq = useRef(0)
  const recognizeRef = useRef<(scope: Scope, image?: Held | null, region?: Region | null) => Promise<void>>(async () => {})
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS)
  const [templates, setTemplates] = useState<CustomTemplate[]>([])
  const [layout, setLayout] = useState<TemplateLayout>({ ...EMPTY_LAYOUT })
  const [recent, setRecent] = useState<RecentItem[]>([])
  const [held, setHeld] = useState<Held | null>(null)
  const [selection, setSelection] = useState<Region | null>(null)
  const [text, setText] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [durationMs, setDurationMs] = useState<number | null>(null)
  const [scaled, setScaled] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [booted, setBooted] = useState(false)
  const splitRef = useRef<SplitLayout | null>(null)

  const prefsRef = useRef(prefs)
  const templatesRef = useRef(templates)
  const layoutRef = useRef(layout)
  const heldRef = useRef(held)
  const selectionRef = useRef(selection)
  const runningRef = useRef(running)
  prefsRef.current = prefs
  templatesRef.current = templates
  layoutRef.current = layout
  heldRef.current = held
  selectionRef.current = selection
  runningRef.current = running

  useEffect(() => {
    let gone = false
    void call("snapshot").then((value) => {
      if (gone) return
      const snap = asSnapshot(value)
      if (!snap) return
      setPrefs(snap.prefs)
      setTemplates(snap.templates)
      setLayout(snap.layout)
      setRecent(snap.recent)
      splitRef.current = snap.split
    }).catch((cause: unknown) => {
      if (!gone) setError(messageOf(cause))
    }).finally(() => {
      if (!gone) setBooted(true)
    })
    return () => { gone = true }
  }, [])

  async function persistPrefs(next: Prefs) {
    setPrefs(next)
    try {
      const saved = await call("savePrefs", next) as Prefs
      setPrefs(saved)
    } catch (cause) {
      toast.add({ title: messageOf(cause), type: "error" })
    }
  }

  async function takeFile(file: File) {
    try {
      const read = await readImageFile(file)
      const image = await loadImage(read.preview)
      const next: Held = {
        preview: read.preview,
        name: read.name,
        width: image.naturalWidth,
        height: image.naturalHeight,
      }
      setHeld(next)
      setSelection(null)
      setError(null)
      setScaled(false)
      const large = isLargeCapture(next.width, next.height)
      const current = prefsRef.current
      if (current.autoRecognize && !(large && current.pauseOnLarge)) {
        void recognize("full", next, null)
      }
    } catch (cause) {
      toast.add({ title: messageOf(cause), type: "error" })
    }
  }

  const takeRef = useRef(takeFile)
  takeRef.current = takeFile

  useEffect(() => {
    const doc = root.current?.ownerDocument
    if (!doc) return
    const onPaste = (event: Event) => {
      const paste = event as ClipboardEvent
      const file = imageFileFromClipboard(paste.clipboardData)
      if (!file) return
      paste.preventDefault()
      void takeRef.current(file)
    }
    const onOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return
      event.preventDefault()
      setDragOver(true)
    }
    const onLeave = (event: DragEvent) => {
      if (event.relatedTarget == null) setDragOver(false)
    }
    const onDrop = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return
      event.preventDefault()
      setDragOver(false)
      const file = imageFileFromList(event.dataTransfer.files)
      if (!file) {
        toast.add({ title: "只支持 PNG、JPEG、GIF、WebP", type: "error" })
        return
      }
      void takeRef.current(file)
    }
    doc.addEventListener("paste", onPaste)
    doc.addEventListener("dragover", onOver)
    doc.addEventListener("dragleave", onLeave)
    doc.addEventListener("drop", onDrop)
    return () => {
      doc.removeEventListener("paste", onPaste)
      doc.removeEventListener("dragover", onOver)
      doc.removeEventListener("dragleave", onLeave)
      doc.removeEventListener("drop", onDrop)
    }
  }, [])

  useEffect(() => {
    const doc = root.current?.ownerDocument
    if (!doc) return
    const onKey = (event: KeyboardEvent) => {
      const typing = isTextField(event.target)
      const mod = event.metaKey || event.ctrlKey
      if (event.key === "Enter" && mod) {
        event.preventDefault()
        if (!runningRef.current && heldRef.current) {
          void recognizeRef.current(selectionRef.current ? "selection" : "full")
        }
        return
      }
      if (typing) return
      if (event.key === "Escape" && selectionRef.current) {
        event.preventDefault()
        setSelection(null)
        return
      }
      if (event.key.startsWith("Arrow") && selectionRef.current && heldRef.current) {
        event.preventDefault()
        const step = event.shiftKey ? 10 : 1
        setSelection(nudge(selectionRef.current, event.key, step, heldRef.current.width, heldRef.current.height))
      }
    }
    doc.addEventListener("keydown", onKey)
    return () => doc.removeEventListener("keydown", onKey)
  }, [])

  async function recognize(scope: Scope, image: Held | null = heldRef.current, region: Region | null = selectionRef.current) {
    if (!image) return
    if (scope === "selection" && !region) return
    const ticket = ++seq.current
    setRunning(true)
    setError(null)
    setText("")
    setDurationMs(null)
    const mode = resolveMode(prefsRef.current.modeId, templatesRef.current, layoutRef.current)
    try {
      const bitmap = await loadImage(image.preview)
      if (ticket !== seq.current) return
      const exported = exportRegion(bitmap, scope === "selection" ? region : null)
      setScaled(exported.scaled)
      const pending = streamCall("recognize", {
        prompt: mode.prompt,
        mimeType: exported.mimeType,
        data: exported.data,
        modeName: mode.name,
      })
      let body = ""
      for await (const chunk of pending) {
        if (ticket !== seq.current) return
        if (typeof chunk !== "string" || !chunk) continue
        body += chunk
        setText(body)
      }
      const summary = await pending as RecognizeResult | undefined
      if (ticket !== seq.current) return
      const finalText = typeof summary?.text === "string" ? summary.text : body
      setText(finalText)
      setDurationMs(typeof summary?.durationMs === "number" ? summary.durationMs : null)
      if (Array.isArray(summary?.recent)) setRecent(summary.recent)
      if (!finalText.trim()) {
        setError("这张图里没有读到文字。")
        return
      }
      if (prefsRef.current.autoCopy) {
        const copied = await copyIfAllowed(finalText)
        if (ticket !== seq.current) return
        if (copied) toast.add({ title: "已复制", description: countText(finalText), type: "success" })
        else selectResult()
      }
    } catch (cause) {
      if (ticket !== seq.current || isCancel(cause)) return
      setError(messageOf(cause))
    } finally {
      if (ticket === seq.current) setRunning(false)
    }
  }
  recognizeRef.current = recognize

  async function stop() {
    seq.current += 1
    setRunning(false)
    try {
      await call("cancel")
    } catch (cause) {
      setError(messageOf(cause))
    }
  }

  async function copyIfAllowed(value: string): Promise<boolean> {
    try {
      await writeClipboard(value)
      return true
    } catch (cause) {
      if (isClipboardBlocked(cause)) return false
      throw cause
    }
  }

  function selectResult() {
    const node = root.current?.querySelector("textarea")
    if (!(node instanceof HTMLTextAreaElement)) return
    node.focus()
    node.setSelectionRange(0, node.value.length)
  }

  async function copyText(value: string) {
    if (!value) return
    try {
      await writeClipboard(value)
      toast.add({ title: "已复制", description: countText(value), type: "success" })
    } catch (cause) {
      if (isClipboardBlocked(cause)) {
        selectResult()
        toast.add({ title: "系统没有允许写入剪贴板", description: "文字已选中，用 ⌘C 或 Ctrl+C", type: "error" })
        return
      }
      toast.add({ title: messageOf(cause), type: "error" })
    }
  }

  function selectMode(id: string) {
    void persistPrefs({ ...prefsRef.current, modeId: id })
    setSheetOpen(false)
  }

  async function saveTemplate(draft: { id: string; name: string; prompt: string }) {
    try {
      const result = await call("saveTemplate", draft) as SaveResult
      setTemplates(result.templates)
      setLayout(result.layout)
      await persistPrefs({ ...prefsRef.current, modeId: result.template.id })
      toast.add({ title: "模板已保存", type: "success" })
    } catch (cause) {
      toast.add({ title: messageOf(cause), type: "error" })
      throw cause
    }
  }

  async function deleteTemplate(id: string) {
    const result = await call("deleteTemplate", { id }) as DeleteResult
    setTemplates(result.templates)
    setLayout(result.layout)
    setPrefs(result.prefs)
  }

  async function moveTemplate(id: string, direction: -1 | 1) {
    const rows = listTemplates(templatesRef.current, layoutRef.current)
    const index = rows.findIndex((row) => row.id === id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= rows.length) return
    const ids = rows.map((row) => row.id)
    const [moved] = ids.splice(index, 1)
    ids.splice(target, 0, moved)
    const previous = layoutRef.current
    setLayout({ ...previous, order: ids })
    try {
      const saved = await call("reorderTemplates", { ids }) as { layout: TemplateLayout }
      setLayout(saved.layout)
    } catch (cause) {
      setLayout(previous)
      toast.add({ title: messageOf(cause), type: "error" })
    }
  }

  async function restoreBuiltins() {
    try {
      const saved = await call("restoreBuiltins") as { layout: TemplateLayout }
      setLayout(saved.layout)
      toast.add({ title: "已恢复内置模板", type: "success" })
    } catch (cause) {
      toast.add({ title: messageOf(cause), type: "error" })
    }
  }

  function clearImage() {
    seq.current += 1
    setHeld(null)
    setSelection(null)
    setScaled(false)
    if (runningRef.current) {
      setRunning(false)
      void call("cancel")
    }
  }

  const rows = listTemplates(templates, layout)
  const mode = resolveMode(prefs.modeId, templates, layout)
  const large = held ? isLargeCapture(held.width, held.height) : false
  const monospace = mode.id === "layout"
  const stats = [countText(text), durationMs != null ? (durationMs / 1000).toFixed(1) + "s" : "", scaled ? "已缩小" : ""]
    .filter(Boolean)
    .join(" · ")

  return (
    <div ref={root} tabIndex={-1} className="glance relative h-full min-h-0 bg-background text-foreground outline-none">
      {booted ? (
      <ResizablePanelGroup
        id="glance-split"
        orientation="horizontal"
        className="h-full min-h-0"
        defaultLayout={splitRef.current ?? undefined}
        resizeTargetMinimumSize={{ coarse: 28, fine: 12 }}
        onLayoutChanged={(layout, meta) => {
          if (!meta.isUserInteraction) return
          const stage = layout.stage
          const read = layout.read
          if (typeof stage !== "number" || typeof read !== "number") return
          void call("saveSplit", { stage, read }).catch((cause: unknown) => {
            toast.add({ title: messageOf(cause), type: "error" })
          })
        }}
      >
      <ResizablePanel id="stage" defaultSize="52%" minSize="32%" className="min-h-0">
        <Stage
          preview={held?.preview ?? null}
          name={held?.name ?? ""}
          width={held?.width ?? 0}
          height={held?.height ?? 0}
          selection={selection}
          large={large && prefs.pauseOnLarge}
          running={running}
          onSelection={setSelection}
          onRecognizeFull={() => void recognize("full")}
          onRecognizeSelection={() => void recognize("selection")}
          onClearImage={clearImage}
          onPickFile={() => fileRef.current?.click()}
        />
      </ResizablePanel>
      <ResizableHandle withHandle aria-label="拖动调整左右宽度" />
      <ResizablePanel id="read" defaultSize="48%" minSize={320} className="min-h-0">
        <section className="glance-readcol flex h-full min-h-0 min-w-0 flex-col bg-card" aria-label="识别结果">
          <div className="border-border border-b px-4 py-3">
            <div className="flex items-baseline justify-between gap-2">
              <h1 className="text-[15px] font-medium tracking-tight">识图</h1>
              <span className="text-muted-foreground flex items-center gap-1 text-[11px]">
                <Kbd>⌘</Kbd><Kbd>V</Kbd>
              </span>
            </div>
            <p className="text-muted-foreground mt-0.5 text-xs">左侧贴图，右侧出字。</p>
          </div>

          <div data-glance="modes" className="flex flex-wrap items-center gap-1 px-4 pt-3">
            {rows.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={mode.id === item.id}
                className={chipClass(mode.id === item.id)}
                onClick={() => selectMode(item.id)}
              >
                {item.name}
              </button>
            ))}
            <button type="button" className={chipClass(false)} aria-label="管理模板" onClick={() => setSheetOpen(true)}>
              <Icon.Plus size={13} />
            </button>
          </div>
          <p className="text-muted-foreground px-4 pt-1.5 text-xs">{mode.blurb}</p>

          <div className="flex flex-wrap items-center gap-1.5 px-4 pt-3">
            {running ? (
              <Button size="sm" variant="outline" onClick={() => void stop()}>
                <Icon.Square size={13} /> 停止
              </Button>
            ) : (
              <Button size="sm" disabled={!held} onClick={() => void recognize(selection ? "selection" : "full")}>
                <Icon.ScanText size={14} /> {selection ? "识别选区" : "识别"}
              </Button>
            )}
            {selection && !running ? (
              <Button size="sm" variant="ghost" disabled={!held} onClick={() => void recognize("full")}>整图</Button>
            ) : null}
            <Button size="sm" variant="outline" disabled={!text} onClick={() => void copyText(text)}>
              <Icon.Copy size={14} /> 复制
            </Button>
            <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()}>选择图片</Button>
            <Button size="sm" variant="ghost" onClick={() => setSheetOpen(true)}>模板</Button>
            <Popover>
              <PopoverTrigger render={<Button size="icon-sm" variant="ghost" aria-label="识别习惯" />}>
                <Icon.SlidersHorizontal size={15} />
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72">
                <PopoverHeader>
                  <PopoverTitle>识别习惯</PopoverTitle>
                  <PopoverDescription>默认按日常截图设好，不用改也能用。</PopoverDescription>
                </PopoverHeader>
                <div className="flex flex-col gap-3 px-3 pb-3">
                  <Habit
                    label="粘贴后立即识别"
                    hint="普通截图一粘贴就开始"
                    checked={prefs.autoRecognize}
                    onChange={(value) => void persistPrefs({ ...prefs, autoRecognize: value })}
                  />
                  <Habit
                    label="识别后自动复制"
                    hint="读完后尝试复制。系统若拦住后台写入，点复制即可"
                    checked={prefs.autoCopy}
                    onChange={(value) => void persistPrefs({ ...prefs, autoCopy: value })}
                  />
                  <Habit
                    label="大图先停一下"
                    hint="整屏和长图等你框选，不直接读完"
                    checked={prefs.pauseOnLarge}
                    onChange={(value) => void persistPrefs({ ...prefs, pauseOnLarge: value })}
                  />
                </div>
              </PopoverContent>
            </Popover>
            {recent.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button size="sm" variant="ghost" />}>
                  <Icon.History size={14} /> 最近
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  {recent.map((item) => (
                    <DropdownMenuItem key={item.id} onClick={() => { setText(item.text); setError(null) }}>
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">{clock(item.at)}</span>
                        <span className="truncate text-sm">{item.text.split("\n").find((line) => line.trim()) || "空白"}</span>
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
          <p className="text-muted-foreground px-4 pt-2 text-[11px] tabular-nums">{stats || "还没有结果"}</p>

          <div className="relative mx-4 mt-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
            {running ? <div className="glance-scan h-0.5 w-full shrink-0" /> : null}
            {error ? <p className="text-destructive px-3 pt-3 text-sm">{error}</p> : null}
            <Textarea
              value={text}
              placeholder={running ? (selection ? "正在读选区…" : "正在读整图…") : "文字会落在这里。可以改完再复制。"}
              onChange={(event) => setText(event.target.value)}
              className={monospace
                ? "glance-read min-h-0 flex-1 resize-none px-3 py-3 font-mono text-[13px] leading-5 whitespace-pre"
                : "glance-read min-h-0 flex-1 resize-none px-3 py-3 text-[15px] leading-7"}
              spellCheck={false}
              aria-label="识别结果"
            />
          </div>
          <p className="text-muted-foreground px-4 py-2.5 text-[11px]">拖中间分隔条可调宽度，会记住 · 框选后双击识别 · ⌘/Ctrl + Enter</p>
        </section>
      </ResizablePanel>
      </ResizablePanelGroup>
      ) : null}

      {dragOver ? (
        <div className="glance-drop pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-2xl border border-dashed border-primary">
          <p className="text-sm">松开，放入截图</p>
        </div>
      ) : null}

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ""
          if (file) void takeFile(file)
        }}
      />
      <TemplatesSheet
        open={sheetOpen}
        rows={rows}
        hiddenCount={layout.hidden.length}
        activeId={mode.id}
        onOpenChange={setSheetOpen}
        onUse={selectMode}
        onSave={saveTemplate}
        onDelete={deleteTemplate}
        onMove={moveTemplate}
        onRestore={restoreBuiltins}
      />
      <Toaster position="bottom-right" timeout={2800} limit={3} />
    </div>
  )
}

function Habit({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        <span className="text-muted-foreground block text-xs">{hint}</span>
      </span>
      <Switch checked={checked} onCheckedChange={(value) => onChange(value === true)} />
    </label>
  )
}
