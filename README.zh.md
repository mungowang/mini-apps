# mini-apps

[English](README.md) | 中文

给 [墨猴 Mohou](https://github.com/mungowang/mohou-mini-app) 用的可分享小程序。

一个 app 是一个以 id 命名的目录，里面有 `manifest.json`、`ui.tsx`、`main.api.ts`。需要时再加 `ui/`、`api/`、`shared/`、`schema/`、`assets/`。界面从 `@mohou/ui` 引入，后端从 `@mohou/contract` 引入 `defineApp`。这两份由墨猴提供。

## 默认目录

墨猴从 `<runtime>/apps/<appId>/` 读取 app。

默认的 runtime 根目录是 `~/.mini-app/runtime`。Windows 上是 `%USERPROFILE%\.mini-app\runtime`。设置了 `MINI_APP_RUNTIME` 时，用那个路径当根。库里列出的就是这个 `apps/` 下面的目录。

## 安装某一个 app

**刻度清单**（`com.mohou.kedu`）— 先做完今天。同一张清单的三面：今天（含逾期）、之后、收集。

```bash
root="${MINI_APP_RUNTIME:-$HOME/.mini-app/runtime}"
npx --yes degit MungoWang/mini-apps/apps/com.mohou.kedu "$root/apps/com.mohou.kedu"
```

这条命令写入一个新目录。目录已经在时，从本仓库把源码拷进去，`storage/` 留在原地：

```bash
root="${MINI_APP_RUNTIME:-$HOME/.mini-app/runtime}"
mkdir -p "$root/apps/com.mohou.kedu"
rsync -a --exclude storage --exclude .git --exclude node_modules --exclude .autogen --exclude .ui-build \
  apps/com.mohou.kedu/ "$root/apps/com.mohou.kedu/"
```

打开墨猴，刷新库，就能看到 **刻度清单**。这个 app 已经开着时，reload 一次，新源码才会跑起来。

`storage/` 留在本机。app 目录里墨猴自己的 `.git` 历史也留着。

## 目录

| App ID | 名称 | 路径 |
|---|---|---|
| `com.mohou.kedu` | 刻度清单 | [`apps/com.mohou.kedu`](./apps/com.mohou.kedu) |

## 再加一个 app

1. 放到 `apps/<appId>/`。目录名就是 manifest 里的 `id`。
2. 不要提交 `storage/`、`.autogen/`、`node_modules/`、`.ui-build/`。
3. 在中英文 README 里补上安装命令。
