# data-cask 内置模板设计：书签库 · Feature Flag 账册

> 状态：草稿 · 待 review  
> 对照：`modules/qa-accounts-basic.caskpack.json`  
> 目标：安装即用；表少、视图准、示例能演示筛选/标签/密钥

---

## 共同约定

| 项 | 约定 |
|---|---|
| pack 形态 | `kind: caskpack` · `version: 1` |
| 冲突 | 安装默认 `skip`（同名表复用并 merge 字段；同名视图跳过） |
| 标签 | 用 `$tags` 列 + 预置条件；多值 `a \| b` |
| 密钥 | `secret` 字段；需要时 `revealSecretsDefault` |
| 写入 | 主业务视图 `allowWrite: true`（本地手账，装完就能改） |
| 示例 | 可关；默认建议 **开**（空表难懂视图价值） |
| 不做什么 | 不做权限/同步/分享；单机本地 |

---

## A. 网页链接与书签库

### 一句话
本地工具箱：按**分类 / 环境 / 标签**找控制台、文档、内部页；支持密钥型入口说明（可选）。

### 为什么值得内置
- 安装轻，人人秒懂  
- 发挥：标签、多选筛选、视图预置、URL 列  
- 和「测试账号」互补：账号是登录态，书签是入口地图  

### 表结构（3 张）

#### 1. `分类`（scope）
| 字段 | 类型 | 说明 |
|---|---|---|
| name | string · label · search | 运维 / 文档 / 控制台 / 设计… |
| code | string · search | `ops` `docs` `console` |
| color | string | 可选备注色名，不驱动 UI 上色（避免彩虹） |
| note | text | |

display: `{name}`

#### 2. `环境`（可选轻量，可与 QA 的「环境」同名冲突）
**方案：本 pack 用表名 `作用域`**，避免和测试账号的「环境」撞名。

| 字段 | 类型 |
|---|---|
| name | string · label · search |
| code | string · search | `ALL` `STG` `PRD` `LOCAL` |
| note | text |

display: `{code}`

> 若 review 更想复用 QA「环境」：可改 `schemaName` 为「环境」并在安装说明里写「可与测试账号共用」。默认 **独立 `作用域`**，零耦合。

#### 3. `书签`（主表）
| 字段 | 类型 | 说明 |
|---|---|---|
| title | string · label · search | 显示名 |
| url | url · search | 主链接 |
| category | ref → 分类 | |
| scope | ref → 作用域 | 默认 ALL |
| owner | string · search | 可选维护人 |
| secretNote | secret | 可选：访问码/说明（非密码柜） |
| note | text | |

display: `{title}`

**标签建议（示例）**  
`pin` · `internal` · `external` · `temp` · `china` · `global`

### 视图

| 视图 | 主表 | 预置条件 | 默认显密 | 列顺序（显示 / 搜索同序优先） |
|---|---|---|---|---|
| **书签一览** | 书签 | — | 否 | 分类 · 作用域 · 标题 · 标签 · URL · 维护人 · 备注 |
| **常用钉选** | 书签 | 标签 ~ pin | 否 | 标题 · URL · 分类 · 作用域 · 标签 |
| **按分类·控制台** | 书签 | 分类.code = console（或 name 含 控制台） | 否 | 标题 · URL · 作用域 · 标签 · 备注 |
| **STG 入口** | 书签 | 作用域.code = STG | 否 | 标题 · URL · 分类 · 标签 |

快捷（书签一览）  
- 全部  
- 钉选 → `$tags` has pin（或 shortcut filters）  
- 内部 → tag internal  
- STG → scope.code STG  

> 实现时：分类预置用 **baseFilter 字段路径** `category.code` / `scope.code`；钉选用 `$tag`。

### 示例数据（约 10～14 行）
- 分类 4：运维、文档、控制台、设计  
- 作用域 3：ALL、STG、PRD  
- 书签 8：  
  - Grafana STG（pin · internal）  
  - 设计稿 Figma（pin）  
  - 某 OpenAPI 文档  
  - 某 PRD 控制台  
  - 临时活动页（temp）  
  - …

### 空态文案
- title: `网页书签`  
- description: `分类 · 作用域 · 链接。控制台、文档、内部页一张图找齐。`  
- recommended: false（或 true 若当第二 onboarding）

### 开放问题（请拍板）
1. 表名用独立 **作用域**，还是复用/同名 **环境**？  
2. `secretNote` 要不要？还是纯链接、密钥全交给「凭证柜」以后再做？  
3. 「按分类·控制台」用 baseFilter 锁分类，还是 shortcut 即可？

---

## B. 环境变量 / Feature Flag 账册

### 一句话
本地配置账本：按**项目 · 环境 · key** 管开关与变量；敏感值打码；视图直接切 STG/PRD。

### 为什么值得内置
- secret + 多环境是 data-cask 强项  
- 研发日常高频  
- 和书签、测试账号都不同：这是 **配置真相表**（本地副本，非实时源）

### 表结构（3 张）

#### 1. `项目`
| 字段 | 类型 |
|---|---|
| name | string · label · search |
| code | string · search |
| note | text |

display: `{name}`

#### 2. `环境`
| 字段 | 类型 |
|---|---|
| name | string · label · search |
| code | string · search | STG / PRD / DEV |
| note | text |

display: `{code}`

> 与 QA「环境」**同名会冲突（复用 merge）**。  
> **推荐表名仍用 `环境`**：用户装过测试账号时自动复用 STG/PRD，体验更爽。  
> 备选：`配置环境` 完全隔离。

#### 3. `配置项`（主表）
| 字段 | 类型 | 说明 |
|---|---|---|
| key | string · label · search | `FEATURE_X` / `API_BASE` |
| project | ref → 项目 | |
| env | ref → 环境 | |
| value | string · search | 非敏感值 |
| secretValue | secret | 敏感值（二选一或并存：有 secret 优先展示） |
| kind | string · search · enum 感 | `flag` `env` `secret` |
| enabled | string | `on` / `off` / `n/a`（flag 用；简单字符串避免 boolean 类型缺口） |
| owner | string · search | |
| note | text | |

display: `{key}`

**标签**  
`flag` · `env` · `secret` · `deprecated` · `critical`

### 值怎么展示（产品规则）
- 列表「值」列：  
  - 若 `secretValue` 有内容 → 显示为密钥列（打码）  
  - 否则显示 `value`  
- **实现简化（本版 pack）**：只放两个列 `value` + `secretValue`，视图里都 show；用户自己看。不在 pack 里做计算列。  
- 业务·STG 视图 `revealSecretsDefault: true`

### 视图

| 视图 | 预置 | 显密默认 | 列序 |
|---|---|---|---|
| **配置一览** | — | 否 | 项目 · 环境 · key · 标签 · kind · enabled · value · secretValue · 负责人 · 备注 |
| **Flag 开关** | 标签 ~ flag **或** kind 含 flag | 否 | 项目 · 环境 · key · enabled · value · 备注 |
| **STG 全量** | 环境.code = STG | **是** | 项目 · key · kind · enabled · value · secretValue · 标签 |
| **PRD 敏感** | 环境.code = PRD **且** 标签 ~ secret\|critical | 否 | 项目 · key · secretValue · 负责人 · 备注 |
| **已废弃** | 标签 ~ deprecated | 否 | 项目 · 环境 · key · 备注 |

快捷（配置一览）  
- STG / PRD  
- 仅 Flag  
- 仅 Secret  
- 我的（owner 过滤 — 若示例 owner 固定可用 shortcut）

### 示例数据
- 项目 2：`logistics-mobile` · `data-cask`  
- 环境 3：DEV · STG · PRD（若复用 QA 环境则可能已有 STG）  
- 配置项 10～12：  
  - Flag：`FF_NEW_CHECKOUT` on/off 跨环境  
  - env：`API_BASE_URL` 各环境不同 value  
  - secret：`OAUTH_CLIENT_SECRET` 仅 secretValue  
  - deprecated 一条  

### 空态文案
- title: `配置账册`  
- description: `项目 · 环境 · 变量与开关。本地台账，STG 可默认显密。`  
- recommended: false  

### 开放问题（请拍板）
1. **环境表**：复用名 `环境`（与 QA 合并）还是 `配置环境`？  
2. `enabled` 用 string `on/off` 是否可接受？（当前 FieldType 无 boolean）  
3. Flag 视图用 **kind=flag** 字段预置，还是 **标签 flag**？建议 **kind 字段为主、标签为辅**（kind 更稳）。  
4. 是否要第四张表「配置历史」？**不要**（第一版太重）。

---

## 两模板对比

| | 书签库 | 配置账册 |
|---|---|---|
| 主对象 | URL | key + value |
| 密钥 | 弱（可选 secretNote） | 强（secretValue） |
| 和 QA 关系 | 弱耦合 | 强（可共享环境） |
| 心智 | 工具箱 | 配置台账 |
| 安装体量 | 小 | 中 |

### 建议安装顺序（产品）
1. 测试账号（已有）  
2. 书签库（轻、广）  
3. 配置账册（专业）  

---

## 实现清单（你点头后）

1. `modules/web-bookmarks-basic.caskpack.json`  
2. `modules/config-flags-basic.caskpack.json`  
3. 写入 `BUILTIN` 列表（`main.api.ts` builtinPacks）  
4. 插画：书签用 `collection`/`notes`；配置用 `security`/`data`  
5. 不改 host；仅 pack + 可能微调 empty-state 文案  

---

## Review 清单（请直接批）

- [ ] 书签：作用域 vs 环境  
- [ ] 书签：要不要 secretNote  
- [ ] 书签：4 个视图是否够 / 要减  
- [ ] 配置：环境表是否与 QA 同名复用  
- [ ] 配置：kind + enabled 模型是否 OK  
- [ ] 配置：STG 默认显密是否 OK  
- [ ] 模块 id / 中文 title 文案  
- [ ] 是否两个都 `recommended: false`，只留测试账号推荐  

批完我按结论落 pack。
