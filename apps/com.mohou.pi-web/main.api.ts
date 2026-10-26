import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'

import { defineApp, type AppContext, type AppSpawnHandle } from '@mohou/contract'

import { EV, RECOMMENDED, type RecentSessionItem, type RecentSessionStatus } from './shared/events.ts'

/** User home on both platforms (Windows answers USERPROFILE, not HOME). */
const HOME = process.env.HOME ?? process.env.USERPROFILE ?? ''

interface ShellCtx {
  readonly bash: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  readonly pwsh: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  readonly system: { metrics(): Promise<{ platform: string }> }
}

/**
 * One short command, on the shell this machine has. `windows` is the pwsh
 * equivalent and is used on win32 only.
 */
async function shell(
  ctx: ShellCtx,
  direct: string,
  windows: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const platform = (await ctx.system.metrics()).platform
  return platform === 'win32' ? await ctx.pwsh(windows) : await ctx.bash(direct)
}

/** The first x.y.z in the text, or null. Pre-release suffixes are ignored by callers. */
function versionOf(text: string): string | null {
  const match = /\d+\.\d+\.\d+/.exec(text)
  return match === null ? null : (match[0] ?? null)
}

/** A registry package name or null; rejects anything that could reshape a shell command. */
function npmName(pkg: string): string | null {
  return /^@?[a-z0-9][a-z0-9/._@-]*$/i.test(pkg) && pkg.length <= 214 ? pkg : null
}

const HOST = '127.0.0.1'
/** Preferred port from the manifest url; may yield to a free port when occupied externally. */
const PREFERRED_PORT = 30141
const PACKAGE = '@agegr/pi-web'
const PI_PACKAGE = '@earendil-works/pi-coding-agent'

type RegistryId = 'direct' | 'npmmirror'
type RegistryChoice = RegistryId | 'auto'

const REGISTRY_URL: Record<RegistryId, string> = {
  direct: 'https://registry.npmjs.org',
  npmmirror: 'https://registry.npmmirror.com',
}

/** Probe path shared by both registries (scoped package, always published). */
const REGISTRY_PROBE_PATH = `/@agegr%2fpi-web`
const REGISTRY_PROBE_MS = 5_000

function urlFor(port: number): string {
  return `http://${HOST}:${port}`
}

/** npm/pi long-command budget. Runs on a spawn (no host timeout); this is ours. */
const COMMAND_BUDGET_MS = 3_600_000
const POLL_MS = 1_200
const LOG_TAIL_CHARS = 6_000

/** `pi-web --version` answers, or null when the binary is missing. */
async function piWebVersion(ctx: ShellCtx): Promise<string | null> {
  try {
    const result = await shell(ctx, 'pi-web --version', 'pi-web --version')
    if (result.exitCode !== 0) return null
    return versionOf(result.stdout)
  } catch {
    return null
  }
}

/** `pi --version` answers, or null when the CLI is missing. */
async function piVersion(ctx: ShellCtx): Promise<string | null> {
  try {
    const result = await shell(ctx, 'pi --version', 'pi --version')
    if (result.exitCode !== 0) return null
    return versionOf(result.stdout)
  } catch {
    return null
  }
}

/** `npm view` answers, or null when the registry is unreachable. */
async function npmLatest(ctx: ShellCtx, pkg: string, registry?: RegistryId): Promise<string | null> {
  const name = npmName(pkg)
  if (name === null) return null
  const flag = registry === undefined ? '' : ` --registry=${REGISTRY_URL[registry]}`
  try {
    const result = await shell(ctx, `npm view ${name} version${flag}`, `npm view ${name} version${flag}`)
    if (result.exitCode !== 0) return null
    return versionOf(result.stdout)
  } catch {
    return null
  }
}

function parseRegistryChoice(value: unknown): RegistryChoice {
  if (value === 'npmmirror' || value === 'direct' || value === 'auto') return value
  return 'auto'
}

function registryLabel(id: RegistryId): string {
  return id === 'npmmirror' ? '国内镜像' : '国际源'
}

function npmRegistryArgs(id: RegistryId): string[] {
  return id === 'npmmirror' ? [`--registry=${REGISTRY_URL.npmmirror}`] : []
}

function npmRegistryEnv(id: RegistryId): Readonly<Record<string, string>> | undefined {
  return id === 'npmmirror' ? { npm_config_registry: REGISTRY_URL.npmmirror } : undefined
}

/** Round-trip latency to one registry, or null when unreachable within the budget. */
async function registryLatency(ctx: AppContext, id: RegistryId): Promise<number | null> {
  const started = Date.now()
  try {
    const response = await ctx.http(`${REGISTRY_URL[id]}${REGISTRY_PROBE_PATH}`, { timeout: REGISTRY_PROBE_MS })
    if (!response.ok) return null
    return Date.now() - started
  } catch {
    return null
  }
}

/**
 * Pick the faster reachable registry. When both probes fail, prefer npmmirror
 * (this app is CN-facing); the install path still falls back on failure.
 */
async function probeRegistries(ctx: AppContext): Promise<{
  readonly registry: RegistryId
  readonly directMs: number | null
  readonly npmmirrorMs: number | null
}> {
  const [directMs, npmmirrorMs] = await Promise.all([
    registryLatency(ctx, 'direct'),
    registryLatency(ctx, 'npmmirror'),
  ])
  let registry: RegistryId = 'npmmirror'
  if (directMs !== null && npmmirrorMs !== null) {
    registry = directMs <= npmmirrorMs ? 'direct' : 'npmmirror'
  } else if (directMs !== null) {
    registry = 'direct'
  } else if (npmmirrorMs !== null) {
    registry = 'npmmirror'
  }
  return { registry, directMs, npmmirrorMs }
}

async function resolveRegistry(ctx: AppContext, choice: RegistryChoice): Promise<{
  readonly registry: RegistryId
  readonly auto: boolean
  readonly directMs?: number | null
  readonly npmmirrorMs?: number | null
}> {
  if (choice !== 'auto') return { registry: choice, auto: false }
  const picked = await probeRegistries(ctx)
  return { registry: picked.registry, auto: true, directMs: picked.directMs, npmmirrorMs: picked.npmmirrorMs }
}

function otherRegistry(id: RegistryId): RegistryId {
  return id === 'direct' ? 'npmmirror' : 'direct'
}

/** Run `action` on the chosen registry; on auto mode, retry the other source once. */
async function withRegistryFallback<T>(
  ctx: AppContext,
  choice: RegistryChoice,
  action: (registry: RegistryId) => Promise<T>,
): Promise<T & { readonly registry: RegistryId; readonly fellBack?: boolean }> {
  const resolved = await resolveRegistry(ctx, choice)
  if (resolved.auto) {
    const parts = [
      `自动选源 → ${registryLabel(resolved.registry)}`,
      resolved.directMs === null ? '国际不可达' : `国际 ${resolved.directMs}ms`,
      resolved.npmmirrorMs === null ? '国内不可达' : `国内 ${resolved.npmmirrorMs}ms`,
    ]
    ctx.push(EV.installLog, { text: parts.join(' · '), done: false })
  }
  try {
    const result = await action(resolved.registry)
    return { ...result as T & object, registry: resolved.registry }
  } catch (first) {
    if (!resolved.auto) throw first
    const fallback = otherRegistry(resolved.registry)
    const firstMessage = first instanceof Error ? first.message : String(first)
    ctx.push(EV.installLog, {
      text: `${registryLabel(resolved.registry)} 失败，改用 ${registryLabel(fallback)}…\n${firstMessage}`,
      done: false,
    })
    try {
      const result = await action(fallback)
      return { ...result as T & object, registry: fallback, fellBack: true }
    } catch (second) {
      const secondMessage = second instanceof Error ? second.message : String(second)
      throw new Error(
        `${registryLabel(resolved.registry)}：${firstMessage}\n${registryLabel(fallback)}：${secondMessage}`,
      )
    }
  }
}

function isNewer(candidate: string, current: string): boolean {
  const a = releaseTriple(candidate)
  const b = releaseTriple(current)
  if (a === null || b === null) return false
  for (let index = 0; index < 3; index += 1) {
    const left = a[index] ?? 0
    const right = b[index] ?? 0
    if (left !== right) return left > right
  }
  return false
}

/** `1.2.3-beta` → `[1, 2, 3]`. Null when it is not a release triple. */
function releaseTriple(version: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** npm-cli.js next to the running node (Windows layout, then the unix global layout). */
function findNpmCli(): string | null {
  const bin = path.dirname(process.execPath)
  const candidates = [
    path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  return candidates.find(candidate => existsSync(candidate)) ?? null
}

function tail(text: string, max = LOG_TAIL_CHARS): string {
  return text.length > max ? `…${text.slice(text.length - max)}` : text
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

/** Settings packages of the pi this app serves (`npm:…` entries only). */
function piPackages(): string[] {
  try {
    const settings = JSON.parse(
      readFileSync(path.join(HOME, '.pi', 'agent', 'settings.json'), 'utf8'),
    ) as { packages?: unknown }
    if (!Array.isArray(settings.packages)) return []
    return settings.packages.filter((item): item is string => typeof item === 'string' && item.startsWith('npm:'))
  } catch {
    return []
  }
}

/** Installed version of one `npm:x` pi package, from the pi package store. */
function piPackageVersion(pkg: string): string | null {
  const name = pkg.slice('npm:'.length)
  const file = path.join(HOME, '.pi', 'agent', 'npm', 'node_modules', ...name.split('/'), 'package.json')
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

/** Command targets are `.cmd` shims on Windows; `cmd.exe /c` runs them for us. */
async function spawnCommand(
  ctx: AppContext,
  file: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
): Promise<AppSpawnHandle> {
  const platform = (await ctx.system.metrics()).platform
  if (platform === 'win32') {
    return await ctx.spawn('cmd.exe', ['/c', file, ...args], env === undefined ? {} : { env })
  }
  return await ctx.spawn(file, args, env === undefined ? {} : { env })
}

/** Run one long child to completion, streaming its console to the view. Throws on non-zero exit. */
async function runStreaming(
  ctx: AppContext,
  file: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
): Promise<{ readonly output: string }> {
  const child = await spawnCommand(ctx, file, args, env)
  const started = Date.now()
  let output = ''
  for (;;) {
    const settled = await Promise.race([child.exited.then(() => true), sleep(POLL_MS).then(() => false)])
    output = child.output()
    ctx.push(EV.installLog, { text: tail(output), done: false })
    if (settled) break
    if (Date.now() - started > COMMAND_BUDGET_MS) {
      await child.kill()
      throw new Error('命令超时（1 小时）')
    }
  }
  const exited = await child.exited
  output = child.output()
  ctx.push(EV.installLog, { text: tail(output), done: true })
  if (exited.exitCode !== 0) {
    const text = tail(output, 2_000).trim()
    throw new Error(text.length > 0 ? text : `命令退出码 ${exited.exitCode}`)
  }
  return { output: tail(output, 2_000) }
}

/**
 * The website session bag. Requires Host ≥ 1.0.95 (`ctx.website.state` in driver
 * hooks); an older Host answers with this error instead of silently losing the handle.
 */
function sessionBag(ctx: AppContext): Record<string, unknown> {
  if (ctx.website === undefined) {
    throw new Error('需要 Mohou Host ≥ 1.0.95（website 会话状态支持）')
  }
  return ctx.website.state
}

/** The held server handle, or undefined when this session did not start it. */
function serverOf(bag: Record<string, unknown>): AppSpawnHandle | undefined {
  return bag.server as AppSpawnHandle | undefined
}

/** True when nothing is listening so we can bind this port. */
function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, HOST, () => {
      server.close(() => resolve(true))
    })
  })
}

/** Prefer the default port; if taken (external process), ask the OS for a free one. */
async function allocatePort(preferred: number): Promise<number> {
  if (await canBind(preferred)) return preferred
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, HOST, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close((error) => {
        if (error !== undefined) reject(error)
        else if (port <= 0) reject(new Error('无法分配端口'))
        else resolve(port)
      })
    })
  })
}

async function startServer(ctx: AppContext, restart: boolean): Promise<{ readonly url: string }> {
  const bag = sessionBag(ctx)
  const heldUrl = typeof bag.url === 'string' ? bag.url : undefined

  if (restart) {
    const held = serverOf(bag)
    if (held !== undefined) {
      await held.kill().catch(() => undefined)
      bag.server = undefined
    }
    bag.url = undefined
  } else {
    // Reuse our own held child when it still answers.
    if (heldUrl !== undefined && serverOf(bag) !== undefined) {
      try {
        if ((await ctx.http(heldUrl, { timeout: 1_500 })).ok) return { url: heldUrl }
      } catch {
        // fall through and respawn
      }
    }
  }

  if (await piWebVersion(ctx) === null) throw new Error('pi-web 未安装')

  // Preferred port busy and not our child → external process; pick another port and log.
  // We never kill a process we did not spawn.
  const port = await allocatePort(PREFERRED_PORT)
  const url = urlFor(port)
  if (port !== PREFERRED_PORT) {
    ctx.log(`pi-web: 端口 ${PREFERRED_PORT} 已被占用，改用 ${port}`)
  }

  const child = await spawnCommand(ctx, 'pi-web', ['--no-open', '--port', String(port)])
  bag.server = child
  bag.url = url
  await child.ready({ url, timeoutMs: 120_000 })
  return { url }
}

// ── Recent Sessions (shell overlay over pi-web left rail) ───────────────────

const RECENT_STORE_KEY = 'recentSessions'
const RECENT_OPEN_KEY = 'recentOpen'

interface RecentMember {
  readonly addedAt: number
  readonly lastRunningAt: number
}

interface RecentStore {
  readonly version: 1
  readonly ids: Readonly<Record<string, RecentMember>>
}

interface PiWebSessionRow {
  readonly id: string
  readonly cwd: string
  readonly path?: string
  readonly name?: string
  readonly firstMessage?: string
  readonly modified?: string
  readonly projectRoot?: string
  readonly projectKey?: string
}

function emptyRecentStore(): RecentStore {
  return { version: 1, ids: {} }
}

function parseRecentStore(value: unknown): RecentStore {
  if (!isPlain(value) || value.version !== 1 || !isPlain(value.ids)) return emptyRecentStore()
  const ids: Record<string, RecentMember> = {}
  for (const [id, meta] of Object.entries(value.ids)) {
    if (!isPlain(meta)) continue
    const addedAt = typeof meta.addedAt === 'number' ? meta.addedAt : Date.now()
    const lastRunningAt = typeof meta.lastRunningAt === 'number' ? meta.lastRunningAt : addedAt
    ids[id] = { addedAt, lastRunningAt }
  }
  return { version: 1, ids }
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readRecentStore(ctx: AppContext): Promise<RecentStore> {
  return parseRecentStore(await ctx.storage.kv().get(RECENT_STORE_KEY))
}

async function writeRecentStore(ctx: AppContext, store: RecentStore): Promise<void> {
  await ctx.storage.kv().set(RECENT_STORE_KEY, store)
}

/** Base URL of the live pi-web this shell hosts (session bag), else the preferred port. */
function piWebOrigin(ctx: AppContext): string {
  try {
    const bag = sessionBag(ctx)
    if (typeof bag.url === 'string' && bag.url.startsWith('http')) return bag.url.replace(/\/$/, '')
  } catch {
    // website session may be unavailable outside website hooks
  }
  return urlFor(PREFERRED_PORT)
}

async function fetchJson(ctx: AppContext, url: string, timeout = 6_000): Promise<unknown | null> {
  try {
    const response = await ctx.http(url, { timeout })
    if (!response.ok) return null
    if (response.json !== undefined) return response.json
    if (typeof response.text === 'string' && response.text.length > 0) {
      try {
        return JSON.parse(response.text) as unknown
      } catch {
        return null
      }
    }
    return null
  } catch {
    return null
  }
}

function basenamePath(cwd: string): string {
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

function titleOf(row: PiWebSessionRow): string {
  const named = typeof row.name === 'string' ? row.name.trim() : ''
  if (named.length > 0) return named
  const first = typeof row.firstMessage === 'string' ? row.firstMessage.trim().replace(/\s+/g, ' ') : ''
  if (first.length > 0) return first.length > 72 ? `${first.slice(0, 72)}…` : first
  return row.id.slice(0, 8)
}

function parseSessionRows(raw: unknown): PiWebSessionRow[] {
  const list = isPlain(raw) && Array.isArray(raw.sessions)
    ? raw.sessions
    : Array.isArray(raw)
      ? raw
      : []
  const rows: PiWebSessionRow[] = []
  for (const item of list) {
    if (!isPlain(item) || typeof item.id !== 'string') continue
    const cwd = typeof item.cwd === 'string' ? item.cwd : ''
    rows.push({
      id: item.id,
      cwd,
      ...typeof item.path === 'string' ? { path: item.path } : {},
      ...typeof item.name === 'string' ? { name: item.name } : {},
      ...typeof item.firstMessage === 'string' ? { firstMessage: item.firstMessage } : {},
      ...typeof item.modified === 'string' ? { modified: item.modified } : {},
      ...typeof item.projectRoot === 'string' ? { projectRoot: item.projectRoot } : {},
      ...typeof item.projectKey === 'string' ? { projectKey: item.projectKey } : {},
    })
  }
  return rows
}

function stringIdSet(raw: unknown, key: string): Set<string> {
  if (!isPlain(raw) || !Array.isArray(raw[key])) return new Set()
  return new Set(raw[key].filter((id): id is string => typeof id === 'string' && id.length > 0))
}

function versionNumber(raw: unknown, key: string): number | null {
  if (!isPlain(raw) || typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) return null
  return raw[key]
}

/** Match pi-web SessionSidebar resize (storageKey pi-sidebar-width). */
const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 480
const SIDEBAR_DEFAULT = 260
const SIDEBAR_WIDTH_KEY = 'recentSidebarWidth'
const CATALOG_CACHE_KEY = 'recentCatalogCache'

interface CatalogCache {
  readonly version: number | null
  readonly rows: readonly PiWebSessionRow[]
  readonly fetchedAt: number
}

function clampSidebarWidth(n: number): number {
  if (!Number.isFinite(n)) return SIDEBAR_DEFAULT
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(n)))
}

function parseCatalogCache(value: unknown): CatalogCache | null {
  if (!isPlain(value) || !Array.isArray(value.rows)) return null
  const version = typeof value.version === 'number' ? value.version : null
  const fetchedAt = typeof value.fetchedAt === 'number' ? value.fetchedAt : 0
  return { version, rows: parseSessionRows({ sessions: value.rows }), fetchedAt }
}

async function readCatalogCache(ctx: AppContext): Promise<CatalogCache | null> {
  return parseCatalogCache(await ctx.storage.kv().get(CATALOG_CACHE_KEY))
}

async function writeCatalogCache(ctx: AppContext, cache: CatalogCache): Promise<void> {
  await ctx.storage.kv().set(CATALOG_CACHE_KEY, {
    version: cache.version,
    fetchedAt: cache.fetchedAt,
    rows: cache.rows,
  })
}

async function admitRunning(
  ctx: AppContext,
  running: ReadonlySet<string>,
  awaiting: ReadonlySet<string>,
): Promise<RecentStore> {
  const store = await readRecentStore(ctx)
  const now = Date.now()
  const ids: Record<string, RecentMember> = { ...store.ids }
  let changed = false
  for (const id of [...running, ...awaiting]) {
    if (ids[id] === undefined) {
      ids[id] = { addedAt: now, lastRunningAt: now }
      changed = true
    }
  }
  const next: RecentStore = { version: 1, ids }
  if (changed) await writeRecentStore(ctx, next)
  return next
}

function buildRecentItems(
  store: RecentStore,
  catalogue: readonly PiWebSessionRow[],
  running: ReadonlySet<string>,
  awaiting: ReadonlySet<string>,
): RecentSessionItem[] {
  const byId = new Map(catalogue.map(row => [row.id, row]))
  const now = Date.now()
  const items: RecentSessionItem[] = []
  for (const id of Object.keys(store.ids)) {
    const row = byId.get(id)
    const cwd = row?.cwd ?? ''
    const projectRoot = row?.projectRoot ?? row?.cwd ?? ''
    const repo = basenamePath(projectRoot || cwd || id)
    const modified = row?.modified ?? new Date(store.ids[id]?.lastRunningAt ?? now).toISOString()
    const updatedMs = Date.parse(modified)
    let status: RecentSessionStatus = 'idle'
    if (running.has(id)) status = 'running'
    else if (awaiting.has(id)) status = 'awaiting'
    items.push({
      id,
      title: row !== undefined ? titleOf(row) : id.slice(0, 8),
      cwd,
      repo,
      ...projectRoot.length > 0 ? { projectRoot } : {},
      status,
      updated: modified,
      updatedMs: Number.isFinite(updatedMs) ? updatedMs : (store.ids[id]?.lastRunningAt ?? now),
    })
  }
  items.sort((a, b) => b.updatedMs - a.updatedMs)
  return items
}

async function fetchRunning(ctx: AppContext, origin: string): Promise<{
  readonly running: Set<string>
  readonly awaiting: Set<string>
  readonly sessionListVersion: number | null
}> {
  const raw = await fetchJson(ctx, `${origin}/api/agent/running`, 4_000)
  return {
    running: stringIdSet(raw, 'runningSessionIds'),
    awaiting: stringIdSet(raw, 'awaitingInputSessionIds'),
    sessionListVersion: versionNumber(raw, 'sessionListVersion'),
  }
}

/**
 * Ensure catalogue is fresh for `wantVersion` (null = always refresh).
 * Returns rows + the version we believe we have.
 */
async function ensureCatalogue(
  ctx: AppContext,
  origin: string,
  wantVersion: number | null,
  force: boolean,
): Promise<{ readonly rows: readonly PiWebSessionRow[]; readonly version: number | null; readonly fetched: boolean }> {
  const cached = await readCatalogCache(ctx)
  if (
    !force
    && cached !== null
    && wantVersion !== null
    && cached.version === wantVersion
  ) {
    return { rows: cached.rows, version: cached.version, fetched: false }
  }

  const sessionsRaw = await fetchJson(ctx, `${origin}/api/sessions`, 12_000)
  const rows = parseSessionRows(sessionsRaw)
  const fromSessions = versionNumber(sessionsRaw, 'sessionListVersion')
  const version = fromSessions ?? wantVersion ?? cached?.version ?? null
  await writeCatalogCache(ctx, { version, rows, fetchedAt: Date.now() })
  return { rows, version, fetched: true }
}

async function composeRecent(
  ctx: AppContext,
  opts: { readonly forceCatalog?: boolean },
): Promise<{
  readonly items: RecentSessionItem[]
  readonly runningCount: number
  readonly awaitingCount: number
  readonly open: boolean
  readonly origin: string
  readonly sessionListVersion: number | null
  readonly catalogFetched: boolean
  readonly sidebarWidth: number
}> {
  const origin = piWebOrigin(ctx)
  const pulse = await fetchRunning(ctx, origin)
  const store = await admitRunning(ctx, pulse.running, pulse.awaiting)

  // Catalog only when version moved, cache empty, force, or we lack titles for members.
  const cached = await readCatalogCache(ctx)
  const memberIds = Object.keys(store.ids)
  const cacheHasMembers = cached !== null && memberIds.every(id => cached.rows.some(row => row.id === id))
  const versionChanged = pulse.sessionListVersion !== null
    && cached !== null
    && cached.version !== null
    && cached.version !== pulse.sessionListVersion
  const needCatalog = opts.forceCatalog === true
    || cached === null
    || cached.rows.length === 0
    || versionChanged
    || !cacheHasMembers

  let rows: readonly PiWebSessionRow[] = cached?.rows ?? []
  let catalogFetched = false
  let version = cached?.version ?? pulse.sessionListVersion
  if (needCatalog) {
    const cat = await ensureCatalogue(ctx, origin, pulse.sessionListVersion, opts.forceCatalog === true)
    rows = cat.rows
    version = cat.version
    catalogFetched = cat.fetched
  }

  const items = buildRecentItems(store, rows, pulse.running, pulse.awaiting)
  const open = (await ctx.storage.kv().get(RECENT_OPEN_KEY)) === true
  const widthRaw = await ctx.storage.kv().get(SIDEBAR_WIDTH_KEY)
  const sidebarWidth = clampSidebarWidth(typeof widthRaw === 'number' ? widthRaw : SIDEBAR_DEFAULT)

  return {
    items,
    runningCount: items.filter(item => item.status === 'running').length,
    awaitingCount: items.filter(item => item.status === 'awaiting').length,
    open,
    origin,
    sessionListVersion: version,
    catalogFetched,
    sidebarWidth,
  }
}

/** Full compose (force catalogue refresh). */
async function syncRecentSessions(ctx: AppContext) {
  return await composeRecent(ctx, { forceCatalog: true })
}

/** Lightweight path: running heartbeat + catalogue only if version/membership requires it. */
async function pulseRecentSessions(ctx: AppContext) {
  return await composeRecent(ctx, { forceCatalog: false })
}

export default defineApp({
  name: 'Pi Web',
  description: 'Local Pi Web UI without opening a browser',
  api: {
    async status(ctx) {
      const [version, latest] = await Promise.all([piWebVersion(ctx), npmLatest(ctx, PACKAGE)])
      return {
        installed: version !== null,
        ...version === null ? {} : { version },
        ...latest === null ? {} : { latest },
        updateAvailable: version !== null && latest !== null && isNewer(latest, version),
      }
    },

    /**
     * Probe international vs npmmirror latency and return the faster reachable one.
     * UI can show the pick; install/auto uses the same rule.
     */
    async pickRegistry(ctx) {
      const picked = await probeRegistries(ctx)
      return {
        registry: picked.registry,
        label: registryLabel(picked.registry),
        directMs: picked.directMs,
        npmmirrorMs: picked.npmmirrorMs,
      }
    },

    /** Install or update the global pi-web, streaming the npm console to the view. */
    async install(ctx, args) {
      const choice = parseRegistryChoice(args?.registry)
      const npmCli = findNpmCli()
      if (npmCli === null) throw new Error('找不到 npm（node 目录下没有 npm-cli.js）')
      const outcome = await withRegistryFallback(ctx, choice, async (registry) => {
        await runStreaming(
          ctx,
          process.execPath,
          [npmCli, 'install', '-g', `${PACKAGE}@latest`, ...npmRegistryArgs(registry)],
        )
        const version = await piWebVersion(ctx)
        if (version === null) throw new Error('安装完成但 pi-web 仍不可用')
        return { version }
      })
      return outcome
    },

    /** pi itself plus every installed pi plugin: current vs registry version. */
    async updateCheck(ctx) {
      // One read of the settings: a second read could race an install and skew the index join.
      const packages = piPackages()
      const [piCurrent, piLatest, ...pluginLatest] = await Promise.all([
        piVersion(ctx),
        npmLatest(ctx, PI_PACKAGE),
        ...packages.map(pkg => npmLatest(ctx, pkg.slice('npm:'.length))),
      ])
      return {
        ...piCurrent === null ? {} : { pi: { current: piCurrent, ...piLatest === null ? {} : { latest: piLatest }, updateAvailable: piLatest !== null && isNewer(piLatest, piCurrent) } },
        packages: packages.map((pkg, index) => {
          const current = piPackageVersion(pkg)
          const latest = pluginLatest[index] ?? null
          return {
            pkg,
            ...current === null ? {} : { current },
            ...latest === null ? {} : { latest },
            updateAvailable: current !== null && latest !== null && isNewer(latest, current),
          }
        }).filter(row => row.updateAvailable === true),
      }
    },

    /** `pi update --all`: pi and every plugin, console streamed to the view. */
    async updateAll(ctx) {
      return await runStreaming(ctx, 'pi', ['update', '--all', '--no-approve'])
    },

    /**
     * Recommended plugin list with installed flags. `firstRun` stays true until the
     * view marks it (`mark: true`), so a programmatic probe does not consume the
     * first-run popup.
     */
    async recommended(ctx, args) {
      const seen = await ctx.storage.kv().get('recommendedSeen')
      const first = seen !== true
      if (first && args?.mark === true) await ctx.storage.kv().set('recommendedSeen', true)
      const installed = new Set(piPackages())
      return {
        firstRun: first,
        items: RECOMMENDED.map(item => ({ ...item, installed: installed.has(item.pkg) })),
      }
    },

    /** Install one pi plugin (`pi install npm:…`); registry auto picks + falls back. */
    async installPlugin(ctx, args) {
      const pkg = String(args?.pkg ?? '').trim()
      if (!/^npm:[@a-z0-9/._-]+$/i.test(pkg)) throw new Error('不是有效的 npm: 插件名')
      const choice = parseRegistryChoice(args?.registry)
      // Streamed like install/update: a plugin's dependencies can outrun a one-shot shell's budget.
      const outcome = await withRegistryFallback(ctx, choice, async (registry) => {
        await runStreaming(ctx, 'pi', ['install', pkg, '--no-approve'], npmRegistryEnv(registry))
        if (!new Set(piPackages()).has(pkg)) throw new Error('安装命令完成，但未检测到插件')
        return { installed: true as const }
      })
      return outcome
    },

    /**
     * Full Recent rebuild (forces /api/sessions). Prefer recentPulse on the timer.
     */
    async recentSync(ctx) {
      return await syncRecentSessions(ctx)
    },

    /**
     * Lightweight heartbeat: always hits /api/agent/running; loads /api/sessions only
     * when sessionListVersion moved or catalogue cache cannot title members.
     */
    async recentPulse(ctx) {
      return await pulseRecentSessions(ctx)
    },

    /** Drop one id from Recent membership (does not delete the pi session file). */
    async recentRemove(ctx, args) {
      const id = String(args?.id ?? '').trim()
      if (id.length === 0) throw new Error('缺少 session id')
      const store = await readRecentStore(ctx)
      if (store.ids[id] !== undefined) {
        const next = { ...store.ids }
        delete next[id]
        await writeRecentStore(ctx, { ...store, ids: next })
      }
      return await pulseRecentSessions(ctx)
    },

    /** Drop every idle (not running / not awaiting) member. */
    async recentRemoveIdle(ctx) {
      const snap = await pulseRecentSessions(ctx)
      const keep = new Set(
        snap.items.filter(item => item.status === 'running' || item.status === 'awaiting').map(item => item.id),
      )
      const store = await readRecentStore(ctx)
      const next: RecentStore['ids'] = {}
      for (const [id, meta] of Object.entries(store.ids)) {
        if (keep.has(id)) next[id] = meta
      }
      await writeRecentStore(ctx, { ...store, ids: next })
      return await pulseRecentSessions(ctx)
    },

    /** Remember whether the shell left-rail is showing Recent (vs All Sessions). */
    async recentMode(ctx, args) {
      if (args?.open === true || args?.open === false) {
        await ctx.storage.kv().set(RECENT_OPEN_KEY, args.open === true)
      }
      const open = (await ctx.storage.kv().get(RECENT_OPEN_KEY)) === true
      return { open }
    },

    /**
     * Overlay width aligned with pi-web SessionSidebar limits (180–480, default 260).
     * Cross-origin iframe cannot read pi-sidebar-width localStorage; shell keeps its own
     * width and exposes a drag handle so it can track the same range interactively.
     */
    async recentSidebarWidth(ctx, args) {
      if (typeof args?.width === 'number') {
        const width = clampSidebarWidth(args.width)
        await ctx.storage.kv().set(SIDEBAR_WIDTH_KEY, width)
        return { width, min: SIDEBAR_MIN, max: SIDEBAR_MAX, default: SIDEBAR_DEFAULT }
      }
      const raw = await ctx.storage.kv().get(SIDEBAR_WIDTH_KEY)
      const width = clampSidebarWidth(typeof raw === 'number' ? raw : SIDEBAR_DEFAULT)
      return { width, min: SIDEBAR_MIN, max: SIDEBAR_MAX, default: SIDEBAR_DEFAULT }
    },
  },
  website: {
    /** Reuse a live server; otherwise hold one child. A missing binary surfaces as a failure. */
    async ensure(ctx) {
      return await startServer(ctx, false)
    },
    /** Author-driven restart: kill our child and start a fresh one so new plugins load. */
    async refresh(ctx) {
      return await startServer(ctx, true)
    },
  },
})
