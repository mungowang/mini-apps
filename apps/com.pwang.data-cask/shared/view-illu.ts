/** Curated undraw-style illustrations for views (info-box tone, not analytics). */
export const VIEW_ILLUSTRATIONS = [
  { id: "account", file: "account.svg", label: "账号" },
  { id: "security", file: "security.svg", label: "安全" },
  { id: "files", file: "files.svg", label: "档案" },
  { id: "search", file: "search.svg", label: "检索" },
  { id: "filing", file: "filing.svg", label: "归档" },
  { id: "checklist", file: "checklist.svg", label: "清单" },
  { id: "collection", file: "collection.svg", label: "集合" },
  { id: "filter", file: "filter.svg", label: "筛选" },
  { id: "sync", file: "sync.svg", label: "同步" },
  { id: "notes", file: "notes.svg", label: "笔记" },
  { id: "dossier", file: "dossier.svg", label: "资料" },
  { id: "data", file: "data.svg", label: "信息" },
] as const

export type ViewIllustrationId = (typeof VIEW_ILLUSTRATIONS)[number]["id"]

export function isViewIllustrationId(value: string): value is ViewIllustrationId {
  return VIEW_ILLUSTRATIONS.some((item) => item.id === value)
}

export function pickViewIllustration(seed: string): ViewIllustrationId {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  return VIEW_ILLUSTRATIONS[hash % VIEW_ILLUSTRATIONS.length].id
}

export function resolveViewIllustration(id: string | undefined | null, seed = ""): ViewIllustrationId {
  if (id && isViewIllustrationId(id)) return id
  return pickViewIllustration(seed || "view")
}

export function viewIllustrationAsset(id: string | undefined | null, seed = "") {
  const resolved = resolveViewIllustration(id, seed)
  const item = VIEW_ILLUSTRATIONS.find((row) => row.id === resolved) ?? VIEW_ILLUSTRATIONS[0]
  return { id: item.id, label: item.label, path: "./assets/illu/" + item.file }
}
