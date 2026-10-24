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
| 主题 | `@mohou-apps/themes` | 整棵树的 `theme-<id>.css` 打成一个包，无论原来自哪个目录，包里都是扁平的；外层 `mohou.sum` 覆盖这些文件 |
| 目录 | `@mohou-apps/catalog` | 只有 `package.json`；`mohou.apps` 是列表（app + theme），`mohou.themePacks` 是合集 |

主题编辑树：独立主题放 `themes/theme-<id>.css`，属于某个灵感合集（bundle）的放 `themes/<bundleId>/theme-<id>.css`。id 符合 `^[a-z0-9-]+$`，并且在整棵树里（扁平与合集合并计算）必须唯一：一台机器只装一个扁平的 `theme-<id>.css` 配一把锁，两个合集复用同一个 id 装不下两份。正式文件头写入目录行：

```css
/* name: Charcoal & Amber */
/* name-zh-CN: 炭灰橙 */
/* description: Plain Washi · Charcoal & Amber */
/* description-zh-CN: 商务稳重 · 炭灰與橘色 */
```

`name` / `description` 为英文（目录必填）；`name-zh-CN` / `description-zh-CN` 可选，中文界面优先。其它注释机器不读。版本在 `themes.version`。

合集目录里放 `theme.manifest.json`：`{ id, name, nameZh?, description?, descriptionZh?, author?, official? }`。`id` 必须等于目录名，目录里至少得有一个主题。**manifest 只是构建输入**：主题包仍旧是一叠扁平的 `theme-*.css`——子目录和 manifest 都不会落到机器上；合集本身不可安装。`pack-market` 把它写进 `mohou.themePacks`，并在它的每个行上盖 `themePackId`，所以把主题在合集之间挪动只是重建目录，不需要重发主题。

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
| `com.mohou.data-cask` | 数据手账 | [`apps/com.mohou.data-cask`](./apps/com.mohou.data-cask) |
| `com.mohou.pi-web` | Pi Web | [`apps/com.mohou.pi-web`](./apps/com.mohou.pi-web) |
| `nichi-moss-rust` | Moss Rust / 苔锈 | [`themes/theme-nichi-moss-rust.css`](./themes/theme-nichi-moss-rust.css) |
| `nichi-reed-field` | Reed Field / 荻原 | [`themes/theme-nichi-reed-field.css`](./themes/theme-nichi-reed-field.css) |
| `nichi-lamp` | Corner Lamp / 晚灯 · autumn | [`themes/autumn/theme-nichi-lamp.css`](./themes/autumn/theme-nichi-lamp.css) |
| `nichi-maple-sky` | Maple Sky / 秋枝 · autumn | [`themes/autumn/theme-nichi-maple-sky.css`](./themes/autumn/theme-nichi-maple-sky.css) |
| `nichi-momiji` | Momiji / 枫叶 · autumn | [`themes/autumn/theme-nichi-momiji.css`](./themes/autumn/theme-nichi-momiji.css) |
| `nichi-pumpkin-spice` | Pumpkin Spice / 南瓜肉桂 · autumn | [`themes/autumn/theme-nichi-pumpkin-spice.css`](./themes/autumn/theme-nichi-pumpkin-spice.css) |
| `nichi-white-gourd` | White Gourd / 白南瓜 · autumn | [`themes/autumn/theme-nichi-white-gourd.css`](./themes/autumn/theme-nichi-white-gourd.css) |
| `luxe-festive-plate` | Festive Plate / 珠光盘 · dusk | [`themes/dusk/theme-luxe-festive-plate.css`](./themes/dusk/theme-luxe-festive-plate.css) |
| `luxe-folio` | Warm Folio / 素笺 · dusk | [`themes/dusk/theme-luxe-folio.css`](./themes/dusk/theme-luxe-folio.css) |
| `luxe-rhythm` | Rhythm / 紫穗 · dusk | [`themes/dusk/theme-luxe-rhythm.css`](./themes/dusk/theme-luxe-rhythm.css) |
| `luxe-saffron` | Saffron Ink / 藏红 · dusk | [`themes/dusk/theme-luxe-saffron.css`](./themes/dusk/theme-luxe-saffron.css) |
| `luxe-soft-coral` | Soft Coral / 淡珊瑚 · dusk | [`themes/dusk/theme-luxe-soft-coral.css`](./themes/dusk/theme-luxe-soft-coral.css) |
| `luxe-sunset` | Sunset Bay / 暮湾 · shore | [`themes/shore/theme-luxe-sunset.css`](./themes/shore/theme-luxe-sunset.css) |
| `nichi-field` | Field Bus / 田野 · shore | [`themes/shore/theme-nichi-field.css`](./themes/shore/theme-nichi-field.css) |
| `nichi-sakura` | Sakura Lane / 樱巷 · shore | [`themes/shore/theme-nichi-sakura.css`](./themes/shore/theme-nichi-sakura.css) |
| `nichi-sea` | Sea Bench / 海边 · shore | [`themes/shore/theme-nichi-sea.css`](./themes/shore/theme-nichi-sea.css) |

## 再加一个 app

1. 放到 `apps/<appId>/`。目录名就是 manifest 里的 `id`。`version` 用 semver `x.y.z`。
2. 不要提交 `storage/`、`logs/`、`theme.json`、`.autogen/`、`node_modules/`、`.ui-build/`、`.market.lock`。
3. 在中英文 README 里补上这一行。
4. 改这个 app 的 `version`。目录行变了就 bump `catalog.version`。`MINI_APP_PUBLISH=1 pnpm publish:market` 会打包、上传，并在 npmmirror 排队同步。

## 新增主题或灵感合集

1. 独立主题：把 `theme-<id>.css` 放进 `themes/`，它会落在未分类里。
2. 灵感合集：建 `themes/<bundleId>/`，放入 `theme.manifest.json`，主题 css 与 manifest 同目录。打包脚本会拒绝：缺 manifest 的目录、`id` 与目录名不符、空合集。
3. 主题 id 在整棵树里保持唯一。重用时打包脚本会停，机器读目录时也会停。
4. 在合集之间移动主题就是移文件。只需升 `catalog.version`——主题包和它的校验和都不变。
