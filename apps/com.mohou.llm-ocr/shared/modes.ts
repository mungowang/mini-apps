export const BUILTIN_IDS = ["plain", "layout", "zh", "en"] as const

export type BuiltinId = (typeof BUILTIN_IDS)[number]

export type BuiltinMode = {
  id: BuiltinId
  name: string
  title: string
  blurb: string
  prompt: string
}

export const BUILTINS: readonly BuiltinMode[] = [
  {
    id: "plain",
    name: "通用",
    title: "通用 OCR",
    blurb: "按阅读顺序转写，保留换行，不加解释。",
    prompt: [
      "You are an OCR engine.",
      "Transcribe every piece of visible text exactly as it appears.",
      "Preserve line breaks and reading order.",
      "Do not translate, summarize, correct spelling, or explain.",
      "Do not add a preamble, a title, or markdown fences.",
      "If there is no text, return an empty string.",
    ].join(" "),
  },
  {
    id: "layout",
    name: "版式",
    title: "保留位置格式",
    blurb: "用空格近似原来的列和对齐，适合表格和多列。",
    prompt: [
      "You are an OCR engine.",
      "Transcribe the visible text and approximate the original layout with spaces and line breaks, as if the result will be read in a monospace font.",
      "Keep columns, indentation, and alignment as close as possible.",
      "Do not explain. Do not wrap the result in a code fence.",
      "If there is no text, return an empty string.",
    ].join(" "),
  },
  {
    id: "zh",
    name: "中文",
    title: "仅识别中文",
    blurb: "留下中文内容。英文界面和无关噪音丢掉。",
    prompt: [
      "You are an OCR engine for a Chinese screenshot.",
      "Transcribe the Chinese content exactly, preserving line breaks.",
      "Keep numbers, dates, and punctuation that belong to that Chinese content.",
      "Omit English sentences and English interface chrome that are not part of the content.",
      "Do not translate. Do not explain.",
      "If there is no Chinese text, return an empty string.",
    ].join(" "),
  },
  {
    id: "en",
    name: "英文",
    title: "仅识别英文",
    blurb: "留下英文内容。中文句子丢掉。",
    prompt: [
      "You are an OCR engine for an English screenshot.",
      "Transcribe the English content exactly, preserving line breaks.",
      "Keep numbers, dates, and punctuation that belong to that English content.",
      "Omit Chinese sentences and Chinese interface chrome that are not part of the content.",
      "Do not translate. Do not explain.",
      "If there is no English text, return an empty string.",
    ].join(" "),
  },
]

export type CustomTemplate = {
  id: string
  name: string
  prompt: string
  createdAt: number
}

export type Prefs = {
  modeId: string
  autoRecognize: boolean
  autoCopy: boolean
  pauseOnLarge: boolean
}

/** Panel flex weights from the splitter. Relative, not pixels. */
export type SplitLayout = {
  stage: number
  read: number
}

export function isSplitLayout(value: unknown): value is SplitLayout {
  if (!value || typeof value !== "object") return false
  const row = value as Partial<SplitLayout>
  return Number.isFinite(row.stage) && Number.isFinite(row.read) && (row.stage as number) > 0 && (row.read as number) > 0
}

export const DEFAULT_PREFS: Prefs = {
  modeId: "plain",
  autoRecognize: true,
  autoCopy: true,
  pauseOnLarge: true,
}

export type RecentItem = {
  id: string
  at: number
  modeName: string
  text: string
  chars: number
}

export type ModeView = {
  id: string
  name: string
  title: string
  blurb: string
  prompt: string
  custom: boolean
}

export type TemplateLayout = {
  order: string[]
  hidden: string[]
}

export const EMPTY_LAYOUT: TemplateLayout = { order: [], hidden: [] }

export type TemplateRow = {
  id: string
  name: string
  title: string
  blurb: string
  prompt: string
  builtin: boolean
}

export function isBuiltinId(id: string): id is BuiltinId {
  return (BUILTIN_IDS as readonly string[]).includes(id)
}

export function isTemplateLayout(value: unknown): value is TemplateLayout {
  if (!value || typeof value !== "object") return false
  const row = value as Partial<TemplateLayout>
  return Array.isArray(row.order) && row.order.every((id) => typeof id === "string")
    && Array.isArray(row.hidden) && row.hidden.every((id) => typeof id === "string")
}

export function listTemplates(custom: readonly CustomTemplate[], layout: TemplateLayout = EMPTY_LAYOUT): TemplateRow[] {
  const hidden = new Set(layout.hidden.filter(isBuiltinId))
  const pool = new Map<string, TemplateRow>()
  for (const mode of BUILTINS) {
    if (hidden.has(mode.id)) continue
    pool.set(mode.id, { ...mode, builtin: true })
  }
  for (const item of custom) {
    pool.set(item.id, {
      id: item.id,
      name: item.name,
      title: item.name,
      blurb: "按你写的提示词识别。",
      prompt: item.prompt,
      builtin: false,
    })
  }
  const rows: TemplateRow[] = []
  const seen = new Set<string>()
  for (const id of layout.order) {
    const row = pool.get(id)
    if (!row || seen.has(id)) continue
    seen.add(id)
    rows.push(row)
  }
  for (const row of pool.values()) {
    if (seen.has(row.id)) continue
    rows.push(row)
  }
  return rows
}

export function resolveMode(modeId: string, templates: readonly CustomTemplate[], layout: TemplateLayout = EMPTY_LAYOUT): ModeView {
  const rows = listTemplates(templates, layout)
  const found = rows.find((row) => row.id === modeId) ?? rows[0]
  if (!found) return { ...BUILTINS[0], custom: false }
  return { ...found, custom: !found.builtin }
}

export function isLargeCapture(width: number, height: number): boolean {
  const longSide = Math.max(width, height)
  const scrolling = height > width * 1.7 && height >= 2800
  return longSide >= 3400 || scrolling
}
