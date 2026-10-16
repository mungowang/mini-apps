#!/usr/bin/env node
/**
 * Pack apps and themes for the Mohou market.
 *
 * Edit tree:
 *   apps/<appId>/
 *   themes/theme-<id>.css                    ungrouped theme
 *   themes/<packId>/theme.manifest.json      a bundle (灵感 / Inspiration)
 *   themes/<packId>/theme-<id>.css           a theme inside that bundle
 *
 * Install units:
 *   @mohou-apps/<appId>     → package/app/
 *   @mohou-apps/themes      → package/themes/theme-*.css, always flat
 *   @mohou-apps/catalog     → package.json only (mohou.apps, mohou.themePacks)
 *
 * A bundle is a catalog heading, never an install unit. The pack folder exists only in
 * this edit tree: the themes tarball stays a flat `theme-*.css` set, because install
 * finds theme files by scanning one flat directory. `theme.manifest.json` is build input
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

/**
 * Names the packed tree never carries. The first group is product state and build
 * output. The second is the set npm itself never publishes: `npm publish` drops
 * these names, and install recomputes `mohou.sum` over what it received, so a name
 * npm would drop can never verify.
 */
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
  '.gitignore',
  '.npmignore',
  '.npmrc',
])

/** One theme file name, and the id inside it. Install scans a flat directory for these. */
const THEME_FILE = /^theme-[a-z0-9-]+\.css$/
const PACK_ID = /^[a-z0-9-]+$/

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

const { themes, packs: themePacks } = listThemes()
let themesTarball
if (themes.length > 0) {
  const packed = packThemes(themes)
  themesTarball = packed.tarballPath
  tarballPaths.add(packed.tarballPath)
  for (const row of packed.rows) rows.push(row)
  console.log(`themes@${themesVersion} (${themes.length}, ${themePacks.length} bundle(s)) sum=${packed.sum.slice(0, 12)}… → ${path.basename(packed.tarballPath)}`)
}
if (themePacks.length > 0 && themes.length === 0) {
  console.error('theme bundles declared with no theme to carry them')
  process.exit(1)
}

if (rows.length === 0) {
  console.error('no apps under apps/ and no themes under themes/')
  process.exit(1)
}

rows.sort((left, right) => {
  if (left.kind !== right.kind) return left.kind === 'app' ? -1 : 1
  return left.id.localeCompare(right.id)
})

const catalog = packCatalog(rows, themePacks)
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
    `${JSON.stringify({ version: catalogVersion, mohou: catalogBody(localRows, themePacks) }, null, 2)}\n`,
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

/**
 * Read the theme edit tree: flat files are ungrouped, one subfolder is one bundle.
 * The scan is exactly one level deep, and a folder without a manifest is not a bundle.
 */
function listThemes() {
  if (!existsSync(themesDir)) return { themes: [], packs: [] }
  const themes = []
  const packs = []
  const entries = readdirSync(themesDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory() || entry.name.startsWith('.')) continue
    if (!THEME_FILE.test(entry.name)) continue
    themes.push(readTheme(path.join(themesDir, entry.name), entry.name))
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = path.join(themesDir, entry.name)
    const pack = readThemePack(dir, entry.name)
    const inside = readdirSync(dir).filter(name => THEME_FILE.test(name)).sort()
    if (inside.length === 0) throw new Error(`themes/${entry.name}: a bundle folder needs at least one theme-<id>.css`)
    packs.push(pack)
    for (const name of inside) themes.push(readTheme(path.join(dir, name), name, pack.id))
  }
  themes.sort((left, right) => left.id.localeCompare(right.id))
  packs.sort((left, right) => left.id.localeCompare(right.id))
  // Install is one flat file and one lock per id, so a name reused across bundles cannot hold both.
  const seen = new Set()
  for (const theme of themes) {
    if (seen.has(theme.id)) throw new Error(`theme id is duplicated: ${theme.id}`)
    seen.add(theme.id)
  }
  return { themes, packs }
}

function readTheme(file, name, packId) {
  const id = name.slice('theme-'.length, -'.css'.length)
  const css = readFileSync(file, 'utf8')
  const meta = themeMeta(css, id)
  return {
    id,
    fileName: name,
    css,
    name: meta.name,
    description: meta.description,
    ...meta.nameZh === undefined ? {} : { nameZh: meta.nameZh },
    ...meta.descriptionZh === undefined ? {} : { descriptionZh: meta.descriptionZh },
    colors: themeColors(css),
    ...packId === undefined ? {} : { packId },
  }
}

/** `theme.manifest.json`. Build input only: it is never copied into a package. */
function readThemePack(dir, folder) {
  const file = path.join(dir, 'theme.manifest.json')
  if (!existsSync(file)) throw new Error(`themes/${folder}: theme.manifest.json is missing, so this is not a bundle folder`)
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  const id = manifestText(raw.id, `themes/${folder}: id`)
  if (!PACK_ID.test(id)) throw new Error(`themes/${folder}: id must match ${PACK_ID}`)
  if (id !== folder) throw new Error(`themes/${folder}: id must equal the folder name (got ${id})`)
  return {
    id,
    name: manifestText(raw.name, `themes/${folder}: name`),
    ...manifestOptional(raw, 'nameZh', folder) === undefined ? {} : { nameZh: manifestOptional(raw, 'nameZh', folder) },
    ...manifestOptional(raw, 'description', folder) === undefined ? {} : { description: manifestOptional(raw, 'description', folder) },
    ...manifestOptional(raw, 'descriptionZh', folder) === undefined ? {} : { descriptionZh: manifestOptional(raw, 'descriptionZh', folder) },
    ...manifestOptional(raw, 'author', folder) === undefined ? {} : { author: manifestOptional(raw, 'author', folder) },
    ...raw.official === true ? { official: true } : {},
  }
}

function manifestText(value, where) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${where} is missing`)
  return value
}

function manifestOptional(raw, key, folder) {
  const value = raw[key]
  if (value === undefined) return undefined
  return manifestText(value, `themes/${folder}: ${key}`)
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
  assertNpmShipsEveryFile(path.join(stage, 'package'), appDest)
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
    ...theme.nameZh === undefined ? {} : { nameZh: theme.nameZh },
    ...theme.descriptionZh === undefined ? {} : { descriptionZh: theme.descriptionZh },
    ...theme.colors.length === 0 ? {} : { colors: theme.colors },
    ...theme.packId === undefined ? {} : { themePackId: theme.packId },
    tarballPath,
  }))
  return { sum, tarballPath, rows }
}

function packCatalog(rows, packs) {
  const stage = path.join(outDir, '.stage-catalog')
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(path.join(stage, 'package'), { recursive: true })
  const apps = rows.map(({ tarballPath: _t, source: _s, ...row }) => row)
  assertPackRefs(apps, packs)
  writeFileSync(path.join(stage, 'package', 'package.json'), `${JSON.stringify({
    name: '@mohou-apps/catalog',
    version: catalogVersion,
    private: false,
    description: 'Mohou market catalog',
    license: 'MIT',
    mohou: catalogBody(apps, packs),
  }, null, 2)}\n`)
  writeFileSync(path.join(outDir, 'catalog.json'), `${JSON.stringify({
    version: catalogVersion,
    mohou: catalogBody(apps, packs),
  }, null, 2)}\n`)
  const tarballPath = path.join(outDir, tarballFileName('@mohou-apps/catalog', catalogVersion))
  execFileSync('tar', ['-czf', tarballPath, '-C', stage, 'package'], { stdio: 'pipe' })
  rmSync(stage, { recursive: true, force: true })
  return { tarballPath }
}

/**
 * One bundle is one heading, so an empty one is left out: Host drops a bundle with no
 * visible row too, and a row that names nothing is a catalog error there.
 */
function catalogBody(apps, packs) {
  const named = packs.filter(pack => apps.some(row => row.themePackId === pack.id))
  return named.length === 0 ? { apps } : { apps, themePacks: named }
}

function assertPackRefs(apps, packs) {
  const known = new Set(packs.map(pack => pack.id))
  for (const row of apps) {
    if (row.themePackId !== undefined && !known.has(row.themePackId)) {
      throw new Error(`${row.id}: themePackId names no bundle (${row.themePackId})`)
    }
  }
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

/**
 * Fail the pack when npm would drop a staged file. Install recomputes `mohou.sum`
 * over what it received, so one dropped file turns the package into a sum mismatch.
 */
function assertNpmShipsEveryFile(packageDir, appDest) {
  const listed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: packageDir,
    encoding: 'utf8',
  }))
  const shipped = new Set(listed[0].files.map(file => file.path))
  for (const file of walk(appDest, '')) {
    const rel = `app/${file.rel}`
    if (!shipped.has(rel)) throw new Error(`npm would not ship ${rel}. Add its name to skipNames`)
  }
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

/** Theme CSS formal headers: name, name-zh-CN, description, description-zh-CN. Catalog needs name + description. */
function themeMeta(css, fallback) {
  const name = headerField(css, 'name')
  const nameZh = headerField(css, 'name-zh-CN')
  const description = headerField(css, 'description')
  const descriptionZh = headerField(css, 'description-zh-CN')
  const resolvedName = name ?? nameZh ?? fallback
  const resolvedDescription = description ?? descriptionZh ?? nameZh ?? resolvedName
  return {
    name: resolvedName,
    description: resolvedDescription,
    ...nameZh === undefined ? {} : { nameZh },
    ...descriptionZh === undefined ? {} : { descriptionZh },
  }
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
