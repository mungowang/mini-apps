# mini-apps

[English](README.md) | [中文](README.zh.md)

A public collection of shareable mini-apps. UI imports `@mohou/ui`. The backend imports `@mohou/contract`. The local host injects both.

Each folder under `apps/<appId>/` is one self-contained app (`manifest.json` + `ui.tsx` + `main.api.ts`, plus optional `ui/` / `api/` / `shared/`). Drop it into the local runtime and it shows up in the mini-app panel.

## Install one app

**刻度清单** (`com.mungo.kedu`) — finish today first. One list, three lenses: today (including overdue), later, and the unscheduled inbox. Quick parse, subtasks, tags, images, and a rhythm sheet stay. The board and the stats page are no longer peers of today.

```bash
mkdir -p ~/.mini-app/runtime/apps
rm -rf ~/.mini-app/runtime/apps/com.mungo.kedu
cp -R apps/com.mungo.kedu ~/.mini-app/runtime/apps/
```

From the published repo:

```bash
npx --yes degit MungoWang/mini-apps/apps/com.mungo.kedu ~/.mini-app/runtime/apps/com.mungo.kedu
```

Open the mini-app panel. You should see **刻度清单**. If the gallery does not refresh, reload that app.

> `storage/` is gitignored. Each machine keeps its own data.

## Catalog

| App ID | Name | Path |
|---|---|---|
| `com.mungo.kedu` | 刻度清单 | [`apps/com.mungo.kedu`](./apps/com.mungo.kedu) |

## Add another app

1. Put sources under `apps/<reverse-dns-id>/` with a valid `manifest.json`.
2. Do not commit `storage/`, `.autogen/`, or `node_modules/`.
3. Document the install line in both READMEs.
