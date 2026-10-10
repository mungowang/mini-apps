import { defineApp, eventType, type AppContext } from "@mohou/contract"

import {
  BUILTIN_IDS,
  DEFAULT_PREFS,
  EMPTY_LAYOUT,
  isBuiltinId,
  isSplitLayout,
  isTemplateLayout,
  listTemplates,
  type CustomTemplate,
  type Prefs,
  type RecentItem,
  type SplitLayout,
  type TemplateLayout,
} from "./shared/modes.ts"

const TEMPLATE_CAP = 24
const RECENT_CAP = 8
const RECENT_TEXT_CAP = 20_000
const PROMPT_CAP = 4_000

let active: AbortController | null = null

function codeOf(cause: unknown): string {
  if (!cause || typeof cause !== "object" || !("code" in cause)) return ""
  const code = cause.code
  return typeof code === "string" ? code : ""
}

function explain(cause: unknown): string {
  const code = codeOf(cause)
  if (code === "image-unsupported") return "当前模型不接受图片。请在宿主设置里换成支持视觉的模型。"
  if (code === "model-policy") return "图片超出宿主限制。框选更小的区域后再试。"
  if (code === "empty-completion") return "模型没有返回文字。"
  if (code === "retry-exhausted") return "模型没有稳定返回，再试一次。"
  if (cause instanceof Error && cause.message.trim()) return cause.message
  return "识别失败"
}

function fail(cause: unknown): Error {
  const error = new Error(explain(cause))
  const code = codeOf(cause)
  if (code) Object.assign(error, { code })
  return error
}

function attach(ctx: AppContext, controller: AbortController) {
  active?.abort()
  active = controller
  ctx.signal?.addEventListener("abort", () => controller.abort(), { once: true })
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function boolOf(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

async function readTemplates(ctx: AppContext): Promise<CustomTemplate[]> {
  const stored = await ctx.storage.kv().get("templates")
  if (!Array.isArray(stored)) return []
  return stored.filter(isTemplate)
}

async function readLayout(ctx: AppContext): Promise<TemplateLayout> {
  const stored = await ctx.storage.kv().get("templateLayout")
  if (!isTemplateLayout(stored)) return { ...EMPTY_LAYOUT }
  return {
    order: stored.order,
    hidden: stored.hidden.filter(isBuiltinId),
  }
}

async function writeLayout(ctx: AppContext, layout: TemplateLayout): Promise<void> {
  await ctx.storage.kv().set("templateLayout", layout)
}

async function settleMode(ctx: AppContext, templates: CustomTemplate[], layout: TemplateLayout): Promise<Prefs> {
  const prefs = await readPrefs(ctx)
  const rows = listTemplates(templates, layout)
  if (rows.some((row) => row.id === prefs.modeId)) return prefs
  const next = { ...prefs, modeId: rows[0]?.id ?? DEFAULT_PREFS.modeId }
  await ctx.storage.kv().set("prefs", next)
  return next
}

function isTemplate(value: unknown): value is CustomTemplate {
  if (!value || typeof value !== "object") return false
  const row = value as Partial<CustomTemplate>
  return typeof row.id === "string" && typeof row.name === "string" && typeof row.prompt === "string"
}

async function readPrefs(ctx: AppContext): Promise<Prefs> {
  const stored = await ctx.storage.kv().get("prefs")
  if (!stored || typeof stored !== "object") return { ...DEFAULT_PREFS }
  const row = stored as Partial<Prefs>
  return {
    modeId: typeof row.modeId === "string" && row.modeId.trim() ? row.modeId : DEFAULT_PREFS.modeId,
    autoRecognize: boolOf(row.autoRecognize, DEFAULT_PREFS.autoRecognize),
    autoCopy: boolOf(row.autoCopy, DEFAULT_PREFS.autoCopy),
    pauseOnLarge: boolOf(row.pauseOnLarge, DEFAULT_PREFS.pauseOnLarge),
  }
}

async function readSplit(ctx: AppContext): Promise<SplitLayout | null> {
  const stored = await ctx.storage.kv().get("split")
  return isSplitLayout(stored) ? stored : null
}

async function readRecent(ctx: AppContext): Promise<RecentItem[]> {
  const stored = await ctx.storage.kv().get("recent")
  if (!Array.isArray(stored)) return []
  return stored.filter(isRecent).slice(0, RECENT_CAP)
}

function isRecent(value: unknown): value is RecentItem {
  if (!value || typeof value !== "object") return false
  const row = value as Partial<RecentItem>
  return typeof row.id === "string" && typeof row.text === "string" && typeof row.at === "number"
}

function unwrapFence(text: string): string {
  const match = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text.trim())
  return match?.[1] ?? text
}

function field(event: unknown, key: string): unknown {
  if (!event || typeof event !== "object") return undefined
  return (event as Record<string, unknown>)[key]
}

function placeRestored(order: string[], hidden: readonly string[]): string[] {
  const result = order.filter((id) => !hidden.includes(id))
  for (const id of hidden) {
    if (!isBuiltinId(id) || result.includes(id)) continue
    const rank = BUILTIN_IDS.indexOf(id)
    let insertAt = result.findIndex((other) => isBuiltinId(other) && BUILTIN_IDS.indexOf(other) > rank)
    if (insertAt < 0) {
      let after = -1
      result.forEach((other, index) => {
        if (isBuiltinId(other) && BUILTIN_IDS.indexOf(other) < rank) after = index
      })
      insertAt = after + 1
    }
    result.splice(insertAt, 0, id)
  }
  return result
}

export default defineApp({
  name: "识图",
  description: "粘贴截图，框选区域，按模板识别成可复制的文字",
  api: {
    async snapshot(ctx) {
      const [prefs, templates, recent, split, layout] = await Promise.all([
        readPrefs(ctx),
        readTemplates(ctx),
        readRecent(ctx),
        readSplit(ctx),
        readLayout(ctx),
      ])
      return { prefs, templates, recent, split, layout }
    },

    async saveSplit(ctx, args?: Partial<SplitLayout>) {
      const stage = Number(args?.stage)
      const read = Number(args?.read)
      if (!Number.isFinite(stage) || !Number.isFinite(read) || stage <= 0 || read <= 0) {
        throw new Error("分割比例无效")
      }
      const split: SplitLayout = { stage, read }
      await ctx.storage.kv().set("split", split)
      return split
    },

    async savePrefs(ctx, args?: Partial<Prefs>) {
      const current = await readPrefs(ctx)
      const next: Prefs = {
        modeId: textOf(args?.modeId).trim() || current.modeId,
        autoRecognize: boolOf(args?.autoRecognize, current.autoRecognize),
        autoCopy: boolOf(args?.autoCopy, current.autoCopy),
        pauseOnLarge: boolOf(args?.pauseOnLarge, current.pauseOnLarge),
      }
      await ctx.storage.kv().set("prefs", next)
      return next
    },

    async saveTemplate(ctx, args?: { id?: string; name?: string; prompt?: string }) {
      const name = textOf(args?.name).trim()
      const prompt = textOf(args?.prompt).trim()
      if (!name) throw new Error("请填写模板名称")
      if (!prompt) throw new Error("请填写识别提示词")
      if (name.length > 24) throw new Error("名称最多 24 个字")
      if (prompt.length > PROMPT_CAP) throw new Error("提示词太长了")
      const id = textOf(args?.id).trim()
      if (id && isBuiltinId(id)) throw new Error("内置模板不能改，可以复制成自己的")
      const list = await readTemplates(ctx)
      let template: CustomTemplate
      if (id) {
        const index = list.findIndex((item) => item.id === id)
        if (index < 0) throw new Error("找不到这个模板")
        template = { ...list[index], name, prompt }
        list[index] = template
      } else {
        if (list.length >= TEMPLATE_CAP) throw new Error("最多 24 个自定义模板")
        template = { id: "t_" + Date.now().toString(36), name, prompt, createdAt: Date.now() }
        list.unshift(template)
      }
      const layout = await readLayout(ctx)
      if (!id) layout.order = [template.id, ...layout.order.filter((item) => item !== template.id)]
      await ctx.storage.kv().set("templates", list)
      await writeLayout(ctx, layout)
      return { template, templates: list, layout }
    },

    async reorderTemplates(ctx, args?: { ids?: unknown }) {
      const raw = Array.isArray(args?.ids) ? args.ids : []
      const templates = await readTemplates(ctx)
      const layout = await readLayout(ctx)
      const visible = new Set(listTemplates(templates, { ...layout, order: [] }).map((row) => row.id))
      const order = raw.filter((id): id is string => typeof id === "string" && visible.has(id))
      for (const id of visible) {
        if (!order.includes(id)) order.push(id)
      }
      const next = { ...layout, order }
      await writeLayout(ctx, next)
      return { layout: next }
    },

    async restoreBuiltins(ctx) {
      const templates = await readTemplates(ctx)
      const layout = await readLayout(ctx)
      const order = placeRestored(layout.order, layout.hidden)
      const next = { order, hidden: [] }
      await writeLayout(ctx, next)
      return { layout: next, templates }
    },

    async deleteTemplate(ctx, args?: { id?: string }) {
      const id = textOf(args?.id).trim()
      if (!id) throw new Error("找不到这个模板")
      let list = await readTemplates(ctx)
      const layout = await readLayout(ctx)
      if (isBuiltinId(id)) {
        if (!layout.hidden.includes(id)) layout.hidden = [...layout.hidden, id]
      } else if (!list.some((item) => item.id === id)) {
        throw new Error("找不到这个模板")
      } else {
        list = list.filter((item) => item.id !== id)
        await ctx.storage.kv().set("templates", list)
      }
      layout.order = layout.order.filter((item) => item !== id)
      await writeLayout(ctx, layout)
      const prefs = await settleMode(ctx, list, layout)
      return { templates: list, layout, prefs }
    },

    async cancel() {
      active?.abort()
      active = null
      return { ok: true }
    },

    async *recognize(
      ctx,
      args?: { prompt?: string; mimeType?: string; data?: string; modeName?: string },
    ) {
      const prompt = textOf(args?.prompt).trim()
      const mimeType = textOf(args?.mimeType).trim()
      const data = textOf(args?.data).replace(/\s/g, "")
      const modeName = textOf(args?.modeName).trim() || "识别"
      if (!prompt) throw new Error("请先选择一种识别方式")
      if (!mimeType || !data) throw new Error("请粘贴或选择一张图片")
      const controller = new AbortController()
      attach(ctx, controller)
      const startedAt = Date.now()
      let body = ""
      try {
        for await (const event of ctx.llm("Transcribe the image. Output only the transcription.", {
          system: prompt,
          images: [{ mimeType, data }],
          stream: true,
          maxTokens: 8192,
          signal: controller.signal,
        })) {
          if (field(event, "type") !== eventType.textDelta) continue
          const text = textOf(field(event, "text"))
          if (!text) continue
          body += text
          yield text
        }
      } catch (cause) {
        if (codeOf(cause) === "cancelled" || controller.signal.aborted) {
          throw Object.assign(new Error("已停止"), { code: "cancelled" })
        }
        throw fail(cause)
      }
      const text = unwrapFence(body)
      const chars = Array.from(text).length
      const recent = await readRecent(ctx)
      if (text.trim()) {
        const item: RecentItem = {
          id: "r_" + Date.now().toString(36),
          at: Date.now(),
          modeName,
          text: text.slice(0, RECENT_TEXT_CAP),
          chars,
        }
        recent.unshift(item)
        await ctx.storage.kv().set("recent", recent.slice(0, RECENT_CAP))
      }
      return {
        text,
        chars,
        durationMs: Date.now() - startedAt,
        recent: recent.slice(0, RECENT_CAP),
      }
    },
  },
})
