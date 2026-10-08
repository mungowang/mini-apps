# mini-apps

[English](README.md) | [中文](README.zh.md)

Shareable apps for [Mohou](https://github.com/mungowang/mohou-mini-app).

One app is a directory named with its id. It contains `manifest.json`, `ui.tsx`, and `main.api.ts`. Add `ui/`, `api/`, `shared/`, `schema/`, or `assets/` when the app needs them. The view imports `@mohou/ui`. The backend imports `defineApp` from `@mohou/contract`. Mohou provides both.

## Default directory

Mohou reads apps from `<runtime>/apps/<appId>/`.

The default runtime root is `~/.mini-app/runtime`. On Windows it is `%USERPROFILE%\.mini-app\runtime`. When `MINI_APP_RUNTIME` is set, that path is the root. The library lists the directories inside that `apps/` folder.

## Install one app

**刻度清单** (`com.mohou.kedu`) — finish today first. One list, three lenses: today (including overdue), later, and the unscheduled inbox.

```bash
root="${MINI_APP_RUNTIME:-$HOME/.mini-app/runtime}"
npx --yes degit MungoWang/mini-apps/apps/com.mohou.kedu "$root/apps/com.mohou.kedu"
```

That writes a new folder. When the folder is already there, copy the sources from a checkout and leave `storage/` in place:

```bash
root="${MINI_APP_RUNTIME:-$HOME/.mini-app/runtime}"
mkdir -p "$root/apps/com.mohou.kedu"
rsync -a --exclude storage --exclude .git --exclude node_modules --exclude .autogen --exclude .ui-build \
  apps/com.mohou.kedu/ "$root/apps/com.mohou.kedu/"
```

Open Mohou and refresh the library. **刻度清单** is listed there. An app that is already open needs a reload before the new source runs.

`storage/` stays on this machine. The `.git` history Mohou keeps in the app directory stays there too.

## Catalog

| App ID | Name | Path |
|---|---|---|
| `com.mohou.kedu` | 刻度清单 | [`apps/com.mohou.kedu`](./apps/com.mohou.kedu) |

## Add another app

1. Put it at `apps/<appId>/`. The directory name is the manifest `id`.
2. Do not commit `storage/`, `.autogen/`, `node_modules/`, or `.ui-build/`.
3. Document the install line in both READMEs.
