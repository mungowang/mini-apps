import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'

import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Icon,
  Spinner,
  Toaster,
  toast,
  useApp,
  useWebsite,
} from '@mohou/ui'

import { EV, type InstallLog, type RecentSessionItem, type RecentSessionStatus } from './shared/events.ts'

/** Match pi-web SessionSidebar resize limits (storageKey pi-sidebar-width). */
const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 480
const SIDEBAR_DEFAULT = 260
/** Pulse while Recent is open; slower when only badge needs running counts. */
const PULSE_OPEN_MS = 2_000
const PULSE_CLOSED_MS = 8_000
const PULSE_HIDDEN_MS = 30_000

interface PiWebStatus {
  readonly installed: boolean
  readonly version?: string
  readonly latest?: string
  readonly updateAvailable?: boolean
}

interface UpdateRow {
  readonly pkg: string
  readonly current?: string
  readonly latest?: string
  readonly updateAvailable?: boolean
}

interface UpdateCheckResult {
  readonly pi?: { current: string; latest?: string; updateAvailable?: boolean }
  readonly packages: readonly UpdateRow[]
}

interface RecommendedItem {
  readonly pkg: string
  readonly name: string
  readonly description: string
  readonly installed: boolean
}

interface RecentSnapshot {
  readonly items: RecentSessionItem[]
  readonly runningCount: number
  readonly awaitingCount: number
  readonly open: boolean
  readonly origin: string
  readonly sessionListVersion?: number | null
  readonly catalogFetched?: boolean
  readonly sidebarWidth?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asStatus(value: unknown): PiWebStatus | undefined {
  if (!isRecord(value)) return undefined
  return {
    installed: value.installed === true,
    ...typeof value.version === 'string' ? { version: value.version } : {},
    ...typeof value.latest === 'string' ? { latest: value.latest } : {},
    updateAvailable: value.updateAvailable === true,
  }
}

function asUpdateCheck(value: unknown): UpdateCheckResult | undefined {
  if (!isRecord(value)) return undefined
  const pi = isRecord(value.pi)
    ? {
        current: typeof value.pi.current === 'string' ? value.pi.current : '',
        ...typeof value.pi.latest === 'string' ? { latest: value.pi.latest } : {},
      }
    : undefined
  const packages = Array.isArray(value.packages)
    ? value.packages.filter(isRecord).map(row => ({
        pkg: typeof row.pkg === 'string' ? row.pkg : '',
        ...typeof row.current === 'string' ? { current: row.current } : {},
        ...typeof row.latest === 'string' ? { latest: row.latest } : {},
      }))
    : []
  return { ...pi === undefined ? {} : { pi }, packages }
}

function asRecommended(value: unknown): { firstRun: boolean; items: RecommendedItem[] } | undefined {
  if (!isRecord(value)) return undefined
  const items = Array.isArray(value.items)
    ? value.items.filter(isRecord).map(row => ({
        pkg: typeof row.pkg === 'string' ? row.pkg : '',
        name: typeof row.name === 'string' ? row.name : '',
        description: typeof row.description === 'string' ? row.description : '',
        installed: row.installed === true,
      }))
    : []
  return { firstRun: value.firstRun === true, items }
}

function asRecent(value: unknown): RecentSnapshot | undefined {
  if (!isRecord(value) || !Array.isArray(value.items)) return undefined
  const items: RecentSessionItem[] = []
  for (const row of value.items) {
    if (!isRecord(row) || typeof row.id !== 'string') continue
    const status: RecentSessionStatus = row.status === 'running' || row.status === 'awaiting' ? row.status : 'idle'
    items.push({
      id: row.id,
      title: typeof row.title === 'string' ? row.title : row.id.slice(0, 8),
      cwd: typeof row.cwd === 'string' ? row.cwd : '',
      repo: typeof row.repo === 'string' ? row.repo : 'session',
      ...typeof row.projectRoot === 'string' ? { projectRoot: row.projectRoot } : {},
      status,
      updated: typeof row.updated === 'string' ? row.updated : new Date().toISOString(),
      updatedMs: typeof row.updatedMs === 'number' ? row.updatedMs : Date.now(),
    })
  }
  return {
    items,
    runningCount: typeof value.runningCount === 'number' ? value.runningCount : 0,
    awaitingCount: typeof value.awaitingCount === 'number' ? value.awaitingCount : 0,
    open: value.open === true,
    origin: typeof value.origin === 'string' ? value.origin : '',
    sessionListVersion: typeof value.sessionListVersion === 'number' ? value.sessionListVersion : null,
    catalogFetched: value.catalogFetched === true,
    sidebarWidth: typeof value.sidebarWidth === 'number' ? value.sidebarWidth : undefined,
  }
}

function clampSidebarWidth(n: number): number {
  if (!Number.isFinite(n)) return SIDEBAR_DEFAULT
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(n)))
}

function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught)
}

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 10) return '刚刚'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  const d = Math.floor(h / 24)
  return d < 14 ? `${d}d` : `${Math.floor(d / 7)}w`
}

const REPO_COLORS = ['#2f6fed', '#7c3aed', '#0f9f6e', '#c47a12', '#db2777', '#0891b2', '#4f46e5'] as const

function repoColor(key: string): string {
  let hash = 0
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  return REPO_COLORS[hash % REPO_COLORS.length] ?? REPO_COLORS[0]
}

function shortPath(cwd: string): string {
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length <= 2) return parts.join('/') || cwd
  return parts.slice(-2).join('/')
}

type RepoChunk = { readonly key: string; readonly repo: string; readonly path: string; readonly items: readonly RecentSessionItem[] }

function chunkByRepo(items: readonly RecentSessionItem[]): RepoChunk[] {
  const chunks: Array<{ key: string; repo: string; path: string; items: RecentSessionItem[] }> = []
  for (const item of items) {
    const key = item.projectRoot ?? item.cwd ?? item.repo
    const last = chunks[chunks.length - 1]
    if (last !== undefined && last.key === key) {
      last.items.push(item)
    } else {
      chunks.push({
        key,
        repo: item.repo,
        path: shortPath(item.projectRoot ?? item.cwd),
        items: [item],
      })
    }
  }
  return chunks
}

export default function Ui() {
  const { call, on } = useApp()
  const site = useWebsite()

  const [status, setStatus] = useState<PiWebStatus | undefined>(undefined)
  const [busy, setBusy] = useState<string | null>(null)
  const [log, setLog] = useState('')

  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | undefined>(undefined)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [updating, setUpdating] = useState(false)

  const [recommended, setRecommended] = useState<{ firstRun: boolean; items: RecommendedItem[] } | undefined>(undefined)
  const [recommendedOpen, setRecommendedOpen] = useState(false)
  const [pluginBusy, setPluginBusy] = useState<string | null>(null)
  const [installingStep, setInstallingStep] = useState<string | null>(null)
  const [registryChoice, setRegistryChoice] = useState<'auto' | 'direct' | 'npmmirror'>('auto')
  const [registryHint, setRegistryHint] = useState<string | null>(null)

  const [recentOpen, setRecentOpen] = useState(false)
  const [recentItems, setRecentItems] = useState<RecentSessionItem[]>([])
  const [recentRunning, setRecentRunning] = useState(0)
  const [recentAwaiting, setRecentAwaiting] = useState(0)
  const [recentQuery, setRecentQuery] = useState('')
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [recentBusy, setRecentBusy] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT)
  const [resizingSide, setResizingSide] = useState(false)
  const [pageHidden, setPageHidden] = useState(false)

  const probe = useCallback(async () => {
    try {
      setStatus(asStatus(await call('status', {})))
    } catch {
      setStatus(undefined)
    }
  }, [call])

  useEffect(() => {
    void probe()
  }, [probe, site.phase])

  useEffect(() => {
    const stop = on<InstallLog>(EV.installLog, data => {
      if (isRecord(data) && typeof data.text === 'string') setLog(data.text)
    })
    return stop
  }, [on])

  // Once the server is up: check pi/plugin updates and pop the recommended list on first run.
  useEffect(() => {
    if (site.phase !== 'ready') return
    let cancelled = false
    void (async () => {
      let updatesShown = false
      try {
        const updates = asUpdateCheck(await call('updateCheck', {}))
        if (cancelled) return
        setUpdateInfo(updates)
        updatesShown = updates !== undefined && ((updates.pi?.updateAvailable === true) || updates.packages.length > 0)
        if (updatesShown) setUpdateOpen(true)
      } catch {
        // update check is advisory; ignore failures
      }
      try {
        const rec = asRecommended(await call('recommended', {}))
        if (cancelled) return
        setRecommended(recommended => {
          return rec === undefined ? recommended : { ...rec, firstRun: recommended?.firstRun === true || rec.firstRun }
        })
        if (rec?.firstRun === true && !updatesShown) {
          setRecommendedOpen(true)
          void call('recommended', { mark: true }).catch(() => undefined)
        }
      } catch {
        // recommended list is advisory
      }
      try {
        const mode = await call('recentMode', {}) as { open?: boolean } | undefined
        if (!cancelled && mode?.open === true) setRecentOpen(true)
      } catch {
        // ignore
      }
    })()
    return () => {
      cancelled = true
    }
  }, [call, site.phase])

  const applyRecent = useCallback((snap: RecentSnapshot | undefined) => {
    if (snap === undefined) return
    // Client safety net: unique by id (server also dedupes cwd+title).
    const seen = new Set<string>()
    const items: RecentSessionItem[] = []
    for (const item of snap.items) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      items.push(item)
    }
    setRecentItems(items)
    setRecentRunning(items.filter(i => i.status === 'running').length)
    setRecentAwaiting(items.filter(i => i.status === 'awaiting').length)
    if (typeof snap.sidebarWidth === 'number') setSidebarWidth(clampSidebarWidth(snap.sidebarWidth))
  }, [])

  /** Lightweight: running heartbeat + catalog only if version requires it. */
  const pulseRecent = useCallback(async () => {
    try {
      const snap = asRecent(await call('recentPulse', {}))
      applyRecent(snap)
      return snap
    } catch {
      return undefined
    }
  }, [call, applyRecent])

  /** Force full /api/sessions rebuild + prune orphans/title-dupes (open panel / manual refresh). */
  const refreshRecent = useCallback(async () => {
    try {
      const before = recentItems.length
      const snap = asRecent(await call('recentSync', {}))
      applyRecent(snap)
      const after = snap?.items.length ?? 0
      const dropped = Math.max(0, before - after)
      toast.add({
        title: 'Recent 已刷新',
        description: dropped > 0
          ? `去重/清理 ${dropped} 条 · 现 ${after} 条`
          : `共 ${after} 条 · 按最后更新排序`,
      })
      return snap
    } catch (caught) {
      toast.add({ title: '刷新失败', description: messageOf(caught), type: 'error' })
      return undefined
    }
  }, [call, applyRecent, recentItems.length])

  useEffect(() => {
    const onVis = () => { setPageHidden(document.hidden) }
    onVis()
    document.addEventListener('visibilitychange', onVis)
    return () => { document.removeEventListener('visibilitychange', onVis) }
  }, [])

  // Stable pulse loop — avoid stacking intervals when callback identities churn.
  const pulseRef = useRef(pulseRecent)
  pulseRef.current = pulseRecent
  const recentOpenRef = useRef(recentOpen)
  recentOpenRef.current = recentOpen
  const pageHiddenRef = useRef(pageHidden)
  pageHiddenRef.current = pageHidden

  useEffect(() => {
    if (site.phase !== 'ready') return
    let cancelled = false
    let timer: number | undefined
    let inFlight = false
    const schedule = () => {
      if (cancelled) return
      const delay = pageHiddenRef.current
        ? PULSE_HIDDEN_MS
        : recentOpenRef.current
          ? PULSE_OPEN_MS
          : PULSE_CLOSED_MS
      timer = window.setTimeout(() => { void tick() }, delay)
    }
    const tick = async () => {
      if (cancelled || inFlight) {
        schedule()
        return
      }
      inFlight = true
      try {
        await pulseRef.current()
      } finally {
        inFlight = false
        schedule()
      }
    }
    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [site.phase, site.generation])

  useEffect(() => {
    const timer = window.setInterval(() => { setNowMs(Date.now()) }, 5_000)
    return () => { window.clearInterval(timer) }
  }, [])

  // Load persisted sidebar width once.
  useEffect(() => {
    void (async () => {
      try {
        const res = await call('recentSidebarWidth', {}) as { width?: number } | undefined
        if (typeof res?.width === 'number') setSidebarWidth(clampSidebarWidth(res.width))
      } catch {
        // default
      }
    })()
  }, [call])

  const persistSidebarWidth = useCallback(async (width: number) => {
    const w = clampSidebarWidth(width)
    setSidebarWidth(w)
    try {
      await call('recentSidebarWidth', { width: w })
    } catch {
      // local still applies
    }
  }, [call])

  const onResizePointerDown = useCallback((event: { currentTarget: HTMLDivElement; clientX: number; pointerId: number; preventDefault: () => void }) => {
    event.preventDefault()
    const startX = event.clientX
    const startW = sidebarWidth
    setResizingSide(true)
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    const onMove = (e: PointerEvent) => {
      setSidebarWidth(clampSidebarWidth(startW + (e.clientX - startX)))
    }
    const onUp = (e: PointerEvent) => {
      target.releasePointerCapture(e.pointerId)
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onUp)
      setResizingSide(false)
      setSidebarWidth(w => {
        const next = clampSidebarWidth(w)
        void persistSidebarWidth(next)
        return next
      })
    }
    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
    target.addEventListener('pointercancel', onUp)
  }, [sidebarWidth, persistSidebarWidth])

  const setRecentMode = useCallback(async (open: boolean) => {
    setRecentOpen(open)
    try {
      await call('recentMode', { open })
    } catch {
      // local UI still toggles
    }
    // Opening Recent: force one full catalogue so titles are fresh.
    if (open) void refreshRecent().catch(() => undefined)
  }, [call, refreshRecent])

  const removeRecent = useCallback(async (id: string) => {
    setRecentBusy(true)
    try {
      applyRecent(asRecent(await call('recentRemove', { id })))
      if (selectedSessionId === id) setSelectedSessionId(null)
      toast.add({ title: '已移出 Recent', description: 'session 文件保留' })
    } catch (caught) {
      toast.add({ title: '移出失败', description: messageOf(caught), type: 'error' })
    } finally {
      setRecentBusy(false)
    }
  }, [call, applyRecent, selectedSessionId])

  const removeIdleRecent = useCallback(async () => {
    setRecentBusy(true)
    try {
      applyRecent(asRecent(await call('recentRemoveIdle', {})))
      toast.add({ title: '已移出空闲会话' })
    } catch (caught) {
      toast.add({ title: '操作失败', description: messageOf(caught), type: 'error' })
    } finally {
      setRecentBusy(false)
    }
  }, [call, applyRecent])

  const restartServer = useCallback(async () => {
    setBusy('restart')
    try {
      await site.refresh()
      toast.add({ title: 'pi-web 服务已重启', description: '新插件已加载' })
    } catch (caught) {
      toast.add({ title: '重启失败', description: messageOf(caught), type: 'error' })
    } finally {
      setBusy(null)
    }
  }, [site])

  const runInstall = useCallback(async (registry: 'auto' | 'direct' | 'npmmirror', mode: 'install' | 'update') => {
    setBusy(registry)
    setLog('')
    try {
      const result = await call('install', { registry }) as { registry?: string; fellBack?: boolean } | undefined
      const used = result?.registry === 'npmmirror' ? '国内镜像' : result?.registry === 'direct' ? '国际源' : undefined
      toast.add({
        title: mode === 'update' ? 'pi-web 已更新' : 'pi-web 已安装',
        description: used === undefined
          ? '正在启动服务'
          : `经${used}${result?.fellBack === true ? '（已自动切换）' : ''} · 正在启动服务`,
      })
      await probe()
      await site.retry()
    } catch (caught) {
      toast.add({ title: mode === 'update' ? '更新失败' : '安装失败', description: messageOf(caught), type: 'error' })
      await probe()
    } finally {
      setBusy(null)
    }
  }, [call, probe, site])

  const runUpdateAll = useCallback(async () => {
    setUpdating(true)
    setLog('')
    try {
      await call('updateAll', {})
      toast.add({ title: 'pi 与插件已更新', description: '正在重启服务以加载新版本' })
      await restartServer()
      const updates = asUpdateCheck(await call('updateCheck', {}))
      setUpdateInfo(updates)
      if (updates.pi?.updateAvailable !== true && updates.packages.length === 0) setUpdateOpen(false)
    } catch (caught) {
      toast.add({ title: '更新失败', description: messageOf(caught), type: 'error' })
    } finally {
      setUpdating(false)
    }
  }, [call, restartServer])

  const refreshRecommended = useCallback(async () => {
    const rec = asRecommended(await call('recommended', {}))
    if (rec !== undefined) setRecommended({ ...rec, firstRun: false })
    return rec
  }, [call])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const rec = asRecommended(await call('recommended', {}))
        if (cancelled || rec === undefined) return
        setRecommended(prev => ({
          ...rec,
          firstRun: prev?.firstRun === true || rec.firstRun,
        }))
      } catch {
        // advisory
      }
    })()
    return () => {
      cancelled = true
    }
  }, [call])

  const refreshRegistryHint = useCallback(async () => {
    if (registryChoice !== 'auto') {
      setRegistryHint(registryChoice === 'npmmirror' ? '强制国内镜像' : '强制国际源')
      return
    }
    try {
      const picked = await call('pickRegistry', {}) as {
        label?: string
        directMs?: number | null
        npmmirrorMs?: number | null
      } | undefined
      if (picked === undefined) {
        setRegistryHint(null)
        return
      }
      const direct = picked.directMs == null ? '国际不可达' : `国际 ${picked.directMs}ms`
      const mirror = picked.npmmirrorMs == null ? '国内不可达' : `国内 ${picked.npmmirrorMs}ms`
      setRegistryHint(`推荐 ${picked.label ?? '?'} · ${direct} · ${mirror}`)
    } catch {
      setRegistryHint(null)
    }
  }, [call, registryChoice])

  useEffect(() => {
    void refreshRegistryHint()
  }, [refreshRegistryHint])

  const installOne = useCallback(async (pkg: string) => {
    await call('installPlugin', { pkg, registry: registryChoice })
    await refreshRecommended()
  }, [call, registryChoice, refreshRecommended])

  const openRecommended = useCallback(() => {
    setRecommendedOpen(true)
    void refreshRecommended().catch(() => undefined)
  }, [refreshRecommended])

  const installPlugin = useCallback(async (pkg: string) => {
    setPluginBusy(pkg)
    try {
      await installOne(pkg)
      toast.add({ title: '插件已安装', description: pkg })
    } catch (caught) {
      toast.add({ title: '插件安装失败', description: messageOf(caught), type: 'error' })
    } finally {
      setPluginBusy(null)
    }
  }, [installOne])

  const installAll = useCallback(async () => {
    const missing = (recommended?.items ?? []).filter(item => !item.installed)
    if (missing.length === 0) return
    setPluginBusy('__all__')
    let done = 0
    let failed = 0
    for (const item of missing) {
      setInstallingStep(`${item.name}（${done + failed + 1}/${missing.length}）`)
      try {
        await installOne(item.pkg)
        done += 1
      } catch {
        failed += 1
      }
    }
    setInstallingStep(null)
    toast.add({
      title: failed === 0 ? '全部插件已安装' : '安装完成（部分失败）',
      description: `成功 ${done} 个${failed > 0 ? `，失败 ${failed} 个` : ''}。可重启 pi-web 服务生效`,
    })
  }, [recommended, installOne])

  const showFrame = (site.phase === 'ready' || site.phase === 'refreshing') && site.url !== undefined
  const needsPanel = status !== undefined && (!status.installed || status.updateAvailable === true)
  const mode: 'install' | 'update' = status?.updateAvailable === true ? 'update' : 'install'

  const frameSrc = useMemo(() => {
    if (site.url === undefined) return undefined
    if (selectedSessionId === null || selectedSessionId.length === 0) return site.url
    const join = site.url.includes('?') ? '&' : '?'
    return `${site.url}${join}session=${encodeURIComponent(selectedSessionId)}`
  }, [site.url, selectedSessionId])

  // Reset deep-link when the hosted server restarts.
  useEffect(() => {
    setSelectedSessionId(null)
  }, [site.generation])

  const filteredRecent = useMemo(() => {
    const q = recentQuery.trim().toLowerCase()
    if (q.length === 0) return recentItems
    return recentItems.filter(item =>
      item.title.toLowerCase().includes(q)
      || item.repo.toLowerCase().includes(q)
      || item.cwd.toLowerCase().includes(q),
    )
  }, [recentItems, recentQuery])

  const recentChunks = useMemo(() => chunkByRepo(filteredRecent), [filteredRecent])
  const recentCount = recentItems.length
  const recentAttention = recentRunning > 0 || recentAwaiting > 0

  const recommendedItems = recommended?.items ?? []
  const recommendedTotal = recommendedItems.length
  const recommendedInstalled = recommendedItems.filter(item => item.installed).length
  const recommendedMissing = recommendedTotal - recommendedInstalled

  const setupPanel: ReactNode = (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center p-6">
      <div className="flex w-full max-w-3xl flex-col gap-4 lg:flex-row">
        <div className="flex flex-1 flex-col gap-3">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground">
              <Icon.PackageOpen size={15} strokeWidth={2} />
            </div>
            <div className="flex flex-col">
              <p className="text-sm font-medium text-foreground">
                {mode === 'update' ? 'pi-web 有新版本' : '需要先安装 pi-web'}
              </p>
              <p className="text-xs text-muted-foreground">
                {mode === 'update'
                  ? `本机 ${status?.version ?? '?'} → 最新 ${status?.latest ?? '?'}`
                  : 'pi-web 是一个 npm 全局包，由本应用安装并托管'}
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Button disabled={busy !== null} onClick={() => { void runInstall('auto', mode) }}>
              {busy === 'auto' ? <Spinner className="size-3.5" /> : <Icon.Sparkles size={15} strokeWidth={2} />}
              {mode === 'update' ? '智能更新（自动选源）' : '智能安装（自动选源）'}
            </Button>
            <p className="text-[11px] text-muted-foreground">
              测速国际 npm 与 npmmirror，选更快的；失败自动切换。{registryHint !== null ? ` ${registryHint}` : ''}
            </p>
            <Button variant="outline" disabled={busy !== null} onClick={() => { void runInstall('direct', mode) }}>
              {busy === 'direct' ? <Spinner className="size-3.5" /> : <Icon.Zap size={15} strokeWidth={2} />}
              {mode === 'update' ? '国际源更新' : '国际源安装'}
            </Button>
            <p className="font-mono text-[10px] break-all text-muted-foreground">npm install -g @agegr/pi-web@latest</p>
            <Button variant="outline" disabled={busy !== null} onClick={() => { void runInstall('npmmirror', mode) }}>
              {busy === 'npmmirror' ? <Spinner className="size-3.5" /> : <Icon.Globe size={15} strokeWidth={2} />}
              {mode === 'update' ? '国内镜像更新' : '国内镜像安装'}
            </Button>
            <p className="font-mono text-[10px] break-all text-muted-foreground">
              npm install -g @agegr/pi-web@latest --registry=https://registry.npmmirror.com
            </p>
          </div>
          <p className="text-[11px] text-muted-foreground">包体较大（约 500 MB），最长 1 小时，进度见右侧控制台。</p>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-1.5">
          <span className="text-[11px] font-medium tracking-wide text-muted-foreground">控制台</span>
          <pre className="thin-scroll m-0 min-h-56 flex-1 overflow-auto rounded-lg border border-border bg-muted/30 p-2.5 font-mono text-[11px] leading-5 whitespace-pre-wrap break-all text-foreground">
            {log.length > 0 ? log : busy === null ? '等待开始…' : '正在启动…'}
          </pre>
        </div>
      </div>
    </div>
  )

  const panelSpring = resizingSide
    ? { duration: 0 }
    : { type: 'spring' as const, stiffness: 420, damping: 34, mass: 0.78 }

  const recentOverlay = showFrame ? (
    <AnimatePresence initial={false}>
      {recentOpen ? (
        <motion.aside
          key="recent-rail"
          className="absolute inset-y-0 left-0 z-20 flex flex-col border-r border-border bg-background"
          style={{ width: sidebarWidth }}
          aria-label="Recent Sessions"
          initial={{ x: '-100%' }}
          animate={{ x: 0 }}
          exit={{ x: '-100%' }}
          transition={panelSpring}
        >
          {/* Inner content: slight lag + fade for depth (not the only motion). */}
          <motion.div
            className="relative flex min-h-0 flex-1 flex-col"
            initial={{ opacity: 0.35, x: -18 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0.2, x: -12 }}
            transition={resizingSide
              ? { duration: 0 }
              : { type: 'spring', stiffness: 380, damping: 32, mass: 0.7, delay: 0.04 }}
          >
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-2.5 py-2">
        <div className="flex items-center gap-1">
          <h2 className="min-w-0 flex-1 text-[13px] font-semibold tracking-tight text-foreground">Recent</h2>
          <Button
            size="icon-xs"
            variant="outline"
            className="size-7"
            title="刷新"
            disabled={recentBusy}
            onClick={() => { void refreshRecent() }}
          >
            <Icon.RefreshCw size={13} strokeWidth={2} />
          </Button>
          <Button
            size="icon-xs"
            variant="outline"
            className="size-7"
            title="回到 All Sessions"
            onClick={() => { void setRecentMode(false) }}
          >
            <Icon.PanelLeft size={13} strokeWidth={2} />
          </Button>
        </div>
        <p className="text-[10px] leading-tight text-muted-foreground">曾 running 即进入 · 仅手动移出</p>
        <label className="flex h-7 items-center gap-1.5 rounded-md border border-input bg-muted/30 px-2">
          <Icon.Search size={12} strokeWidth={2} className="shrink-0 text-muted-foreground" />
          <input
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            placeholder="过滤标题 / repo…"
            value={recentQuery}
            onChange={(e) => { setRecentQuery(e.target.value) }}
          />
        </label>
      </div>

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
        {recentChunks.length === 0 ? (
          <div className="px-3 py-10 text-center text-xs leading-relaxed text-muted-foreground">
            <p className="mb-1 font-medium text-foreground/80">没有 Recent</p>
            running 过的会话会出现在这里。
            <br />
            移出后需再次 running 才回来。
          </div>
        ) : (
          recentChunks.map(chunk => (
            <div key={chunk.key} className="mb-2" style={{ ['--repo-color' as string]: repoColor(chunk.key) }}>
              <div className="sticky top-0 z-[1] flex items-center gap-1.5 bg-background/95 px-1.5 py-0.5 backdrop-blur-sm">
                <span className="h-2.5 w-0.5 shrink-0 rounded-full bg-[var(--repo-color)]" />
                <span className="text-[10px] font-semibold text-foreground/80">{chunk.repo}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[9.5px] text-muted-foreground">{chunk.path}</span>
                <span className="rounded-full bg-muted px-1 text-[9px] tabular-nums text-muted-foreground">{chunk.items.length}</span>
              </div>
              <div className="ml-1.5 flex flex-col gap-px border-l border-[color-mix(in_oklab,var(--repo-color)_28%,var(--border))] pl-1.5">
                {chunk.items.map(item => {
                  const active = selectedSessionId === item.id
                  return (
                    <div
                      key={item.id}
                      role="button"
                      tabIndex={0}
                      title={`${item.title} · ${item.status}`}
                      className={[
                        'group grid min-h-7 cursor-pointer grid-cols-[12px_minmax(0,1fr)_auto_auto] items-center gap-1 rounded-md px-1 py-0.5 text-left transition-colors',
                        active ? 'bg-primary/10' : 'hover:bg-muted/70',
                        item.status === 'running' && !active ? 'bg-emerald-500/8' : '',
                        item.status === 'awaiting' && !active ? 'bg-amber-500/10' : '',
                      ].filter(Boolean).join(' ')}
                      onClick={() => { setSelectedSessionId(item.id) }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setSelectedSessionId(item.id)
                        }
                      }}
                    >
                      <span className="flex size-3 items-center justify-center">
                        {item.status === 'running' ? (
                          <span className="size-2 animate-spin rounded-full border-[1.5px] border-emerald-600 border-r-transparent" />
                        ) : item.status === 'awaiting' ? (
                          <Icon.MessageCircle size={11} strokeWidth={2.2} className="text-amber-600" />
                        ) : (
                          <span className="size-1.5 rounded-full border border-muted-foreground/40" />
                        )}
                      </span>
                      <span className={`min-w-0 truncate text-xs ${active ? 'font-semibold text-foreground' : 'font-medium text-foreground/90'}`}>
                        {item.title}
                      </span>
                      <span className="flex items-center justify-end gap-1">
                        {item.status === 'awaiting' ? (
                          <span className="size-1.5 rounded-full bg-amber-500 shadow-[0_0_0_2px_color-mix(in_oklab,var(--background)_40%,#fde68a)]" title="待你回复" />
                        ) : null}
                        <span className="min-w-[2.2em] text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                          {fmtDur(nowMs - item.updatedMs)}
                        </span>
                      </span>
                      <button
                        type="button"
                        title="从 Recent 移出"
                        className="flex size-[18px] items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation()
                          void removeRecent(item.id)
                        }}
                      >
                        <Icon.X size={11} strokeWidth={2} />
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5 border-t border-border bg-muted/20 px-2 py-1.5">
        <Button size="xs" variant="ghost" className="h-7 px-2 text-xs" disabled={recentBusy} onClick={() => { void removeIdleRecent() }}>
          移出空闲
        </Button>
        <span className="flex-1" />
        <Button size="xs" variant="outline" className="h-7 gap-1 px-2.5 text-xs" onClick={() => { void setRecentMode(false) }}>
          <Icon.ChevronLeft size={12} strokeWidth={2} />
          All
        </Button>
      </div>

      {/* Drag edge — same range as pi-web sidebar (180–480). */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整 Recent 宽度"
        title="拖拽调整宽度（与 pi-web 侧栏同范围 180–480）"
        className={[
          'absolute inset-y-0 right-0 z-30 w-1.5 cursor-col-resize touch-none',
          'bg-transparent hover:bg-primary/25 active:bg-primary/40',
          resizingSide ? 'bg-primary/35' : '',
        ].join(' ')}
        onPointerDown={onResizePointerDown}
      />
          </motion.div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  ) : null

  return (
    <div className="flex h-svh min-h-0 w-full flex-col">
      <Toaster position="bottom-right" timeout={4000} />
      <style>{`
        .thin-scroll { scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
        .thin-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
        .thin-scroll::-webkit-scrollbar-track { background: transparent; }
        .thin-scroll::-webkit-scrollbar-thumb {
          background: var(--border);
          border-radius: 9999px;
          border: 3px solid transparent;
          background-clip: content-box;
        }
      `}</style>

      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Icon.Globe size={14} strokeWidth={2} />
        </div>
        <div className="flex min-w-0 flex-col">
          <h1 className="text-sm leading-tight font-semibold text-foreground">Pi Web</h1>
          <p className="text-[11px] leading-tight text-muted-foreground">本地 Pi Web · 检测 / 安装 / 托管</p>
        </div>

        <span className="flex-1" />

        {/* Center tab switcher: All Sessions | Recent Sessions */}
        {showFrame ? (
          <div
            className="relative inline-flex shrink-0 items-center gap-0.5 rounded-full border border-border bg-muted/55 p-0.5 shadow-inner"
            role="tablist"
            aria-label="Session list mode"
          >
            <button
              type="button"
              role="tab"
              aria-selected={!recentOpen}
              className={[
                'relative z-[1] inline-flex h-7 items-center rounded-full px-3.5 text-xs font-semibold tracking-tight',
                !recentOpen ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              ].join(' ')}
              onClick={() => { void setRecentMode(false) }}
            >
              {!recentOpen ? (
                <motion.span
                  layoutId="pi-web-session-mode-pill"
                  className="absolute inset-0 rounded-full bg-background shadow-sm ring-1 ring-border/60"
                  transition={{ type: 'spring', stiffness: 520, damping: 38, mass: 0.7 }}
                />
              ) : null}
              <span className="relative">All Sessions</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={recentOpen}
              className={[
                'relative z-[1] inline-flex h-7 items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold tracking-tight',
                recentOpen ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              ].join(' ')}
              onClick={() => { void setRecentMode(true) }}
            >
              {recentOpen ? (
                <motion.span
                  layoutId="pi-web-session-mode-pill"
                  className="absolute inset-0 rounded-full bg-background shadow-sm ring-1 ring-border/60"
                  transition={{ type: 'spring', stiffness: 520, damping: 38, mass: 0.7 }}
                />
              ) : null}
              <span className="relative inline-flex items-center gap-1.5">
                {recentRunning > 0 ? (
                  <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden />
                ) : null}
                Recent Sessions
                <span
                  className={[
                    'inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold tabular-nums',
                    recentAttention
                      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                      : 'bg-muted text-muted-foreground',
                  ].join(' ')}
                >
                  {recentCount}
                </span>
              </span>
            </button>
          </div>
        ) : null}

        <span className="flex-1" />

        <div className="flex shrink-0 items-center gap-1.5">
          {status === undefined ? (
            <span className="inline-flex h-6 items-center rounded-full border border-border bg-muted/40 px-2.5 text-xs text-muted-foreground">
              检测中
            </span>
          ) : (
            <>
              <span
                className={
                  status.installed
                    ? 'inline-flex h-6 items-center gap-1 rounded-full border border-border bg-muted/40 px-2.5 text-xs text-muted-foreground'
                    : 'inline-flex h-6 items-center rounded-full border border-destructive/30 bg-destructive/10 px-2.5 text-xs text-destructive'
                }
              >
                {status.installed ? (
                  <>
                    <span>已装</span>
                    <span className="font-mono tabular-nums text-foreground/80">{status.version ?? ''}</span>
                  </>
                ) : (
                  '未安装'
                )}
              </span>
              {status.updateAvailable === true ? (
                <span className="inline-flex h-6 items-center rounded-full border border-border bg-muted/40 px-2.5 text-xs text-muted-foreground">
                  可更新 → <span className="ml-1 font-mono tabular-nums text-foreground/80">{status.latest}</span>
                </span>
              ) : null}
              <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 text-xs text-muted-foreground">
                <span
                  className={
                    showFrame
                      ? 'size-1.5 shrink-0 rounded-full bg-emerald-500'
                      : 'size-1.5 shrink-0 rounded-full bg-muted-foreground/35'
                  }
                  aria-hidden
                />
                {showFrame ? '服务在线' : '服务未起'}
              </span>
            </>
          )}
          <Button
            size="xs"
            variant={recommendedMissing > 0 ? 'default' : 'outline'}
            aria-label={recommendedMissing > 0 ? `推荐插件，待装 ${recommendedMissing}` : '推荐插件'}
            title={recommendedMissing > 0 ? `推荐插件 · 待装 ${recommendedMissing}` : '推荐插件'}
            className="h-6 gap-1 rounded-full px-2.5"
            onClick={() => { openRecommended() }}
          >
            <Icon.Puzzle size={12} strokeWidth={2} />
            <span>推荐插件</span>
            {recommendedMissing > 0 ? (
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary-foreground/20 px-1 text-[10px] font-semibold tabular-nums leading-none">
                {recommendedMissing}
              </span>
            ) : null}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        {showFrame ? (
          <div className="relative min-h-0 w-full flex-1">
            <iframe
              key={`${site.generation}:${selectedSessionId ?? 'root'}`}
              title="Pi Web"
              src={frameSrc}
              className="absolute inset-0 size-full border-0 bg-background"
            />
            {recentOverlay}
          </div>
        ) : needsPanel ? (
          setupPanel
        ) : site.phase === 'failing' ? (
          <div className="flex h-full flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <div className="flex size-9 items-center justify-center rounded-full border border-destructive/35 bg-destructive/10 text-sm font-medium text-destructive">!</div>
            <p className="text-sm font-medium text-foreground">服务未能启动</p>
            <p className="max-w-sm text-xs text-balance text-muted-foreground">{site.error?.message ?? '未知原因'}</p>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => { void probe() }}>
                <Icon.RefreshCw size={13} strokeWidth={2} />
                重新检测
              </Button>
              <Button size="sm" onClick={() => { void site.retry() }}>
                <Icon.RotateCcw size={13} strokeWidth={2} />
                重试启动
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-1 flex-col items-center justify-center gap-2.5 p-6 text-center">
            <Spinner className="size-5 text-primary" />
            <p className="text-sm font-medium text-foreground">正在启动 pi-web</p>
            <p className="max-w-xs text-xs text-muted-foreground">首次启动需要构建页面，可能需要一分钟</p>
          </div>
        )}
      </div>

      <Dialog open={updateOpen} onOpenChange={setUpdateOpen}>
        <DialogContent width="34rem">
          <DialogHeader>
            <DialogTitle>有可用更新</DialogTitle>
            <DialogDescription>更新 pi 与插件后需要重启 pi-web 服务才能生效。</DialogDescription>
          </DialogHeader>
          <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto thin-scroll pr-1">
            {updateInfo?.pi?.updateAvailable === true ? (
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted/25 px-2.5 py-2 text-sm">
                <Icon.Cpu size={13} strokeWidth={2} className="shrink-0 text-muted-foreground" />
                <span className="flex-1">pi</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {updateInfo.pi.current} → {updateInfo.pi.latest ?? '?'}
                </span>
              </div>
            ) : null}
            {(updateInfo?.packages ?? []).map(row => (
              <div key={row.pkg} className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/25 px-2.5 py-2 text-sm">
                <Icon.Puzzle size={13} strokeWidth={2} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{row.pkg}</span>
                <span className="font-mono text-xs text-muted-foreground">{row.current ?? '?'} → {row.latest ?? '?'}</span>
              </div>
            ))}
          </div>
          <DialogFooter className="items-center gap-2">
            <Button disabled={updating} onClick={() => { void runUpdateAll() }}>
              {updating ? <Spinner className="size-4" /> : <Icon.Download size={16} strokeWidth={2} />}
              一键更新并重启
            </Button>
            <Button variant="ghost" onClick={() => { setUpdateOpen(false) }}>稍后</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={recommendedOpen} onOpenChange={(open) => {
        setRecommendedOpen(open)
        if (open) void refreshRecommended().catch(() => undefined)
      }}>
        <DialogContent width="36rem">
          <DialogHeader>
            <DialogTitle>推荐插件</DialogTitle>
            <DialogDescription className="flex items-start justify-between gap-3">
              <span>安装后重启 pi-web 服务即可生效。</span>
              {recommendedTotal > 0 ? (
                <Badge variant="secondary" className="shrink-0 font-normal tabular-nums">
                  共 {recommendedTotal} 个
                  {recommendedInstalled > 0 ? ` · 已装 ${recommendedInstalled}` : ''}
                  {recommendedMissing > 0 ? ` · 待装 ${recommendedMissing}` : ''}
                </Badge>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto thin-scroll pr-1">
            {recommendedItems.map(item => (
              <div key={item.pkg} className="flex min-w-0 items-center gap-2.5 rounded-md border border-border bg-muted/25 px-2.5 py-2">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium text-foreground">{item.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{item.description}</span>
                </div>
                {item.installed ? (
                  <Badge variant="secondary">已装</Badge>
                ) : (
                  <Button size="sm" variant="outline" disabled={pluginBusy !== null} onClick={() => { void installPlugin(item.pkg) }}>
                    {pluginBusy === item.pkg ? <Spinner className="size-3.5" /> : <Icon.Plus size={13} strokeWidth={2} />}
                    安装
                  </Button>
                )}
              </div>
            ))}
          </div>
          <DialogFooter className="flex-wrap items-center gap-2">
            <div className="mr-auto flex min-w-0 flex-col gap-0.5">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                安装源
                <select
                  className="h-7 rounded-md border border-input bg-background px-1.5 text-xs"
                  value={registryChoice}
                  onChange={(e) => {
                    const value = e.target.value
                    setRegistryChoice(value === 'npmmirror' ? 'npmmirror' : value === 'direct' ? 'direct' : 'auto')
                  }}
                  disabled={pluginBusy !== null}
                >
                  <option value="auto">自动（测速）</option>
                  <option value="direct">国际</option>
                  <option value="npmmirror">国内镜像</option>
                </select>
              </label>
              {registryHint !== null ? (
                <span className="max-w-56 truncate text-[10px] text-muted-foreground">{registryHint}</span>
              ) : null}
            </div>
            {installingStep !== null ? (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Spinner className="size-3" />
                {installingStep}
              </span>
            ) : null}
            <Button disabled={busy !== null} onClick={() => { void restartServer() }}>
              {busy === 'restart' ? <Spinner className="size-4" /> : <Icon.RotateCw size={16} strokeWidth={2} />}
              重启服务
            </Button>
            {recommendedMissing > 0 ? (
              <Button disabled={pluginBusy !== null} onClick={() => { void installAll() }}>
                {pluginBusy === '__all__' ? <Spinner className="size-4" /> : <Icon.CheckCheck size={16} strokeWidth={2} />}
                一键全部安装
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => { setRecommendedOpen(false) }}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
