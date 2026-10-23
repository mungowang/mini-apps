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

/** One plugin this app recommends installing. Pure data both sides read. */
export interface RecommendedPlugin {
  readonly pkg: string
  readonly name: string
  readonly description: string
}

export const RECOMMENDED: readonly RecommendedPlugin[] = [
  {
    pkg: 'npm:tau-mirror',
    name: 'Tau Mirror',
    description: '内网工具镜像服务，浏览器直取 Tesla 内部资源',
  },
  {
    pkg: 'npm:pi-mermaid',
    name: 'Mermaid 图表',
    description: '在对话里渲染和导出 Mermaid 图表',
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
]
