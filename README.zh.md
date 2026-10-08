# mini-apps

[English](README.md) | 中文

可分享的 mini-app 合集。界面用 `@mohou/ui`，后端用 `@mohou/contract`，由本机宿主注入。

`apps/<appId>/` 下每个目录是一个独立 app（`manifest.json` + `ui.tsx` + `main.api.ts`，以及可选的 `ui/` / `api/` / `shared/`）。拷进本机 runtime 后，就会出现在小程序面板里。

## 安装某一个 app

**刻度清单**（`com.mungo.kedu`）— 先做完今天。同一张清单的三面：今天（含逾期）、之后、收集。快速解析、子任务、标签、图片、节奏都在，不再和看板、统计抢同一层导航。

```bash
mkdir -p ~/.mini-app/runtime/apps
rm -rf ~/.mini-app/runtime/apps/com.mungo.kedu
cp -R apps/com.mungo.kedu ~/.mini-app/runtime/apps/
```

远程安装：

```bash
npx --yes degit MungoWang/mini-apps/apps/com.mungo.kedu ~/.mini-app/runtime/apps/com.mungo.kedu
```

打开小程序面板，应能看到 **刻度清单**。列表没刷新就对这个 app 做一次 reload。

> `storage/` 不进仓库：每台机器各自有本地数据。

## 目录

| App ID | 名称 | 路径 |
|---|---|---|
| `com.mungo.kedu` | 刻度清单 | [`apps/com.mungo.kedu`](./apps/com.mungo.kedu) |

## 再加一个 app

1. 把源码放到 `apps/<反向域名 id>/`，并写好合法的 `manifest.json`。
2. 不要提交 `storage/`、`.autogen/`、`node_modules/`。
3. 在中英文 README 里补上安装命令。
