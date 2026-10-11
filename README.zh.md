# mini-apps

[English](README.md) | 中文

给 [墨猴 Mohou](https://github.com/mungowang/mohou-mini-app) 用的可分享小程序。

一个 app 是 `apps/<appId>/` 下以 id 命名的目录，里面有 `manifest.json`、`ui.tsx`、`main.api.ts`。需要时再加 `ui/`、`api/`、`shared/`、`schema/`、`assets/`。界面从 `@mohou/ui` 引入，后端从 `@mohou/contract` 引入 `defineApp`。这两份由墨猴提供。

这个仓库是**编辑树**。市场不克隆它。安装走 `@mohou-apps` 下的 npm 包。

## 默认目录

墨猴从 `<runtime>/apps/<appId>/` 读取 app。

默认的 runtime 根目录是 `~/.mini-app/runtime`。Windows 上是 `%USERPROFILE%\.mini-app\runtime`。设置了 `MINI_APP_RUNTIME` 时，用那个路径当根。

## 市场发布布局

| 单元 | 包名 | 内容 |
|---|---|---|
| 一个 app | `@mohou-apps/<appId>` | `package/app/` = `apps/<appId>/` 的拷贝；外层 `package.json` 带 `mohou.id` 和 `mohou.sum` |
| 主题 | `@mohou-apps/themes` | 全部 `themes/theme-<id>.css` 打成一个包；外层 `mohou.sum` 覆盖这些文件 |
| 目录 | `@mohou-apps/catalog` | 只有 `package.json`；`mohou.apps` 是列表（app + theme） |

主题编辑树是 `themes/theme-<id>.css`。id 符合 `^[a-z0-9-]+$`。文件头 `/* name: */` 和可选的 `/* name-zh-CN: */` 写入目录行。版本在 `themes.version`。

校验和是待安装树（`package/app/`）的 sha256，路径排序。排除 `storage/`、`logs/`、`theme.json`、`.git`、`node_modules`、`.autogen`、`.ui-build/`、`.market.lock`，以及 npm 永不发布的 `.gitignore`、`.npmignore`、`.npmrc`、`.DS_Store`。

### 打 tarball

```bash
pnpm pack:market
# → artifacts/market/*.tgz 和 catalog.json
```

本机 dist（tarball channel）可以不走 npm：

```bash
pnpm pack:market:local
# → 同时写入 ~/.mini-app/market/market-catalog.json 和应用 tarball
```

市场目录可用 `MINI_APP_MARKET_DIR` 覆盖。目录包版本在仓库根的 `catalog.version`。

上传打好的包。工作区必须是干净的。先上传 app 和主题，再上传目录。每个包接着在 npmmirror 排队同步。`MINI_APP_MIRROR_SYNC=0`、`MINI_APP_MIRROR_SYNC=false` 或 `--no-mirror-sync` 跳过排队。命令行开关优先于环境变量。npm 上已有的版本不重复上传，但仍会排队。

```bash
MINI_APP_PUBLISH=1 pnpm publish:market
```

### 目录行

从 `manifest.json` 生成：`id`、`name`、`description`、`version`，以及可选的 `tags`。包名固定为 `@mohou-apps/<id>`。省略 `kind` 表示 `app`。工作台写 `appKind: "workbench"`（或 manifest 里 `kind: "workbench"`）。

## 不经市场安装

编辑时仍可手工拷贝：

```bash
root="${MINI_APP_RUNTIME:-$HOME/.mini-app/runtime}"
mkdir -p "$root/apps/com.mohou.kedu"
rsync -a --exclude storage --exclude .git --exclude node_modules --exclude .autogen --exclude .ui-build \
  apps/com.mohou.kedu/ "$root/apps/com.mohou.kedu/"
```

`storage/` 留在本机。

## 目录

| ID | 名称 | 路径 |
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

## 再加一个 app

1. 放到 `apps/<appId>/`。目录名就是 manifest 里的 `id`。`version` 用 semver `x.y.z`。
2. 不要提交 `storage/`、`logs/`、`theme.json`、`.autogen/`、`node_modules/`、`.ui-build/`、`.market.lock`。
3. 在中英文 README 里补上这一行。
4. 改这个 app 的 `version`。目录行变了就 bump `catalog.version`。`MINI_APP_PUBLISH=1 pnpm publish:market` 会打包、上传，并在 npmmirror 排队同步。
