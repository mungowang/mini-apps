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
| Themes | `@mohou-apps/themes` | all `themes/theme-<id>.css` in one package; outer `mohou.sum` is over those files |
| Catalog | `@mohou-apps/catalog` | `package.json` only; `mohou.apps` is the list (apps and themes) |

Theme edit tree is `themes/theme-<id>.css`. Id is `^[a-z0-9-]+$`. Headers `/* name: */` and optional `/* name-zh-CN: */` feed the catalog row. Version is `themes.version`.

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

| ID | Name | Path |
|---|---|---|
| `com.mohou.kedu` | 刻度清单 | [`apps/com.mohou.kedu`](./apps/com.mohou.kedu) |
| `com.mohou.llm-ocr` | AI 识图 | [`apps/com.mohou.llm-ocr`](./apps/com.mohou.llm-ocr) |
| `luxe-rhythm` | Rhythm / 紫穗 | [`themes/theme-luxe-rhythm.css`](./themes/theme-luxe-rhythm.css) |
| `luxe-saffron` | Saffron Ink / 藏红 | [`themes/theme-luxe-saffron.css`](./themes/theme-luxe-saffron.css) |
| `luxe-sunset` | Sunset Bay / 暮湾 | [`themes/theme-luxe-sunset.css`](./themes/theme-luxe-sunset.css) |
| `nichi-field` | Field Bus / 田野 | [`themes/theme-nichi-field.css`](./themes/theme-nichi-field.css) |
| `nichi-lamp` | Corner Lamp / 晚灯 | [`themes/theme-nichi-lamp.css`](./themes/theme-nichi-lamp.css) |
| `nichi-sakura` | Sakura Lane / 樱巷 | [`themes/theme-nichi-sakura.css`](./themes/theme-nichi-sakura.css) |
| `nichi-sea` | Sea Bench / 海边 | [`themes/theme-nichi-sea.css`](./themes/theme-nichi-sea.css) |

## Add another app

1. Put it at `apps/<appId>/`. The directory name is the manifest `id`. `version` is semver `x.y.z`.
2. Do not commit `storage/`, `logs/`, `theme.json`, `.autogen/`, `node_modules/`, `.ui-build/`, or `.market.lock`.
3. Document the app in both READMEs.
4. Bump that app's `version`, and `catalog.version` when a row changes. `MINI_APP_PUBLISH=1 pnpm publish:market` packs, uploads, and queues the npmmirror sync.
