#!/usr/bin/env node
/**
 * Pack apps and themes for the Mohou market.
 *
 * Edit tree:
 *   apps/<appId>/
 *   themes/theme-<id>.css
 *
 * Install units:
 *   @mohou-apps/<appId>     → package/app/
 *   @mohou-apps/themes      → package/themes/theme-*.css
 *   @mohou-apps/catalog     → package.json only (mohou.apps)
 *
 * Run: node scripts/pack-market.mjs
 *      node scripts/pack-market.mjs --local
 *
 * --local writes market-catalog.json + tarballs into ~/.mini-app/market
 * (or MINI_APP_MARKET_DIR).
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const appsDir = path.join(root, 'apps')
const themesDir = path.join(root, 'themes')
const outDir = path.join(root, 'artifacts', 'market')
const local = process.argv.includes('--local')

const skipNames = new Set([
  'storage',
  'logs',
  'theme.json',
  '.git',
  'node_modules',
  '.autogen',
  '.ui-build',
  '.market.lock',
  '.DS_Store',
])

const catalogVersion = readVersionFile('catalog.version', '1.0.0')
const themesVersion = readVersionFile('themes.version', '1.0.0')

mkdirSync(outDir, { recursive: true })
for (const name of readdirSync(outDir)) {
  rmSync(path.join(outDir, name), { recursive: true, force: true })
}

const rows = []
const tarballPaths = new Set()

const apps = listApps()
for (const app of apps) {
  const packed = packApp(app)
  rows.push(packed.row)
  tarballPaths.add(packed.row.tarballPath)
  console.log(`app ${app.id}@${app.version} sum=${packed.sum.slice(0, 12)}… → ${path.basename(packed.row.tarballPath)}`)
}

const themes = listThemes()
let themesTarball
if (themes.length > 0) {
  const packed = packThemes(themes)
  themesTarball = packed.tarballPath
  tarballPaths.add(packed.tarballPath)
  for (const row of packed.rows) rows.push(row)
  console.log(`themes@${themesVersion} (${themes.length}) sum=${packed.sum.slice(0, 12)}… → ${path.basename(packed.tarballPath)}`)
}

if (rows.length === 0) {
  console.error('no apps under apps/ and no themes under themes/')
  process.exit(1)
}

rows.sort((left, right) => {
  if (left.kind !== right.kind) return left.kind === 'app' ? -1 : 1
  return left.id.localeCompare(right.id)
})

const catalog = packCatalog(rows)
tarballPaths.add(catalog.tarballPath)
console.log(`catalog@${catalogVersion} → ${path.basename(catalog.tarballPath)}`)

if (local) {
  const marketDir = process.env.MINI_APP_MARKET_DIR?.trim()
    || path.join(homedir(), '.mini-app', 'market')
  mkdirSync(marketDir, { recursive: true })
  const localRows = rows.map((row) => {
    const file = row.kind === 'theme' && themesTarball !== undefined
      ? path.basename(themesTarball)
      : path.basename(row.tarballPath)
    const { tarballPath: _t, ...rest } = row
    return { ...rest, source: 'local', file }
  })
  writeFileSync(
    path.join(marketDir, 'market-catalog.json'),
    `${JSON.stringify({ version: catalogVersion, mohou: { apps: localRows } }, null, 2)}\n`,
  )
  for (const file of tarballPaths) {
    cpSync(file, path.join(marketDir, path.basename(file)))
  }
  console.log(`local market → ${marketDir}`)
}

console.log(`packed ${apps.length} app(s), ${themes.length} theme(s) into ${outDir}`)

function listApps() {
  if (!existsSync(appsDir)) return []
  return readdirSync(appsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => readApp(entry.name))
    .sort((left, right) => left.id.localeCompare(right.id))
}

function listThemes() {
  if (!existsSync(themesDir)) return []
  return readdirSync(themesDir)
    .filter(name => /^theme-[a-z0-9-]+\.css$/.test(name))
    .sort()
    .map((name) => {
      const id = name.slice('theme-'.length, -'.css'.length)
      const css = readFileSync(path.join(themesDir, name), 'utf8')
      const names = headerNames(css, id)
      const colors = themeColors(css)
      return {
        id,
        fileName: name,
        css,
        name: names.name,
        description: names.nameZh ?? names.name,
        colors,
      }
    })
}

function readApp(dirName) {
  const dir = path.join(appsDir, dirName)
  const manifestPath = path.join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`${dirName}: manifest.json is missing`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.id !== dirName) {
    throw new Error(`${dirName}: directory name must equal manifest.id (${manifest.id})`)
  }
  for (const key of ['id', 'name', 'description', 'version', 'entry']) {
    if (typeof manifest[key] !== 'string' || manifest[key].length === 0) {
      throw new Error(`${dirName}: manifest.${key} is missing`)
    }
  }
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error(`${dirName}: manifest.version must be x.y.z`)
  }
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    dir,
    tags: Array.isArray(manifest.tags) ? manifest.tags.filter(item => typeof item === 'string') : undefined,
    appKind: manifest.kind === 'workbench' || manifest.appKind === 'workbench' ? 'workbench' : undefined,
  }
}

function packApp(app) {
  const stage = path.join(outDir, `.stage-${app.id}`)
  rmSync(stage, { recursive: true, force: true })
  const appDest = path.join(stage, 'package', 'app')
  mkdirSync(appDest, { recursive: true })
  copyAppTree(app.dir, appDest)
  const sum = treeSum(appDest)
  const packageName = `@mohou-apps/${app.id}`
  writeFileSync(path.join(stage, 'package', 'package.json'), `${JSON.stringify({
    name: packageName,
    version: app.version,
    private: false,
    description: app.description,
    license: 'MIT',
    mohou: { id: app.id, sum },
  }, null, 2)}\n`)
  const tarballPath = path.join(outDir, tarballFileName(packageName, app.version))
  execFileSync('tar', ['-czf', tarballPath, '-C', stage, 'package'], { stdio: 'pipe' })
  rmSync(stage, { recursive: true, force: true })
  return {
    sum,
    row: {
      id: app.id,
      name: app.name,
      description: app.description,
      package: packageName,
      version: app.version,
      kind: 'app',
      source: 'npm',
      official: true,
      author: 'Mohou',
      ...app.appKind === undefined ? {} : { appKind: app.appKind },
      ...app.tags === undefined || app.tags.length === 0 ? {} : { tags: app.tags },
      tarballPath,
    },
  }
}

function packThemes(themes) {
  const stage = path.join(outDir, '.stage-themes')
  rmSync(stage, { recursive: true, force: true })
  const dest = path.join(stage, 'package', 'themes')
  mkdirSync(dest, { recursive: true })
  for (const theme of themes) {
    writeFileSync(path.join(dest, theme.fileName), theme.css)
  }
  const sum = themesPackageSum(dest)
  const packageName = '@mohou-apps/themes'
  writeFileSync(path.join(stage, 'package', 'package.json'), `${JSON.stringify({
    name: packageName,
    version: themesVersion,
    private: false,
    description: 'Mohou market themes',
    license: 'MIT',
    mohou: { sum },
  }, null, 2)}\n`)
  const tarballPath = path.join(outDir, tarballFileName(packageName, themesVersion))
  execFileSync('tar', ['-czf', tarballPath, '-C', stage, 'package'], { stdio: 'pipe' })
  rmSync(stage, { recursive: true, force: true })
  const rows = themes.map(theme => ({
    id: theme.id,
    name: theme.name,
    description: theme.description,
    package: packageName,
    version: themesVersion,
    kind: 'theme',
    source: 'npm',
    official: true,
    author: 'Mohou',
    ...theme.colors.length === 0 ? {} : { colors: theme.colors },
    tarballPath,
  }))
  return { sum, tarballPath, rows }
}

function packCatalog(rows) {
  const stage = path.join(outDir, '.stage-catalog')
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(path.join(stage, 'package'), { recursive: true })
  const apps = rows.map(({ tarballPath: _t, source: _s, ...row }) => row)
  writeFileSync(path.join(stage, 'package', 'package.json'), `${JSON.stringify({
    name: '@mohou-apps/catalog',
    version: catalogVersion,
    private: false,
    description: 'Mohou market catalog',
    license: 'MIT',
    mohou: { apps },
  }, null, 2)}\n`)
  writeFileSync(path.join(outDir, 'catalog.json'), `${JSON.stringify({
    version: catalogVersion,
    mohou: { apps },
  }, null, 2)}\n`)
  const tarballPath = path.join(outDir, tarballFileName('@mohou-apps/catalog', catalogVersion))
  execFileSync('tar', ['-czf', tarballPath, '-C', stage, 'package'], { stdio: 'pipe' })
  rmSync(stage, { recursive: true, force: true })
  return { tarballPath }
}

function copyAppTree(from, to) {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (skipNames.has(entry.name)) continue
    const src = path.join(from, entry.name)
    const dest = path.join(to, entry.name)
    if (entry.isDirectory()) {
      mkdirSync(dest, { recursive: true })
      copyAppTree(src, dest)
      continue
    }
    if (entry.isFile()) cpSync(src, dest)
  }
}

function treeSum(rootDir) {
  const hash = createHash('sha256')
  for (const file of walk(rootDir, '')) {
    hash.update(file.rel)
    hash.update('\0')
    hash.update(readFileSync(file.abs))
    hash.update('\0')
  }
  return hash.digest('hex')
}

/** Same rule as host themesPackageSum: name + bytes, sorted. */
function themesPackageSum(dir) {
  const hash = createHash('sha256')
  for (const name of readdirSync(dir).filter(file => /^theme-[a-z0-9-]+\.css$/.test(file)).sort()) {
    hash.update(name)
    hash.update(readFileSync(path.join(dir, name)))
  }
  return hash.digest('hex')
}

function walk(rootDir, rel) {
  const abs = rel.length === 0 ? rootDir : path.join(rootDir, rel)
  const entries = readdirSync(abs, { withFileTypes: true })
    .filter(entry => !skipNames.has(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
  const files = []
  for (const entry of entries) {
    const next = rel.length === 0 ? entry.name : `${rel}/${entry.name}`
    const full = path.join(rootDir, next)
    if (entry.isDirectory()) files.push(...walk(rootDir, next))
    else if (statSync(full).isFile()) files.push({ rel: next, abs: full })
  }
  return files
}

function themeColors(css) {
  const light = modeBlock(css, 'light')
  const dark = modeBlock(css, 'dark')
  return [token(light, 'primary'), token(light, 'background'), token(dark, 'primary'), token(dark, 'background')]
    .filter(item => item !== undefined)
}

function modeBlock(css, mode) {
  const match = new RegExp(`data-mode="${mode}"[^{]*\\{([^}]*)\\}`).exec(css)
  return match?.[1] ?? ''
}

function token(block, name) {
  const match = new RegExp(`--${name}\\s*:\\s*([^;]+)`).exec(block)
  return match?.[1]?.trim()
}

function headerNames(css, fallback) {
  const name = headerField(css, 'name')
  const nameZh = headerField(css, 'name-zh-CN')
  if (name !== undefined && nameZh !== undefined) return { name, nameZh }
  if (name !== undefined) return { name }
  if (nameZh !== undefined) return { name: nameZh, nameZh }
  return { name: fallback }
}

function headerField(css, field) {
  const match = new RegExp(`/\\*\\s*${field}:\\s*([^*]+?)\\s*\\*/`).exec(css)
  const value = match?.[1]?.trim()
  return value === undefined || value.length === 0 ? undefined : value
}

function tarballFileName(name, version) {
  return `${name.replace('@', '').replace('/', '-')}-${version}.tgz`
}

function readVersionFile(rel, fallback) {
  const file = path.join(root, rel)
  if (!existsSync(file)) return fallback
  const text = readFileSync(file, 'utf8').trim()
  if (!/^\d+\.\d+\.\d+$/.test(text)) throw new Error(`${rel} must be x.y.z`)
  return text
}
