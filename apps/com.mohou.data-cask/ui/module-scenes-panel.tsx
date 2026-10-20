import { useEffect, useState } from "react"
import { Checkbox, Icon, toast, useApp } from "@mohou/ui"
import type { ModuleInfo } from "../shared/types.ts"

export type ModuleInstallPreview = {
  moduleId: string
  title: string
  description: string
  includeSamples: boolean
  hasSamples: boolean
  sampleCount: number
  sampleTotal: number
  schemas: { name: string; fieldCount: number; fields: string[]; exists: boolean; action: "create" | "reuse" }[]
  views: { name: string; schemaName: string; description: string; exists: boolean; action: "create" | "skip"; baseFilterCount: number; allowWrite: boolean; revealSecretsDefault: boolean }[]
  samples: { schemaName: string; count: number }[]
  summary: { schemaCreate: number; schemaReuse: number; viewCreate: number; viewSkip: number; sampleRows: number }
}

/** Built-in scene modules list + install review dialog. */
export function ModuleScenesPanel({
  variant = "empty",
  onInstalled,
}: {
  variant?: "empty" | "import"
  onInstalled?: (viewId?: string) => Promise<void> | void
}) {
  const { call } = useApp()
  const [modules, setModules] = useState<ModuleInfo[]>([])
  const [loadingModules, setLoadingModules] = useState(true)
  const [modulesError, setModulesError] = useState("")
  const [includeSamples, setIncludeSamples] = useState<Record<string, boolean>>({})
  const [installingId, setInstallingId] = useState("")
  const [review, setReview] = useState<{
    mod: ModuleInfo
    preview: ModuleInstallPreview | null
    loading: boolean
    error: string
  } | null>(null)

  useEffect(() => {
    let alive = true
    setLoadingModules(true)
    setModulesError("")
    call<{ modules: ModuleInfo[]; debug?: Record<string, unknown> }>("listModules")
      .then((res) => {
        if (!alive) return
        const list = Array.isArray(res?.modules) ? res.modules : Array.isArray(res) ? res as unknown as ModuleInfo[] : []
        setModules(list)
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
  }, [call])

  async function openInstallReview(mod: ModuleInfo) {
    if (installingId) return
    const withSamples = !!includeSamples[mod.id] && mod.hasSamples
    setReview({ mod, preview: null, loading: true, error: "" })
    try {
      const preview = await call<ModuleInstallPreview>("previewModule", {
        id: mod.id,
        includeSamples: withSamples,
      })
      setReview({ mod, preview, loading: false, error: "" })
    } catch (err) {
      setReview({
        mod,
        preview: null,
        loading: false,
        error: String(err instanceof Error ? err.message : err),
      })
    }
  }

  async function refreshInstallReview(nextSamples: boolean) {
    if (!review || installingId) return
    const mod = review.mod
    setIncludeSamples((prev) => ({ ...prev, [mod.id]: nextSamples }))
    setReview({ mod, preview: null, loading: true, error: "" })
    try {
      const preview = await call<ModuleInstallPreview>("previewModule", {
        id: mod.id,
        includeSamples: nextSamples && mod.hasSamples,
      })
      setReview({ mod, preview, loading: false, error: "" })
    } catch (err) {
      setReview({
        mod,
        preview: null,
        loading: false,
        error: String(err instanceof Error ? err.message : err),
      })
    }
  }

  async function confirmInstallModule() {
    if (!review || installingId) return
    const mod = review.mod
    const withSamples = !!includeSamples[mod.id] && mod.hasSamples
    setInstallingId(mod.id)
    try {
      const result = await call<{
        primaryViewId?: string
        created?: { schemas: number; views: number; samples: number }
        title?: string
      }>("installModule", {
        id: mod.id,
        includeSamples: withSamples,
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
      setReview(null)
      // refresh list badges
      const res = await call<{ modules: ModuleInfo[] }>("listModules").catch(() => null)
      if (res?.modules) {
        setModules(res.modules)
        setIncludeSamples((prev) => {
          const next = { ...prev }
          for (const item of res.modules) {
            if (next[item.id] === undefined) next[item.id] = !!item.hasSamples
          }
          return next
        })
      }
      await onInstalled?.(result?.primaryViewId || undefined)
    } catch (err) {
      toast.add({ title: "安装失败", description: String(err instanceof Error ? err.message : err), type: "error" })
    } finally {
      setInstallingId("")
    }
  }

  const gridClass =
    variant === "import"
      ? "view-empty-module-grid" + (modules.length === 1 ? " is-one" : modules.length === 2 ? " is-two" : "")
      : "view-empty-module-grid" + (modules.length === 1 ? " is-one" : modules.length === 2 ? " is-two" : "")

  return (
    <div className={variant === "import" ? "module-scenes-import" : "view-empty-modules"}>
      {variant === "empty" && <p className="view-empty-modules-label">工作场景</p>}
      {variant === "import" && (
        <div className="module-scenes-import-head">
          <p className="text-[11px] tracking-[0.16em] text-muted-foreground">内置场景</p>
          <p className="mt-1 text-sm text-muted-foreground">一键装表、视图与示例。装过的可再次安装（同名表复用）。</p>
        </div>
      )}
      {loadingModules && <p className="view-empty-modules-hint">正在读取 modules…</p>}
      {!loadingModules && modulesError && (
        <p className="view-empty-modules-hint" style={{ color: "var(--destructive, #b91c1c)" }}>加载模块失败：{modulesError}</p>
      )}
      {!loadingModules && !modules.length && !modulesError && (
        <p className="view-empty-modules-hint">还没有内置模块。把 .caskpack.json 放到应用的 modules/ 目录即可出现在这里。</p>
      )}
      <div className={gridClass}>
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
                  onClick={() => void openInstallReview(mod)}
                >
                  <span>{busy ? "安装中" : mod.installed ? "再次安装" : "安装场景"}</span>
                  {!busy && <Icon.ArrowRight size={15} strokeWidth={2.2} />}
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {review && (
        <div className="view-record-mask" onClick={() => !installingId && setReview(null)}>
          <div className="view-record-dialog module-review-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="module-review-head">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] tracking-[0.16em] text-muted-foreground">安装预览</p>
                <h2 className="mt-1 text-lg font-semibold tracking-tight">{review.mod.title}</h2>
                {!!review.mod.description && (
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{review.mod.description}</p>
                )}
              </div>
              <button
                type="button"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-muted-foreground hover:bg-secondary hover:text-foreground"
                aria-label="关闭"
                disabled={!!installingId}
                onClick={() => setReview(null)}
              >
                <Icon.X size={16} />
              </button>
            </div>

            {review.loading && (
              <p className="mt-5 flex items-center gap-2 text-sm text-muted-foreground">
                <Icon.Loader2 size={15} className="animate-spin" />
                正在生成安装清单…
              </p>
            )}
            {!!review.error && !review.loading && (
              <p className="mt-5 text-sm text-destructive">{review.error}</p>
            )}

            {review.preview && !review.loading && (() => {
              const p = review.preview!
              const sum = p.summary
              return (
                <div className="module-review-body mt-5">
                  <div className="module-review-summary">
                    <span>{sum.schemaCreate ? "新建 " + sum.schemaCreate + " 表" : "无新表"}</span>
                    {sum.schemaReuse > 0 && <span>复用 {sum.schemaReuse} 表</span>}
                    <span>{sum.viewCreate ? "新建 " + sum.viewCreate + " 视图" : "无新视图"}</span>
                    {sum.viewSkip > 0 && <span>跳过 {sum.viewSkip} 视图</span>}
                    <span>{sum.sampleRows ? sum.sampleRows + " 条示例" : "不含示例"}</span>
                  </div>

                  {review.mod.hasSamples && (
                    <label className="module-review-samples-toggle">
                      <Checkbox
                        checked={!!includeSamples[review.mod.id]}
                        disabled={!!installingId}
                        onCheckedChange={(checked) => void refreshInstallReview(!!checked)}
                      />
                      <span className="min-w-0">
                        <strong className="block text-sm font-medium">包含示例数据</strong>
                        <span className="text-xs text-muted-foreground">
                          包内共 {p.sampleTotal} 条 · {includeSamples[review.mod.id] ? "将写入本地" : "本次不写入"}
                        </span>
                      </span>
                    </label>
                  )}

                  <div className="module-review-section">
                    <p className="module-review-section-title">数据表</p>
                    <ul className="module-review-list">
                      {p.schemas.map((item) => (
                        <li key={item.name}>
                          <span className="module-review-name">{item.name}</span>
                          <span className="module-review-meta">{item.fieldCount} 字段 · {item.fields.slice(0, 4).join(" · ")}{item.fields.length > 4 ? " …" : ""}</span>
                          <span className={"module-review-badge" + (item.action === "reuse" ? " is-soft" : "")}>
                            {item.action === "reuse" ? "已有 · 复用" : "新建"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="module-review-section">
                    <p className="module-review-section-title">视图</p>
                    <ul className="module-review-list">
                      {p.views.map((item) => (
                        <li key={item.name + item.schemaName}>
                          <span className="module-review-name">{item.name}</span>
                          <span className="module-review-meta">
                            来自 {item.schemaName}
                            {item.baseFilterCount ? " · 预置条件 " + item.baseFilterCount : ""}
                            {item.allowWrite ? " · 可写" : ""}
                            {item.revealSecretsDefault ? " · 默认显密" : ""}
                          </span>
                          <span className={"module-review-badge" + (item.action === "skip" ? " is-soft" : "")}>
                            {item.action === "skip" ? "已有 · 跳过" : "新建"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {p.includeSamples && p.samples.length > 0 && (
                    <div className="module-review-section">
                      <p className="module-review-section-title">示例数据</p>
                      <ul className="module-review-list">
                        {p.samples.map((item) => (
                          <li key={item.schemaName}>
                            <span className="module-review-name">{item.schemaName}</span>
                            <span className="module-review-meta">{item.count} 条</span>
                            <span className="module-review-badge">写入</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <p className="module-review-note">
                    冲突策略：同名表复用并合并缺失字段；同名视图跳过。安装不会覆盖你已有的行数据。
                  </p>
                </div>
              )
            })()}

            <div className="module-review-actions">
              <button
                type="button"
                className="h-10 rounded-xl border border-border px-4 text-sm"
                disabled={!!installingId}
                onClick={() => setReview(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-foreground px-5 text-sm font-medium text-background disabled:opacity-50"
                disabled={!!installingId || review.loading || !!review.error || !review.preview}
                onClick={() => void confirmInstallModule()}
              >
                {installingId ? <Icon.Loader2 size={15} className="animate-spin" /> : null}
                {installingId ? "安装中…" : "确认安装"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
