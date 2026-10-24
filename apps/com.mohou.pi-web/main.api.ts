import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'

import { defineApp, type AppContext, type AppSpawnHandle } from '@mohou/contract'

import { EV, RECOMMENDED } from './shared/events.ts'

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
async function npmLatest(ctx: ShellCtx, pkg: string): Promise<string | null> {
  const name = npmName(pkg)
  if (name === null) return null
  try {
    const result = await shell(ctx, `npm view ${name} version`, `npm view ${name} version`)
    if (result.exitCode !== 0) return null
    return versionOf(result.stdout)
  } catch {
    return null
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

    /** Install or update the global pi-web, streaming the npm console to the view. */
    async install(ctx, args) {
      const registry = args?.registry === 'npmmirror' ? ['--registry=https://registry.npmmirror.com'] : []
      const npmCli = findNpmCli()
      if (npmCli === null) throw new Error('找不到 npm（node 目录下没有 npm-cli.js）')
      await runStreaming(ctx, process.execPath, [npmCli, 'install', '-g', `${PACKAGE}@latest`, ...registry])
      const version = await piWebVersion(ctx)
      if (version === null) throw new Error('安装完成但 pi-web 仍不可用')
      return { version }
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

    /** Install one pi plugin (`pi install npm:…`, optional npmmirror registry), console streamed. */
    async installPlugin(ctx, args) {
      const pkg = String(args?.pkg ?? '').trim()
      if (!/^npm:[@a-z0-9/._-]+$/i.test(pkg)) throw new Error('不是有效的 npm: 插件名')
      const env = args?.registry === 'npmmirror'
        ? { npm_config_registry: 'https://registry.npmmirror.com' }
        : undefined
      // Streamed like install/update: a plugin's dependencies can outrun a one-shot shell's budget.
      await runStreaming(ctx, 'pi', ['install', pkg, '--no-approve'], env)
      if (!new Set(piPackages()).has(pkg)) throw new Error('安装命令完成，但未检测到插件')
      return { installed: true }
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
