import { useCallback, useEffect, useState, type ReactNode } from 'react'

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

import { EV, type InstallLog } from './shared/events.ts'

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

function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught)
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
  const [registryChoice, setRegistryChoice] = useState<'direct' | 'npmmirror'>('direct')

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
          // an agent's probe may have flipped firstRun already; keep the freshest items
          return rec === undefined ? recommended : { ...rec, firstRun: recommended?.firstRun === true || rec.firstRun }
        })
        // One modal at a time: the update dialog wins; the recommended list waits for it.
        if (rec?.firstRun === true && !updatesShown) {
          setRecommendedOpen(true)
          void call('recommended', { mark: true }).catch(() => undefined)
        }
      } catch {
        // recommended list is advisory
      }
    })()
    return () => {
      cancelled = true
    }
  }, [call, site.phase])

  const restartServer = useCallback(async () => {
    setBusy('restart')
    try {
      // restart lives in the driver refresh: kill the held child, start a fresh one
      await site.refresh()
      toast.add({ title: 'pi-web 服务已重启', description: '新插件已加载' })
    } catch (caught) {
      toast.add({ title: '重启失败', description: messageOf(caught), type: 'error' })
    } finally {
      setBusy(null)
    }
  }, [site])

  const runInstall = useCallback(async (registry: 'direct' | 'npmmirror', mode: 'install' | 'update') => {
    setBusy(registry)
    setLog('')
    try {
      await call('install', { registry })
      toast.add({ title: mode === 'update' ? 'pi-web 已更新' : 'pi-web 已安装', description: '正在启动服务' })
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
      // Close when the recheck is clean; keep the dialog open only with leftovers.
      if (updates.pi?.updateAvailable !== true && updates.packages.length === 0) setUpdateOpen(false)
    } catch (caught) {
      toast.add({ title: '更新失败', description: messageOf(caught), type: 'error' })
    } finally {
      setUpdating(false)
    }
  }, [call, restartServer])

  const installOne = useCallback(async (pkg: string) => {
    await call('installPlugin', { pkg, ...registryChoice === 'npmmirror' ? { registry: 'npmmirror' } : {} })
    const rec = asRecommended(await call('recommended', {}))
    setRecommended(rec === undefined ? undefined : { ...rec, firstRun: false })
  }, [call, registryChoice])

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
  const hasUpdates = updateInfo !== undefined && ((updateInfo.pi?.updateAvailable === true) || updateInfo.packages.length > 0)

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
            <Button disabled={busy !== null} onClick={() => { void runInstall('direct', mode) }}>
              {busy === 'direct' ? <Spinner className="size-3.5" /> : <Icon.Zap size={15} strokeWidth={2} />}
              {mode === 'update' ? '国际源更新' : '高速外网安装'}
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

  const recommendedItems = recommended?.items ?? []
  const recommendedTotal = recommendedItems.length
  const recommendedInstalled = recommendedItems.filter(item => item.installed).length
  const recommendedMissing = recommendedTotal - recommendedInstalled

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

      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Icon.Globe size={14} strokeWidth={2} />
        </div>
        <div className="flex flex-col">
          <h1 className="text-sm leading-tight font-semibold text-foreground">Pi Web</h1>
          <p className="text-[11px] leading-tight text-muted-foreground">本地 Pi Web · 检测 / 安装 / 托管</p>
        </div>
        <span className="flex-1" />
        {status === undefined ? (
          <Badge variant="secondary">检测中</Badge>
        ) : (
          <>
            <Badge variant={status.installed ? 'secondary' : 'destructive'}>
              {status.installed ? `已装 ${status.version ?? ''}` : '未安装'}
            </Badge>
            {status.updateAvailable === true ? <Badge>pi-web 可更新 → {status.latest}</Badge> : null}
            <Badge variant={showFrame ? 'default' : 'outline'}>{showFrame ? '服务在线' : '服务未起'}</Badge>
          </>
        )}
        <Button
          size="icon-sm"
          variant="outline"
          aria-label="推荐插件"
          title="推荐插件"
          onClick={() => { setRecommendedOpen(true) }}
        >
          <Icon.Puzzle size={14} strokeWidth={2} />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        {showFrame ? (
          <div className="relative min-h-0 w-full flex-1">
            <iframe
              key={site.generation}
              title="Pi Web"
              src={site.url}
              className="absolute inset-0 size-full border-0 bg-background"
            />
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

      {/* Updates: pi itself plus plugins, with one-click update + restart. */}
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

      {/* Recommended plugins: per-item install, restart at the bottom. */}
      <Dialog open={recommendedOpen} onOpenChange={setRecommendedOpen}>
        <DialogContent width="36rem">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              推荐插件
              {recommendedTotal > 0 ? (
                <Badge variant="secondary" className="font-normal tabular-nums">
                  共 {recommendedTotal} 个
                  {recommendedInstalled > 0 ? ` · 已装 ${recommendedInstalled}` : ''}
                  {recommendedMissing > 0 ? ` · 待装 ${recommendedMissing}` : ''}
                </Badge>
              ) : null}
            </DialogTitle>
            <DialogDescription>安装后重启 pi-web 服务即可生效。</DialogDescription>
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
            <label className="mr-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              安装源
              <select
                className="h-7 rounded-md border border-input bg-background px-1.5 text-xs"
                value={registryChoice}
                onChange={(e) => { setRegistryChoice(e.target.value === 'npmmirror' ? 'npmmirror' : 'direct') }}
                disabled={pluginBusy !== null}
              >
                <option value="direct">国际</option>
                <option value="npmmirror">国内镜像</option>
              </select>
            </label>
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
