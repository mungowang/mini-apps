// Event names AND payloads live here so ui.tsx and api/ cannot drift.
// Pure isomorphic: no React, no ctx, no DOM, no Node.
export const EV = {
  installLog: 'installLog',
} as const

export type Events = {
  installLog: {
    /** Bounded tail of the npm/pi console output so far. */
    text: string
    /** True when the long-running command settled (success or failure). */
    done: boolean
  }
}

export type EventName = keyof Events
export type InstallLog = Events['installLog']

/** Live status of one Recent Sessions row. */
export type RecentSessionStatus = 'running' | 'awaiting' | 'idle'

/** One session in the shell Recent list (cross-project). */
export interface RecentSessionItem {
  readonly id: string
  readonly title: string
  readonly cwd: string
  readonly repo: string
  readonly projectRoot?: string
  readonly status: RecentSessionStatus
  /** ISO timestamp of last update (pi-web modified). */
  readonly updated: string
  readonly updatedMs: number
}

/** One plugin this app recommends installing. Pure data both sides read. */
export interface RecommendedPlugin {
  readonly pkg: string
  readonly name: string
  readonly description: string
}

export const RECOMMENDED: readonly RecommendedPlugin[] = [
  {
    pkg: 'npm:pi-mermaid',
    name: 'Mermaid 图表',
    description: '在对话里渲染和导出 Mermaid 图表',
  },
  {
    pkg: 'npm:pi-web-access',
    name: 'Web Access',
    description: '网页搜索与阅读能力，让 pi 能查资料',
  },
  {
    pkg: 'npm:pi-workspace-history',
    name: '工作区历史',
    description: '按工作区记录会话历史，快速回到上下文',
  },
  {
    pkg: 'npm:@juicesharp/rpiv-ask-user-question',
    name: '结构化提问',
    description: '关键分叉处给用户结构化选项，而不是开放式追问',
  },
  {
    pkg: 'npm:superpowers-zh',
    name: 'Superpowers 中文版',
    description: '常用工作流技能包（中文）',
  },
  {
    pkg: 'npm:pi-hermes-memory',
    name: '跨会话记忆',
    description: '给 pi 增加跨会话的持久记忆与检索',
  },
  {
    pkg: 'npm:@narumitw/pi-goal',
    name: 'Goal 面板',
    description: '目标拆解与追踪面板',
  },
  {
    pkg: 'npm:glimpseui',
    name: 'Glimpse UI',
    description: '弹窗展示 HTML / 表单 / 图表，适合做轻界面',
  },
  {
    pkg: 'npm:pi-devops-tools',
    name: 'DevOps 数据库',
    description: 'MySQL 查询工作区：schema 缓存、关系图与查询历史',
  },
]
