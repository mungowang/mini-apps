import { defineApp } from "@mohou/contract";

import { collectTags, parseQuickAdd, shiftKey, todayKey } from "./shared/model";
import type { Priority, Task, TaskPatch } from "./shared/types";

const K_TASKS = "tasks";
const K_SEEDED = "seeded";
const K_IMG = "img_";

function uid(prefix: string): string {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function seed(today: string): Task[] {
  const now = Date.now();
  const day = 86400000;
  let order = 0;

  function task(
    title: string,
    priority: Priority,
    due: string | null,
    tags: string[],
    notes: string,
    subs: { title: string; done: boolean }[],
    doneAt?: number
  ): Task {
    order = order + 1;
    return {
      id: uid("t"),
      title,
      notes,
      done: doneAt !== undefined,
      priority,
      tags,
      starts: null,
      due,
      startTime: null,
      endTime: null,
      subtasks: subs.map(function (s) {
        return { id: uid("s"), title: s.title, done: s.done };
      }),
      images: [],
      order,
      createdAt: now - order * 5400000,
      completedAt: doneAt === undefined ? null : doneAt,
    };
  }

  const seeded = [
    task(
      "把 Q3 复盘写成三页，先给结论",
      1,
      today,
      ["工作"],
      "三条做对了什么、两条要改什么、下季度一个赌注。",
      [
        { title: "拉齐数据口径", done: true },
        { title: "写初稿", done: false },
        { title: "给团队过一遍", done: false },
      ]
    ),
    task("回复设计评审的 3 条意见", 2, today, ["工作", "设计"], "第 2 条关于空状态的说法要单独讨论。", []),
    task("预约牙医复查", 3, shiftKey(today, -2), ["生活"], "上次补牙的位置有点敏感。", []),
    task("读完《清单革命》第 4 章", 3, shiftKey(today, 1), ["阅读"], "做一页摘录，重点是「检查项不是流程」。", [
      { title: "读到 120 页", done: false },
    ]),
    task("整理本周会议纪要并归档", 2, shiftKey(today, 2), ["工作"], "", []),
    task("给妈妈打电话", 2, null, ["生活"], "问问体检结果。", []),
    task("研究 motion 的 layout 动画", 4, null, [], "看 Reorder 与 layout 的区别，做个小样例。", []),
    task("续费域名", 2, shiftKey(today, 6), ["杂务"], "", []),
    task("晨跑 5 公里", 3, today, ["健康"], "", [], now - 2 * 3600000),
    task("提交周报", 2, shiftKey(today, -1), ["工作"], "", [], now - day),
  ];
  seeded[0].startTime = "14:00";
  seeded[0].endTime = "16:30";
  seeded[4].starts = shiftKey(today, 1);
  seeded[4].due = shiftKey(today, 3);
  return seeded;
}

function normalize(raw: any): Task {
  return {
    id: String(raw.id),
    title: String(raw.title || ""),
    notes: typeof raw.notes === "string" ? raw.notes : "",
    done: Boolean(raw.done),
    priority: raw.priority === 1 || raw.priority === 2 || raw.priority === 3 || raw.priority === 4 ? raw.priority : 3,
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    starts: typeof raw.starts === "string" ? raw.starts : null,
    due: typeof raw.due === "string" ? raw.due : null,
    startTime: typeof raw.startTime === "string" ? raw.startTime : null,
    endTime: typeof raw.endTime === "string" ? raw.endTime : null,
    subtasks: Array.isArray(raw.subtasks)
      ? raw.subtasks.map(function (s: any) {
          return { id: String(s && s.id ? s.id : uid("s")), title: String(s && s.title ? s.title : ""), done: Boolean(s && s.done) };
        })
      : [],
    images: Array.isArray(raw.images)
      ? raw.images.map(function (im: any) {
          return { id: String(im && im.id ? im.id : uid("i")), w: Number(im && im.w) || 0, h: Number(im && im.h) || 0 };
        })
      : [],
    order: typeof raw.order === "number" ? raw.order : 0,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
    completedAt: typeof raw.completedAt === "number" ? raw.completedAt : null,
  };
}

async function load(ctx): Promise<Task[]> {
  const kv = ctx.storage.kv();
  const raw = await kv.get(K_TASKS);
  if (Array.isArray(raw)) return raw.map(normalize);
  const seeded = await kv.get(K_SEEDED);
  if (seeded) return [];
  const fresh = seed(todayKey());
  await kv.set(K_TASKS, fresh);
  await kv.set(K_SEEDED, true);
  return fresh;
}

async function save(ctx, tasks: Task[]): Promise<void> {
  await ctx.storage.kv().set(K_TASKS, tasks);
}

function pack(tasks: Task[]) {
  const sorted = tasks.slice().sort(function (a, b) {
    return a.order - b.order;
  });
  return { tasks: sorted, tags: collectTags(sorted) };
}

function applyPatch(task: Task, patch: TaskPatch | undefined): Task {
  const next: Task = {
    id: task.id,
    title: task.title,
    notes: task.notes,
    done: task.done,
    priority: task.priority,
    tags: task.tags.slice(),
    starts: task.starts,
    due: task.due,
    startTime: task.startTime,
    endTime: task.endTime,
    subtasks: task.subtasks.slice(),
    images: (task.images || []).slice(),
    order: task.order,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
  };
  if (!patch) return next;
  if (typeof patch.title === "string") {
    const t = patch.title.trim();
    if (t) next.title = t.slice(0, 200);
  }
  if (typeof patch.notes === "string") next.notes = patch.notes.slice(0, 4000);
  if (typeof patch.done === "boolean") {
    next.done = patch.done;
    next.completedAt = patch.done ? (task.completedAt === null ? Date.now() : task.completedAt) : null;
  }
  if (patch.priority === 1 || patch.priority === 2 || patch.priority === 3 || patch.priority === 4) {
    next.priority = patch.priority;
  }
  if (Array.isArray(patch.tags)) next.tags = patch.tags.map(String).slice(0, 8);
  if (patch.due === null) next.due = null;
  if (typeof patch.due === "string") next.due = patch.due;
  if (patch.starts === null) next.starts = null;
  if (typeof patch.starts === "string") next.starts = patch.starts;
  if (patch.startTime === null) next.startTime = null;
  if (typeof patch.startTime === "string") next.startTime = patch.startTime;
  if (patch.endTime === null) next.endTime = null;
  if (typeof patch.endTime === "string") next.endTime = patch.endTime;
  if (Array.isArray(patch.subtasks)) {
    next.subtasks = patch.subtasks.slice(0, 50).map(function (s: any) {
      return {
        id: String(s && s.id ? s.id : uid("s")),
        title: String(s && s.title ? s.title : "").slice(0, 200),
        done: Boolean(s && s.done),
      };
    });
  }
  return next;
}

export default defineApp({
  name: "刻度清单",
  description: "先做完今天。收集和之后是同一张清单的另外两面。",

  api: {
    async list(ctx) {
      return pack(await load(ctx));
    },

    async add(ctx, args) {
      const today = todayKey();
      const raw = String((args && args.title) || "").trim();
      if (!raw) throw new Error("先写点什么再回车");
      const parsed = parseQuickAdd(raw, today);
      const title = parsed.title.trim();
      if (!title) throw new Error("除了日期和标签，还要写上要做什么");
      const tasks = await load(ctx);
      let minOrder = 0;
      for (let i = 0; i < tasks.length; i++) if (tasks[i].order < minOrder) minOrder = tasks[i].order;
      const hasDue = args && Object.prototype.hasOwnProperty.call(args, "due");
      const created: Task = {
        id: uid("t"),
        title: title.slice(0, 200),
        notes: "",
        done: false,
        priority: args && args.priority ? (args.priority as Priority) : parsed.priority,
        tags: args && Array.isArray(args.tags) ? args.tags.map(String).slice(0, 8) : parsed.tags,
        starts: parsed.starts,
        due: hasDue ? args.due : parsed.due,
        startTime: parsed.startTime,
        endTime: parsed.endTime,
        subtasks: [],
        images: [],
        order: minOrder - 1,
        createdAt: Date.now(),
        completedAt: null,
      };
      tasks.push(created);
      await save(ctx, tasks);
      return pack(tasks);
    },

    async update(ctx, args) {
      const id = String((args && args.id) || "");
      const tasks = await load(ctx);
      let hit = false;
      const next = tasks.map(function (t) {
        if (t.id !== id) return t;
        hit = true;
        return applyPatch(t, args && args.patch);
      });
      if (!hit) throw new Error("任务不存在");
      await save(ctx, next);
      return pack(next);
    },

    async toggle(ctx, args) {
      const id = String((args && args.id) || "");
      const tasks = await load(ctx);
      let hit = false;
      const next = tasks.map(function (t) {
        if (t.id !== id) return t;
        hit = true;
        const done = !t.done;
        return Object.assign({}, t, { done, completedAt: done ? Date.now() : null });
      });
      if (!hit) throw new Error("任务不存在");
      await save(ctx, next);
      return pack(next);
    },

    async remove(ctx, args) {
      const id = String((args && args.id) || "");
      const tasks = await load(ctx);
      const next = tasks.filter(function (t) {
        return t.id !== id;
      });
      if (next.length === tasks.length) throw new Error("任务不存在");
      await save(ctx, next);
      return pack(next);
    },

    async restore(ctx, args) {
      const task = args && args.task;
      if (!task || !task.id) throw new Error("缺少任务");
      const tasks = await load(ctx);
      if (
        tasks.some(function (t) {
          return t.id === task.id;
        })
      ) {
        return pack(tasks);
      }
      let minOrder = 0;
      for (let i = 0; i < tasks.length; i++) if (tasks[i].order < minOrder) minOrder = tasks[i].order;
      tasks.push(Object.assign({}, normalize(task), { order: minOrder - 1 }));
      await save(ctx, tasks);
      return pack(tasks);
    },

    async reorder(ctx, args) {
      const ids: string[] = Array.isArray(args && args.ids) ? args.ids.map(String) : [];
      const tasks = await load(ctx);
      const sorted = tasks.slice().sort(function (a, b) {
        return a.order - b.order;
      });
      const indexOf: Record<string, number> = {};
      for (let i = 0; i < sorted.length; i++) indexOf[sorted[i].id] = i;
      const byId: Record<string, Task> = {};
      for (let i = 0; i < sorted.length; i++) byId[sorted[i].id] = sorted[i];
      const slots: number[] = [];
      for (let i = 0; i < ids.length; i++) {
        const at = indexOf[ids[i]];
        if (at !== undefined) slots.push(at);
      }
      slots.sort(function (a, b) {
        return a - b;
      });
      const out = sorted.slice();
      for (let i = 0; i < ids.length; i++) {
        const t = byId[ids[i]];
        if (t && slots[i] !== undefined) out[slots[i]] = t;
      }
      const final = out.map(function (t, i) {
        return Object.assign({}, t, { order: i });
      });
      await save(ctx, final);
      return pack(final);
    },

    async bulk(ctx, args) {
      const ids: string[] = Array.isArray(args && args.ids) ? args.ids.map(String) : [];
      const action = String((args && args.action) || "done");
      const tasks = await load(ctx);
      let next: Task[];
      if (action === "remove") {
        next = tasks.filter(function (t) {
          return ids.indexOf(t.id) < 0;
        });
      } else {
        const target = action === "active" ? false : true;
        next = tasks.map(function (t) {
          if (ids.indexOf(t.id) < 0) return t;
          return Object.assign({}, t, {
            done: target,
            completedAt: target ? (t.completedAt === null ? Date.now() : t.completedAt) : null,
          });
        });
      }
      await save(ctx, next);
      return pack(next);
    },

    async clearDone(ctx) {
      const tasks = await load(ctx);
      const next = tasks.filter(function (t) {
        return !t.done;
      });
      await save(ctx, next);
      return pack(next);
    },

    async imageAdd(ctx, args) {
      const tasks = await load(ctx);
      const id = uid("i");
      const data = String((args && args.data) || "");
      if (!data) return pack(tasks);
      await ctx.storage.kv().set(K_IMG + id, data);
      const meta = { id, w: Number(args && args.w) || 0, h: Number(args && args.h) || 0 };
      const next = tasks.map(function (t) {
        if (t.id !== String(args && args.taskId)) return t;
        return Object.assign({}, t, { images: (t.images || []).concat([meta]).slice(0, 8) });
      });
      await save(ctx, next);
      return pack(next);
    },

    async imageRemove(ctx, args) {
      const tasks = await load(ctx);
      const id = String((args && args.id) || "");
      if (id) await ctx.storage.kv().delete(K_IMG + id);
      const next = tasks.map(function (t) {
        if (t.id !== String(args && args.taskId)) return t;
        return Object.assign({}, t, {
          images: (t.images || []).filter(function (im) {
            return im.id !== id;
          }),
        });
      });
      await save(ctx, next);
      return pack(next);
    },

    async imagesGet(ctx, args) {
      const ids: string[] = Array.isArray(args && args.ids) ? args.ids.map(String) : [];
      const kv = ctx.storage.kv();
      const out: Record<string, string> = {};
      for (let i = 0; i < ids.length; i++) {
        const v = await kv.get(K_IMG + ids[i]);
        if (typeof v === "string") out[ids[i]] = v;
      }
      return out;
    },

    async reset(ctx) {
      const fresh = seed(todayKey());
      await save(ctx, fresh);
      await ctx.storage.kv().set(K_SEEDED, true);
      return pack(fresh);
    },
  },
});
