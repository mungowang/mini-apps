# mini-apps

[English](README.md) | [中文](README.zh.md)

Shareable apps for [Mohou](https://github.com/mungowang/mohou-mini-app).

One app is a directory named with its id under `apps/<appId>/`. It contains `manifest.json`, `ui.tsx`, and `main.api.ts`. Add `ui/`, `api/`, `shared/`, `schema/`, or `assets/` when the app needs them. The view imports `@mohou/ui`. The backend imports `defineApp` from `@mohou/contract`. Mohou provides both.

This repo is the **edit tree**. The market does not clone it. Install goes through npm packages under `@mohou-apps`.

## Default directory

Mohou reads apps from `<runtime>/apps/<appId>/`.

The default runtime root is `~/.mini-app/runtime`. On Windows it is `%USERPROFILE%\.mini-app\runtime`. When `MINI_APP_RUNTIME` is set, that path is the root.

## Market publish layout

| Piece | Package | Contents |
|---|---|---|
| One app | `@mohou-apps/<appId>` | `package/app/` = copy of `apps/<appId>/`; outer `package.json` has `mohou.id` and `mohou.sum` |
| Themes | `@mohou-apps/themes` | every `theme-<id>.css` in the tree, flat in `package/themes/` whatever the folder it was edited in; outer `mohou.sum` is over those files |
| Catalog | `@mohou-apps/catalog` | `package.json` only; `mohou.apps` is the list (apps and themes) and `mohou.themePacks` the bundles |

Theme edit tree is `themes/theme-<id>.css` for a theme on its own, and `themes/<bundleId>/theme-<id>.css` for one inside a bundle (灵感 / Inspiration pack). This repo currently ships **16 packs · 100 themes** under `themes/<bundleId>/` only (no ungrouped flat files). Id is `^[a-z0-9-]+$` and must stay unique across the whole tree: a machine installs one flat `theme-<id>.css` with one lock, so an id reused between two packs cannot keep both. Formal headers feed the catalog row:

```css
/* name: Charcoal & Amber */
/* name-zh-CN: 炭灰橙 */
/* description: Plain Washi · Charcoal & Amber */
/* description-zh-CN: 商务稳重 · 炭灰與橘色 */
```

`name` and `description` are required for the catalog (English). `name-zh-CN` and `description-zh-CN` are optional and surface under zh-CN. No other comment is machine-read. Version is `themes.version`.

A bundle folder holds `theme.manifest.json`: `{ id, name, nameZh?, description?, descriptionZh?, author?, official? }`. `id` must equal the folder name, and the folder needs at least one theme. **The manifest is build input.** The themes package stays one flat set of `theme-*.css` — no subfolder and no manifest reach a machine — and the bundle itself is not installable: `pack-market` writes it to `mohou.themePacks` and stamps `themePackId` on each of its rows, so moving a theme between bundles is a catalog rebuild, not a theme republish.

The sum is sha256 over the tree that will be installed (`package/app/`), paths sorted. It excludes `storage/`, `logs/`, `theme.json`, `.git`, `node_modules`, `.autogen`, `.ui-build/`, `.market.lock`, and the names npm never publishes: `.gitignore`, `.npmignore`, `.npmrc`, `.DS_Store`.

### Pack tarballs

```bash
pnpm pack:market
# → artifacts/market/*.tgz and catalog.json
```

Local Mohou dist (tarball channel) can install without npm:

```bash
pnpm pack:market:local
# → also writes ~/.mini-app/market/market-catalog.json and the app tarballs
```

Override the market dir with `MINI_APP_MARKET_DIR`. Catalog version is `catalog.version` at the repo root.

Upload the packed packages. The tree must be clean. Apps and themes go up first, then the catalog. Each package is then queued on npmmirror. `MINI_APP_MIRROR_SYNC=0`, `MINI_APP_MIRROR_SYNC=false`, or `--no-mirror-sync` skips that queue. The flag wins over the variable. A version already on npm is left in place and still queued.

```bash
MINI_APP_PUBLISH=1 pnpm publish:market
```

### Catalog row

Derived from `manifest.json`: `id`, `name`, `description`, `version`, optional `tags`. Package name is always `@mohou-apps/<id>`. Omitted `kind` means `app`. Set `appKind: "workbench"` (or `kind: "workbench"` in the manifest) for a workbench.

## Install without the market

Manual copy still works while authoring:

```bash
root="${MINI_APP_RUNTIME:-$HOME/.mini-app/runtime}"
mkdir -p "$root/apps/com.mohou.kedu"
rsync -a --exclude storage --exclude .git --exclude node_modules --exclude .autogen --exclude .ui-build \
  apps/com.mohou.kedu/ "$root/apps/com.mohou.kedu/"
```

`storage/` stays on this machine.

## Catalog

Versions below match the edit tree (`catalog.version` **1.3.13**, `themes.version` **1.1.1**). The packed catalog lists every theme row individually; here packs are summarized so the table stays readable.

### Apps

| ID | Name | Version | Path |
|---|---|---|---|
| `com.mohou.kedu` | 刻度清单 | 0.6.0 | [`apps/com.mohou.kedu`](./apps/com.mohou.kedu) |
| `com.mohou.data-cask` | 数据手账 | 0.3.56 | [`apps/com.mohou.data-cask`](./apps/com.mohou.data-cask) |
| `com.mohou.pi-web` | Pi Web (`website`) | 0.4.6 | [`apps/com.mohou.pi-web`](./apps/com.mohou.pi-web) |
| `com.mohou.llm-ocr` | AI 识图 | 0.1.2 | [`apps/com.mohou.llm-ocr`](./apps/com.mohou.llm-ocr) |

- **刻度清单** — task capture, boards, archive, and **connectors** (import external tasks via MCP/HTTP without code changes).
- **数据手账** — local tables and rows; create, browse, import CSV/Excel.
- **Pi Web** — detect/install/host the local pi-web service (intl + CN mirrors); plugin updates and one-click recommended installs (~500 MB npm package on first install).
- **AI 识图** — paste a screenshot, box a region, OCR via LLM into copyable text.

### Theme packs (灵感合集)

16 official packs · **100** themes. Each pack is `themes/<id>/` with `theme.manifest.json` + `theme-*.css`.

| Pack ID | Name | Themes | Path |
|---|---|---:|---|
| `blossom-pop` | Blossom Pop / 花期 | 5 | [`themes/blossom-pop`](./themes/blossom-pop) |
| `cellar-wine` | Cellar Wine / 酒窖 | 6 | [`themes/cellar-wine`](./themes/cellar-wine) |
| `citrus-parade` | Citrus Parade / 柑橘游行 | 6 | [`themes/citrus-parade`](./themes/citrus-parade) |
| `clay-bazaar` | Clay Bazaar / 陶土市集 | 7 | [`themes/clay-bazaar`](./themes/clay-bazaar) |
| `emerald-hall` | Emerald Hall / 翡翠厅 | 5 | [`themes/emerald-hall`](./themes/emerald-hall) |
| `lilac-quiet` | Lilac Quiet / 丁香静默 | 7 | [`themes/lilac-quiet`](./themes/lilac-quiet) |
| `linen-hour` | Linen Hour / 亚麻时辰 | 7 | [`themes/linen-hour`](./themes/linen-hour) |
| `midnight-vigil` | Midnight Vigil / 夜祷 | 6 | [`themes/midnight-vigil`](./themes/midnight-vigil) |
| `moss-and-rust` | Moss & Rust / 苔与锈 | 6 | [`themes/moss-and-rust`](./themes/moss-and-rust) |
| `noir-couture` | Noir Couture / 夜装 | 4 | [`themes/noir-couture`](./themes/noir-couture) |
| `peony-hour` | Peony Hour / 玫瑰灰 | 6 | [`themes/peony-hour`](./themes/peony-hour) |
| `reef-candy` | Reef Candy / 珊瑚糖 | 6 | [`themes/reef-candy`](./themes/reef-candy) |
| `sage-choir` | Sage Choir / 鼠尾草 | 6 | [`themes/sage-choir`](./themes/sage-choir) |
| `sea-glass` | Sea Glass / 海玻璃 | 7 | [`themes/sea-glass`](./themes/sea-glass) |
| `tide-depth` | Tide Depth / 深潮 | 8 | [`themes/tide-depth`](./themes/tide-depth) |
| `washi-plain` | Plain Washi / 素纸 | 8 | [`themes/washi-plain`](./themes/washi-plain) |

Older single-file ids (`nichi-*`, `luxe-*`) still exist as themes inside these packs (for example `nichi-moss-rust` lives under `moss-and-rust/`). There is no longer an `autumn` / `dusk` / `shore` folder layout.

## Add another app

1. Put it at `apps/<appId>/`. The directory name is the manifest `id`. `version` is semver `x.y.z`.
2. Do not commit `storage/`, `logs/`, `theme.json`, `.autogen/`, `node_modules/`, `.ui-build/`, or `.market.lock`.
3. Document the app in both READMEs.
4. Bump that app's `version`, and `catalog.version` when a row changes. `MINI_APP_PUBLISH=1 pnpm publish:market` packs, uploads, and queues the npmmirror sync.

## Add another theme or bundle

1. A theme on its own: drop `theme-<id>.css` in `themes/`. It lists under 未分类 / Ungrouped.
2. A bundle: make `themes/<bundleId>/`, put `theme.manifest.json` in it, and drop its `theme-<id>.css` files beside the manifest. The pack refuses a folder without a manifest, a manifest `id` that is not the folder name, and an empty bundle.
3. Keep the theme id unique across the whole tree. The pack stops on a reuse, and so does a machine reading the catalog.
4. Move a theme between bundles by moving the file. Only `catalog.version` bumps — the themes package and its sum do not change.
