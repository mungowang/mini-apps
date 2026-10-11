#!/usr/bin/env node
/**
 * Pack the market tarballs and upload them.
 *
 * Inputs: apps/, themes/, catalog.version, themes.version
 * Writes: artifacts/market/*.tgz, then the npm registry
 * Side effects: upload only when MINI_APP_PUBLISH=1.
 *   After the upload, each package is queued on npmmirror unless
 *   --no-mirror-sync is set or MINI_APP_MIRROR_SYNC is 0 or false.
 * Run as: pnpm pack:market
 *         MINI_APP_PUBLISH=1 pnpm publish:market
 *         MINI_APP_MIRROR_SYNC=0 pnpm publish:market
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** npmmirror is the Settings mirror that accepts a sync. Tencent's mirror has no such route. */
export const npmmirrorSyncRegistry = 'https://registry.npmmirror.com'

/** On unless `--no-mirror-sync` is present or `MINI_APP_MIRROR_SYNC` is `0` or `false`. The flag wins. */
export function mirrorSyncEnabled(argv, env) {
  if (argv.includes('--no-mirror-sync')) return false
  const raw = env.MINI_APP_MIRROR_SYNC?.trim() ?? ''
  return raw !== '0' && raw !== 'false'
}

export function mirrorSyncUrl(name, registry = npmmirrorSyncRegistry) {
  return `${registry}/-/package/${encodeURIComponent(name)}/syncs`
}

/**
 * Queue one sync per package. A 2xx body is the mirror's log line.
 * A transport error or a non-2xx response is one failure string. The caller decides the exit.
 */
export async function syncMirrors(names, fetchImpl = globalThis.fetch) {
  const failures = []
  for (const name of names) {
    const url = mirrorSyncUrl(name)
    let response
    try {
      response = await fetchImpl(url, { method: 'PUT' })
    } catch (error) {
      failures.push(`${name} ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const body = await response.text()
    if (!response.ok) {
      failures.push(`${name} ${response.status} ${body}`)
      continue
    }
    console.log(`mirror sync ${name} ${body}`)
  }
  return failures
}

/** Apps and themes first. The catalog names them, so it is last. */
export function publishOrder(catalog) {
  const versions = new Map()
  for (const row of catalog.mohou?.apps ?? []) {
    if (typeof row.package === 'string' && typeof row.version === 'string') versions.set(row.package, row.version)
  }
  if (typeof catalog.version === 'string') versions.set('@mohou-apps/catalog', catalog.version)
  return [...versions.entries()].sort(([left], [right]) => {
    if (left === '@mohou-apps/catalog') return 1
    if (right === '@mohou-apps/catalog') return -1
    return left.localeCompare(right)
  })
}

export function tarballPath(outDir, name, version) {
  return path.join(outDir, `${name.replace('@', '').replace('/', '-')}-${version}.tgz`)
}

function alreadyPublished(name, version) {
  try {
    const seen = execFileSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8' }).trim()
    return seen === version
  } catch {
    return false
  }
}

async function publishMarket() {
  if (process.env.MINI_APP_PUBLISH !== '1') {
    console.error('Refusing to upload. Set MINI_APP_PUBLISH=1 when you mean to publish.')
    process.exit(1)
  }
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
  if (dirty !== '') {
    console.error('Refusing to upload from a dirty tree.')
    process.exit(1)
  }
  execFileSync(process.execPath, [path.join(root, 'scripts', 'pack-market.mjs')], { cwd: root, stdio: 'inherit' })
  const outDir = path.join(root, 'artifacts', 'market')
  const catalog = JSON.parse(readFileSync(path.join(outDir, 'catalog.json'), 'utf8'))
  const access = process.env.MINI_APP_NPM_ACCESS === 'restricted' ? 'restricted' : 'public'
  const names = []
  for (const [name, version] of publishOrder(catalog)) {
    names.push(name)
    if (alreadyPublished(name, version)) {
      console.log(`${name}@${version} is already on npm`)
      continue
    }
    const file = tarballPath(outDir, name, version)
    console.log(`publish ${name}@${version}`)
    execFileSync('npm', ['publish', file, '--access', access], { cwd: root, stdio: 'inherit' })
  }
  if (!mirrorSyncEnabled(process.argv, process.env)) return
  const failures = await syncMirrors(names)
  if (failures.length > 0) {
    console.error(`npm upload finished. npmmirror sync failed:\n${failures.join('\n')}`)
    process.exit(1)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await publishMarket()
}
