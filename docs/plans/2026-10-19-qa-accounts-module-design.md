# 测试账号模块设计（data-cask）

日期：2026-10-19  
状态：已定稿 · v1 核心已实现（pack + listModules/installModule + 动态空态）  
范围：在 `com.mohou.data-cask` 内用内置模块包，提供通用 QA 测试账号工作台

---

## 1. 目标与非目标

### 目标

- 给 **QA** 用的 **通用** 测试账号管理（不绑具体业务线字段名）。
- **单人本地**：每人一份库；协作靠导出 `.caskpack` / 文件，v1 不做多人占用。
- 产品形态：**仍在数据手账**，用内置模块包一键初始化表 + 视图；不新开 App，不把 QA 实体写进引擎 `FieldType`。
- 空库主路径从「先建模」改为「选模块 → 账号一览可用」。

### 非目标（v1）

- 团队共享库、账号 checkout / 抢号
- 凭证拆表、SSO / OTP、多角色
- 独立「测试账号」App 或专用壳
- 模块市场、远程下发

---

## 2. 形态

| 项 | 决定 |
|---|---|
| 宿主 | `com.mohou.data-cask` |
| 交付物 | 内置 module pack + 空态/设置入口 |
| 安装 | 走现有 `importCaskPack`（可薄封装） |
| 引擎 | schema / record / view 不变；env·system·role·account 只是可删改数据 |

包路径建议：

```
apps/com.mohou.data-cask/modules/qa-accounts-basic.caskpack.json
```

可选 pack 元数据（不破坏 `version: 1` 读者）：`moduleId`, `title`, `description`。

---

## 3. 数据模型

模块 id：`qa-accounts-basic`  
依赖序：`env` → `system` → `role` → `account`

### 3.1 环境 `env`

| 字段 | 类型 | 标志 |
|---|---|---|
| name | string | label |
| code | string | search |
| note | text | |

display：`{code}`

### 3.2 系统 `system`（= 某环境中的实例）

同一逻辑系统在不同环境是 **多行**；URL 挂在实例上，避免账号重复写 URL。

| 字段 | 类型 | 标志 |
|---|---|---|
| name | string | label, search |
| env | ref → env | |
| baseUrl | url | |
| note | text | |

display：`{name} · {env.code}`

### 3.3 角色 `role`

独立表；账号 **单** ref（不做多角色）。

| 字段 | 类型 | 标志 |
|---|---|---|
| name | string | label, search |
| code | string | search |
| note | text | |

display：`{name}`

### 3.4 账号 `account`

| 字段 | 类型 | 标志 |
|---|---|---|
| name | string | label, search |
| system | ref → system | |
| role | ref → role | |
| username | string | search |
| password | secret | |
| note | text | |

display：`{username} · {role.name} · {system.env.code}`（或 `{name}`，实现时二选一写死进 pack）

**明确不设：**

- `account.env` — 环境从 `system.env` 带出，避免双源
- `account.loginUrl` — 入口用 `system.baseUrl`

行 tags：用户自用；示例数据用 `sample`。

---

## 4. 视图

### 4.1 主视图：账号一览

- 主表：`account`
- illustration：`account`（现有插画池）
- 列：

| 列名 | 路径 | show | search | 备注 |
|---|---|---|---|---|
| 名称 | name | ✓ | ✓ | |
| 用户名 | username | ✓ | ✓ | |
| 角色 | role.name | ✓ | ✓ | 筛选靠 shortcut / 列筛 |
| 系统 | system.name | ✓ | ✓ | |
| 环境 | system.env.code | ✓ | ✓ | |
| 入口 | system.baseUrl | ✓ | ✗ | 复制/打开 |
| 密码 | password | ✓ | ✗ | 打码 + 复制真值 |

- 快捷方式（可选）：按 `system.env.code` 的 STG / DEV 等（有 sample 时带；无 sample 可只靠列筛）

### 4.2 次要视图

v1 可不做「系统入口」；需要时再加第二视图（system 主表）。

---

## 5. 安装体验

### 5.1 空态（动态模块列表）

无表时首页 **不写死**「测试账号」等业务名，只提供：

1. **工作模块** — 由运行时扫描内置 `modules/*.caskpack.json`（及约定目录）**动态生成**卡片列表
2. **空白手账** — 现有建表路径（固定入口）
3. **导入 .caskpack** — 现有导入（固定入口）

扩展规则：以后只往 `modules/` 丢新 pack 即可出现在空态，**不必改 UI 文案或 switch 分支**。

每个模块卡片的展示信息来自 pack 自身元数据（见 §5.1.1），不是硬编码 map。

### 5.1.1 模块发现与元数据

- 扫描路径：`apps/com.mohou.data-cask/modules/`（runtime 下为 app 目录内 `modules/`）
- 匹配：`*.caskpack.json`（或 `kind === "caskpack"` 的 JSON）
- API 建议：`listModules()` → `{ id, title, description, path, hasSamples, recommended? }[]`
- pack 内建议字段（`version: 1` 可读方可忽略未知键）：

```json
{
  "version": 1,
  "kind": "caskpack",
  "moduleId": "qa-accounts-basic",
  "name": "测试账号",
  "title": "测试账号",
  "description": "环境 · 系统 · 角色 · 账号，带账号一览视图",
  "recommended": true,
  "schemas": [],
  "views": [],
  "samples": []
}
```

| 字段 | 用途 |
|---|---|
| `moduleId` | 稳定 id；缺省则用文件名（去后缀） |
| `title` / `name` | 卡片标题 |
| `description` | 副文案 |
| `recommended` | 可选；排序时靠前或标「推荐」，UI 仍遍历列表而非写死 id |
| `samples.length` | 决定是否显示「包含示例数据」勾选；无 samples 则隐藏该项 |

排序：`recommended` 优先，其次按 `title` / `moduleId`。用户装过的模块可标「已安装」（按本机是否已有 pack 内全部 schema 名判断，粗粒度即可）。

### 5.2 安装选项

- **是否包含示例数据：用户自选**（默认建议关；UI 必须露出勾选，不静默写入）。仅当该 pack `samples.length > 0` 时显示。
- 有 sample 且用户勾选时：写入 demo 行，tag=`sample`，password 为 demo secret。
- 安装成功后：若 pack 含视图则进入该 pack 的第一个视图（或唯一/名为约定主视图的那一个）；否则回数据页。不写死「账号一览」路由。

### 5.3 冲突策略

- 同名 schema：**复用已有（skip）**，不建第二套 `env` / `system` 等。
- 视图：按名缺失则创建；已有则 skip（或 rename，实现时与 `importCaskPack` 的 `conflict` 对齐，默认偏 skip/reuse）。
- ref 解析：pack 内 `schemaName` → 本机已有同名表 id，否则新建。

### 5.4 清除示例

- 「清除示例数据」：只删 tag 含 `sample` 的行；表与视图保留。

---

## 6. 分享与密钥

沿用 caskpack；分享预设：

| 预设 | schemas | views | rows | secret |
|---|---|---|---|---|
| 只结构 | ✓ | ✓ | ✗ | — |
| 结构 + 行（无密钥） | ✓ | ✓ | ✓ | 清空或 `***` |
| 完整备份 | ✓ | ✓ | ✓ | 真值，**每次确认** |

规则：

- 含 secret 真值必须单独确认；不把「默认带密钥」写入设置。
- 官方模块包只含 demo secret，可随应用分发。
- 同事对齐工作台：装内置模块或分享「只结构」；对齐数据再用无密钥行 / 完整备份。

---

## 7. 与现有能力的关系

| 已有 | 用法 |
|---|---|
| `CaskPack` / `exportCaskPack` / `importCaskPack` | 模块定义与安装、分享 |
| views + shortcuts + illustration | 账号一览 |
| secret 列展示/复制 | 密码列 |
| 空态 UI | 扫 modules/ 动态出卡，业务名来自 pack 元数据 |
| FieldType | **不**扩展 QA 专用类型 |

---

## 8. 实现切片（建议顺序）

1. 约定 `modules/` + 编写 `qa-accounts-basic.caskpack.json`（module 元数据 + schemas + views + samples）
2. API：`listModules()` 扫目录；`installModule({ id | path, includeSamples, conflict: 'skip' })` 封装 import（未勾选或无 samples 则清空 samples 再导入）
3. 空态 UI：**只渲染 `listModules()`**（标题/描述/推荐标/按 hasSamples 显示示例勾选）+ 固定「空白」「导入」；禁止按 moduleId 写死业务文案
4. 设置或导入页：复用同一 list（再次安装 / 清除 sample）；可后置
5. 导出分享预设（可后置）

扩展验收：再增加 `modules/foo.caskpack.json` 后空态自动多卡，零 UI 改动。

---

## 9. 已定决策摘要

| 议题 | 结论 |
|---|---|
| 用户与场景 | 通用 QA 测试账号，非个人杂项手账 |
| 协作 | 单人本地 A |
| 产品形态 | data-cask 内置模块 A |
| 实体 | env + system + role + account（C + 角色独立表 B） |
| 系统与 URL | 系统行 = 环境实例；baseUrl 在 system |
| 账号 | 无 env、无 loginUrl；ref system + role |
| 示例数据 | 安装时用户自选 |
| 同名表 | 复用已有 |
| 空态扩展 | 动态扫 module templates，加 pack 不改 UI |
| 密钥分享 | 完整备份每次确认 |

---

## 10. 后续可能模块（不在 v1）

- `qa-accounts-sso`：Token / SSO 字段或凭证表
- 系统入口专用视图
- 多模块并行安装 UI（数据上多次 import 已可）
