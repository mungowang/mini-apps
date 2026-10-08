import type { Priority, SortId, Task, ViewId } from "./types";

function pad2(n: number): string {
  return n < 10 ? "0" + String(n) : String(n);
}

export function dateKey(d: Date): string {
  return String(d.getFullYear()) + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

export function todayKey(now?: number): string {
  return dateKey(new Date(now === undefined ? Date.now() : now));
}

export function parseKey(key: string): Date {
  const parts = key.split("-");
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

export function shiftKey(key: string, days: number): string {
  const d = parseKey(key);
  d.setDate(d.getDate() + days);
  return dateKey(d);
}

/** Saturday of this week. Sunday lands on the coming Saturday, matching @本周末. */
export function weekendKey(today: string): string {
  const cur = parseKey(today).getDay();
  const delta = (6 - cur + 7) % 7;
  return shiftKey(today, delta);
}

export function diffDays(a: string, b: string): number {
  return Math.round((parseKey(a).getTime() - parseKey(b).getTime()) / 86400000);
}

export type DueTone = "overdue" | "today" | "soon" | "later";
export type DueMeta = { label: string; tone: DueTone; days: number };

const WEEK_CHARS = ["日", "一", "二", "三", "四", "五", "六"];

export function dueMeta(due: string | null, today: string): DueMeta | null {
  if (!due) return null;
  const days = diffDays(due, today);
  if (days < 0) return { label: "逾期 " + String(-days) + " 天", tone: "overdue", days };
  if (days === 0) return { label: "今天", tone: "today", days };
  if (days === 1) return { label: "明天", tone: "soon", days };
  if (days === 2) return { label: "后天", tone: "soon", days };
  if (days <= 6) return { label: "周" + WEEK_CHARS[parseKey(due).getDay()], tone: "soon", days };
  const d = parseKey(due);
  return { label: String(d.getMonth() + 1) + "月" + String(d.getDate()) + "日", tone: "later", days };
}

export function fullDate(due: string): string {
  const d = parseKey(due);
  return String(d.getFullYear()) + " 年 " + String(d.getMonth() + 1) + " 月 " + String(d.getDate()) + " 日";
}

export function dayHeading(key: string): string {
  const d = parseKey(key);
  return String(d.getMonth() + 1) + "月" + String(d.getDate()) + "日 · 周" + WEEK_CHARS[d.getDay()];
}

export type Parsed = {
  title: string;
  priority: Priority;
  tags: string[];
  starts: string | null;
  due: string | null;
  startTime: string | null;
  endTime: string | null;
  warnings: string[];
};

const DAY_WORDS: Record<string, number> = {
  今天: 0,
  今日: 0,
  明天: 1,
  明日: 1,
  后天: 2,
  大后天: 3,
};

export function parseDueToken(token: string, today: string): string | null {
  if (Object.prototype.hasOwnProperty.call(DAY_WORDS, token)) return shiftKey(today, DAY_WORDS[token]);
  const rel = /^([0-9]+)\s*天[后内]?$/.exec(token);
  if (rel) return shiftKey(today, Number(rel[1]));
  const weekend = /^(本|这|下)?周末$/.exec(token);
  if (weekend) {
    const cur = parseKey(today).getDay();
    let delta = (6 - cur + 7) % 7;
    if (weekend[1] === "下") delta = delta + 7;
    return shiftKey(today, delta);
  }
  const week = /^(下)?周([一二三四五六日天])$/.exec(token);
  if (week) {
    const ch = week[2] === "天" ? "日" : week[2];
    const target = WEEK_CHARS.indexOf(ch);
    const cur = parseKey(today).getDay();
    let delta = (target - cur + 7) % 7;
    if (delta === 0) delta = 7;
    if (week[1]) delta = delta + 7;
    return shiftKey(today, delta);
  }
  const iso = /^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})$/.exec(token);
  if (iso) return iso[1] + "-" + pad2(Number(iso[2])) + "-" + pad2(Number(iso[3]));
  const md = /^([0-9]{1,2})[\/.-]([0-9]{1,2})$/.exec(token);
  if (md) {
    const month = Number(md[1]);
    const day = Number(md[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const year = parseKey(today).getFullYear();
    let key = String(year) + "-" + pad2(month) + "-" + pad2(day);
    if (diffDays(key, today) < 0) key = String(year + 1) + "-" + pad2(month) + "-" + pad2(day);
    return key;
  }
  return null;
}

export function fmtShort(key: string): string {
  const d = parseKey(key);
  return String(d.getMonth() + 1) + "/" + String(d.getDate());
}

// "@9/13-9/15", "@明天~后天", "@2026-09-13-2026-09-15" — a span, not a single day
export function parseDueRange(token: string, today: string): { starts: string; due: string } | null {
  const seps = ["~", "→", "至"];
  for (let s = 0; s < seps.length; s++) {
    const i = token.indexOf(seps[s]);
    if (i <= 0) continue;
    const a = parseDueToken(token.slice(0, i), today);
    const b = parseDueToken(token.slice(i + seps[s].length), today);
    if (a && b) return { starts: a, due: b };
  }
  for (let i = 1; i < token.length - 1; i++) {
    if (token.charAt(i) !== "-") continue;
    const a = parseDueToken(token.slice(0, i), today);
    if (!a) continue;
    const b = parseDueToken(token.slice(i + 1), today);
    if (b) return { starts: a, due: b };
  }
  return null;
}

// "@14:00" or "@14:00-15:30"
export function parseTimeToken(token: string): { start: string; end: string | null } | null {
  const two = /^([0-9]{1,2}):([0-9]{2})-([0-9]{1,2}):([0-9]{2})$/.exec(token);
  if (two) {
    const h1 = Number(two[1]);
    const h2 = Number(two[3]);
    if (h1 > 23 || h2 > 23) return null;
    return { start: pad2(h1) + ":" + two[2], end: pad2(h2) + ":" + two[4] };
  }
  const one = /^([0-9]{1,2}):([0-9]{2})$/.exec(token);
  if (one) {
    const h = Number(one[1]);
    if (h > 23) return null;
    return { start: pad2(h) + ":" + one[2], end: null };
  }
  return null;
}

export type Schedulable = { starts: string | null; due: string | null; startTime: string | null; endTime: string | null };
export type Schedule = { label: string; tone: DueTone; days: number | null };

export function scheduleOf(t: Schedulable, today: string): Schedule | null {
  const meta = dueMeta(t.due, today);
  let datePart = "";
  if (t.starts && t.due && t.starts !== t.due) datePart = fmtShort(t.starts) + " → " + (meta ? meta.label : fmtShort(t.due));
  else if (meta) datePart = meta.label;
  else if (t.starts) datePart = fmtShort(t.starts);
  let timePart = "";
  if (t.startTime && t.endTime) timePart = t.startTime + "-" + t.endTime;
  else if (t.startTime) timePart = t.startTime;
  if (!datePart && !timePart) return null;
  return { label: datePart + (timePart ? " " + timePart : ""), tone: meta ? meta.tone : "later", days: meta ? meta.days : null };
}

// Overdue severity, 0-3. Priority weighs in: a P1 a day late is already more pressing than a
// P4 a day late, so priority adds "effective days" before the thresholds are applied.
export function overdueTier(meta: Schedule | null, priority?: Priority): 0 | 1 | 2 | 3 {
  if (!meta || meta.tone !== "overdue" || meta.days === null) return 0;
  const bonus = priority === 1 ? 3 : priority === 2 ? 1 : 0;
  const effective = -meta.days + bonus;
  if (effective >= 7) return 3;
  if (effective >= 3) return 2;
  return 1;
}

export function parseQuickAdd(raw: string, today: string): Parsed {
  let priority: Priority = 3;
  const tags: string[] = [];
  const warnings: string[] = [];
  let starts: string | null = null;
  let due: string | null = null;
  let startTime: string | null = null;
  let endTime: string | null = null;
  const kept: string[] = [];
  const tokens = raw.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const pri = /^[!！]([1-4])$/.exec(token) || /^[pP]([1-4])$/.exec(token);
    if (pri) {
      priority = Number(pri[1]) as Priority;
      continue;
    }
    const tag = /^#([^#\s]{1,16})$/.exec(token);
    if (tag) {
      if (tags.indexOf(tag[1]) < 0) tags.push(tag[1]);
      continue;
    }
    if (/^#/.test(token) && token.length > 1) {
      warnings.push(token.length > 17 ? "# 后最多 16 个字" : token);
      kept.push(token);
      continue;
    }
    const at = /^@(.+)$/.exec(token);
    if (at) {
      const body = at[1];
      const single = parseDueToken(body, today);
      if (single) {
        due = single;
        continue;
      }
      const range = parseDueRange(body, today);
      if (range) {
        starts = range.starts;
        due = range.due;
        continue;
      }
      const time = parseTimeToken(body);
      if (time) {
        startTime = time.start;
        endTime = time.end;
        continue;
      }
      warnings.push(token);
    }
    kept.push(token);
  }
  return { title: kept.join(" ").trim(), priority, tags, starts, due, startTime, endTime, warnings };
}

export function completedOn(task: Task, day: string): boolean {
  if (!task.done || task.completedAt === null) return false;
  return dateKey(new Date(task.completedAt)) === day;
}

export function inView(task: Task, view: ViewId, today: string): boolean {
  if (task.done) return false;
  if (view === "today") return Boolean(task.due) && diffDays(task.due as string, today) <= 0;
  if (view === "next") return Boolean(task.due) && diffDays(task.due as string, today) > 0;
  // A date is the only thing that schedules a task. A tag is a label, so it stays in 收集
  // until someone puts the task on a day. Otherwise tagged-but-undated work disappears.
  return !task.due;
}

export type GroupId = "overdue" | "today" | "tomorrow" | "week" | "later" | "none" | "done";

export const GROUP_TITLE: Record<GroupId, string> = {
  overdue: "逾期",
  today: "今天",
  tomorrow: "明天",
  week: "本周内",
  later: "以后",
  none: "未排期",
  done: "已完成",
};

export const GROUP_ORDER: GroupId[] = ["overdue", "today", "tomorrow", "week", "later", "none", "done"];

export function groupOf(task: Task, today: string): GroupId {
  if (task.done) return "done";
  if (!task.due) return "none";
  const d = diffDays(task.due, today);
  if (d < 0) return "overdue";
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d <= 6) return "week";
  return "later";
}

export function sortTasks(list: Task[], sort: SortId): Task[] {
  const arr = list.slice();
  if (sort === "due") {
    arr.sort(function (a, b) {
      const av = a.due === null ? "9999-99-99" : a.due;
      const bv = b.due === null ? "9999-99-99" : b.due;
      if (av !== bv) return av < bv ? -1 : 1;
      return a.order - b.order;
    });
  } else if (sort === "priority") {
    arr.sort(function (a, b) {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.order - b.order;
    });
  } else if (sort === "created") {
    arr.sort(function (a, b) {
      return b.createdAt - a.createdAt;
    });
  } else {
    arr.sort(function (a, b) {
      if (a.done && b.done) return (b.completedAt === null ? 0 : b.completedAt) - (a.completedAt === null ? 0 : a.completedAt);
      return a.order - b.order;
    });
  }
  return arr;
}

export function collectTags(tasks: Task[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const list = tasks[i].tags;
    for (let j = 0; j < list.length; j++) {
      if (out.indexOf(list[j]) < 0) out.push(list[j]);
    }
  }
  return out;
}

export type DayStat = { key: string; day: string; count: number };

export type Stats = {
  total: number;
  active: number;
  done: number;
  overdue: number;
  dueToday: number;
  doneToday: number;
  rate: number;
  streak: number;
  weekDone: number;
  days: DayStat[];
  tags: { name: string; count: number }[];
  byPriority: { priority: Priority; count: number; done: number }[];
};

export function computeStats(tasks: Task[], today: string): Stats {
  const active = tasks.filter(function (t) {
    return !t.done;
  });
  const done = tasks.filter(function (t) {
    return t.done;
  });
  const overdue = active.filter(function (t) {
    return Boolean(t.due) && diffDays(t.due as string, today) < 0;
  });
  const dueToday = tasks.filter(function (t) {
    return !t.done && Boolean(t.due) && diffDays(t.due as string, today) <= 0;
  });

  function doneOn(key: string): number {
    let n = 0;
    for (let i = 0; i < done.length; i++) {
      const c = done[i].completedAt;
      if (c !== null && dateKey(new Date(c)) === key) n++;
    }
    return n;
  }

  const days: DayStat[] = [];
  for (let i = 13; i >= 0; i--) {
    const k = shiftKey(today, -i);
    days.push({ key: k, day: k.slice(8), count: doneOn(k) });
  }

  let streak = 0;
  for (let i = 0; i < 365; i++) {
    if (doneOn(shiftKey(today, -i)) > 0) streak++;
    else if (i === 0) continue;
    else break;
  }

  const tagMap: Record<string, number> = {};
  for (let i = 0; i < active.length; i++) {
    const list = active[i].tags;
    for (let j = 0; j < list.length; j++) {
      const name = list[j];
      tagMap[name] = (tagMap[name] === undefined ? 0 : tagMap[name]) + 1;
    }
  }
  const tags = Object.keys(tagMap)
    .map(function (name) {
      return { name, count: tagMap[name] };
    })
    .sort(function (a, b) {
      return b.count - a.count;
    });

  const byPriority = [1, 2, 3, 4].map(function (p) {
    const pri = p as Priority;
    return {
      priority: pri,
      count: tasks.filter(function (t) {
        return !t.done && t.priority === pri;
      }).length,
      done: tasks.filter(function (t) {
        return t.done && t.priority === pri;
      }).length,
    };
  });

  return {
    total: tasks.length,
    active: active.length,
    done: done.length,
    overdue: overdue.length,
    dueToday: dueToday.length,
    doneToday: doneOn(today),
    rate: tasks.length === 0 ? 0 : Math.round((done.length / tasks.length) * 100),
    streak,
    weekDone: days.slice(7).reduce(function (s, d) {
      return s + d.count;
    }, 0),
    days,
    tags,
    byPriority,
  };
}

export function relativeTime(ts: number | null, now?: number): string {
  if (!ts) return "—";
  const base = now === undefined ? Date.now() : now;
  const diff = base - ts;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return String(Math.floor(diff / 60000)) + " 分钟前";
  if (diff < 86400000) return String(Math.floor(diff / 3600000)) + " 小时前";
  if (diff < 86400000 * 30) return String(Math.floor(diff / 86400000)) + " 天前";
  return dateKey(new Date(ts));
}
