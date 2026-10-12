export type Priority = 1 | 2 | 3 | 4;

export type Subtask = {
  id: string;
  title: string;
  done: boolean;
  /** Set when marked done; cleared when reopened. Older data may be null even if done. */
  completedAt: number | null;
};

export type TaskImage = {
  id: string;
  w: number;
  h: number;
};

export type Task = {
  id: string;
  title: string;
  notes: string;
  done: boolean;
  priority: Priority;
  tags: string[];
  starts: string | null; // range start (YYYY-MM-DD); equals due for a single day
  due: string | null; // due date, or the END of a range
  startTime: string | null; // "HH:MM"
  endTime: string | null; // "HH:MM"
  subtasks: Subtask[];
  images: TaskImage[];
  order: number;
  createdAt: number;
  completedAt: number | null;
  /** Orthogonal to done/schedule. Multiple tasks may be doing at once. */
  doing: boolean;
  /** When doing became true; newest first on the 正在做 stage. */
  doingAt: number | null;
};

/** 今天 = 逾期+今日；之后 = 已排到未来；收集 = 还没有日期；曾经 = 近期完成。 */
export type ViewId = "today" | "next" | "inbox" | "once";

/** Time window for the 曾经 lens. `all` is uncapped (UI may soft-cap the DOM). */
export type OnceRange = { mode: "days"; n: number } | { mode: "all" };

export type SortId = "manual" | "due" | "priority" | "created";

export type TaskPatch = Partial<Omit<Task, "id" | "createdAt" | "order">>;

export type Pack = { tasks: Task[]; tags: string[] };

export const PRIORITY_ORDER: Priority[] = [1, 2, 3, 4];
export const PRIORITY_LABEL: Record<Priority, string> = { 1: "P1", 2: "P2", 3: "P3", 4: "P4" };
export const PRIORITY_TITLE: Record<Priority, string> = { 1: "紧急", 2: "高", 3: "中", 4: "低" };
