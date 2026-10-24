import { defineApp } from "@mohou/contract";

import { collectTags, parseKeduPaste, shiftKey, todayKey } from "./shared/model";
import type { Priority, Task, TaskPatch } from "./shared/types";
import { clearAllTasks, clearDoneRows, countTasks, deleteTask, insertTask, loadBoards, loadTask, loadTasks, minSortOrder, nextBoardSort, persistTask, searchTaskIds } from "./api/store";
import type { Board } from "./shared/types";
import type { Connector, ConnectorKind, ConnectorMapping, ConnectorSource } from "./shared/connectors";
import { TEMPLATES, connectorUid, fetchRows, loadConnector, loadConnectors, rowToConnector, tombstoneTaskLinks, upsertDrafts } from "./api/connectors";
import { buildCatalog, detectRoots, evalMapping } from "./shared/connectors";

const K_SEEDED = "seeded";

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
        return {
          id: uid("s"),
          title: s.title,
          done: s.done,
          completedAt: s.done ? now - order * 1000 : null,
        };
      }),
      images: [],
      order,
      createdAt: now - order * 5400000,
      completedAt: doneAt === undefined ? null : doneAt,
      doing: false,
      doingAt: null,
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
    boardId: typeof raw.boardId === "string" && raw.boardId !== "default" ? raw.boardId : null,
    starts: typeof raw.starts === "string" ? raw.starts : null,
    due: typeof raw.due === "string" ? raw.due : null,
    startTime: typeof raw.startTime === "string" ? raw.startTime : null,
    endTime: typeof raw.endTime === "string" ? raw.endTime : null,
    subtasks: Array.isArray(raw.subtasks)
      ? raw.subtasks.map(function (s: any) {
          const done = Boolean(s && s.done);
          const completedAt = typeof (s && s.completedAt) === "number" ? s.completedAt : null;
          return {
            id: String(s && s.id ? s.id : uid("s")),
            title: String(s && s.title ? s.title : ""),
            done: done,
            completedAt: done ? completedAt : null,
          };
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
    doing: Boolean(raw.doing) && !Boolean(raw.done),
    doingAt:
      Boolean(raw.doing) && !Boolean(raw.done) && typeof raw.doingAt === "number" ? raw.doingAt : null,
  };
}

/** First run only: empty table and never seeded -> demo data. */
async function ensureSeeded(ctx): Promise<void> {
  if ((await countTasks(ctx.storage)) > 0) return;
  const kv = ctx.storage.kv();
  if (await kv.get(K_SEEDED)) return;
  const fresh = seed(todayKey());
  await ctx.storage.transaction(async function (tx) {
    for (let i = 0; i < fresh.length; i++) await insertTask(tx, fresh[i]);
  });
  await kv.set(K_SEEDED, true);
}

function pack(tasks: Task[], boards: Board[]) {
  const sorted = tasks.slice().sort(function (a, b) {
    return a.order - b.order;
  });
  return { tasks: sorted, tags: collectTags(sorted), boards: boards };
}

/** The shape every api method returns: tasks + tags + boards. */
async function snapshot(ctx): Promise<ReturnType<typeof pack>> {
  return pack(await loadTasks(ctx.storage), await loadBoards(ctx.storage));
}

/** Board names live inside the `$` DSL token, so no whitespace; "默认" is reserved. */
function validBoardName(raw: any): string {
  const name = String(raw === undefined || raw === null ? "" : raw).trim();
  if (!name) throw new Error("板块名不能为空");
  if (name.length > 16) throw new Error("板块名最多 16 个字");
  if (/\s/.test(name)) throw new Error("板块名不能带空格，快记里 $板名 要能当一个词写");
  if (name === "默认" || name === "default") throw new Error("和内置的「默认」重名了");
  return name;
}

function applyPatch(task: Task, patch: TaskPatch | undefined): Task {
  const next: Task = {
    id: task.id,
    title: task.title,
    notes: task.notes,
    done: task.done,
    priority: task.priority,
    tags: task.tags.slice(),
    boardId: task.boardId,
    starts: task.starts,
    due: task.due,
    startTime: task.startTime,
    endTime: task.endTime,
    subtasks: task.subtasks.slice(),
    images: (task.images || []).slice(),
    order: task.order,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
    doing: task.doing,
    doingAt: task.doingAt,
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
    if (patch.done) {
      next.doing = false;
      next.doingAt = null;
    }
  }
  if (typeof patch.doing === "boolean") {
    if (next.done) {
      next.doing = false;
      next.doingAt = null;
    } else {
      next.doing = patch.doing;
      if (patch.doing) {
        next.doingAt =
          typeof patch.doingAt === "number"
            ? patch.doingAt
            : task.doing && task.doingAt != null
              ? task.doingAt
              : Date.now();
      } else {
        next.doingAt = null;
      }
    }
  }
  if (patch.priority === 1 || patch.priority === 2 || patch.priority === 3 || patch.priority === 4) {
    next.priority = patch.priority;
  }
  if (Array.isArray(patch.tags)) next.tags = patch.tags.map(String).slice(0, 8);
  if (patch.boardId === null) next.boardId = null;
  if (typeof patch.boardId === "string") next.boardId = patch.boardId;
  if (patch.due === null) next.due = null;
  if (typeof patch.due === "string") next.due = patch.due;
  if (patch.starts === null) next.starts = null;
  if (typeof patch.starts === "string") next.starts = patch.starts;
  if (patch.startTime === null) next.startTime = null;
  if (typeof patch.startTime === "string") next.startTime = patch.startTime;
  if (patch.endTime === null) next.endTime = null;
  if (typeof patch.endTime === "string") next.endTime = patch.endTime;
  if (Array.isArray(patch.subtasks)) {
    const prevById: Record<string, { done: boolean; completedAt: number | null }> = {};
    for (let i = 0; i < task.subtasks.length; i++) {
      prevById[task.subtasks[i].id] = {
        done: task.subtasks[i].done,
        completedAt: task.subtasks[i].completedAt == null ? null : task.subtasks[i].completedAt,
      };
    }
    next.subtasks = patch.subtasks.slice(0, 50).map(function (s: any) {
      const id = String(s && s.id ? s.id : uid("s"));
      const done = Boolean(s && s.done);
      const prev = prevById[id];
      let completedAt: number | null = null;
      if (done) {
        if (typeof s.completedAt === "number") completedAt = s.completedAt;
        else if (prev && prev.completedAt !== null && prev.completedAt !== undefined) completedAt = prev.completedAt;
        else completedAt = Date.now();
      }
      return {
        id: id,
        title: String(s && s.title ? s.title : "").slice(0, 200),
        done: done,
        completedAt: completedAt,
      };
    });
  }
  if (Array.isArray(patch.images)) {
    next.images = patch.images.slice(0, 8).map(function (im: any) {
      return { id: String(im && im.id ? im.id : uid("i")), w: Number(im && im.w) || 0, h: Number(im && im.h) || 0 };
    });
  }
  return next;
}

export default defineApp({
  name: "刻度清单",
  description: "先做完今天。收集和之后是同一张清单的另外两面。",

  api: {
    async list(ctx) {
      await ensureSeeded(ctx);
      return snapshot(ctx);
    },

    async add(ctx, args) {
      const today = todayKey();
      const raw = String((args && args.title) || "").trim();
      if (!raw) throw new Error("先写点什么再回车");
      // title may be multi-line 刻度文本: line 1 DSL, rest notes / - [ ] subtasks.
      const parsed = parseKeduPaste(raw, today);
      const title = parsed.title.trim();
      if (!title) throw new Error("除了日期和标签，还要写上要做什么");
      // $板名 → board id；没有 $ 标记就进「当前板块」（UI 传入，默认板块传 null）。不认识的板名直接拦下。
      let boardId: string | null = null;
      if (parsed.boardName) {
        const boardRows = await ctx.storage.query("SELECT id FROM boards WHERE name = ?", [parsed.boardName]);
        if (boardRows.length === 0) throw new Error("没有这个板块：$" + parsed.boardName);
        boardId = String(boardRows[0].id);
      } else if (args && typeof args.boardId === "string" && args.boardId !== "default") {
        const boardRows = await ctx.storage.query("SELECT id FROM boards WHERE id = ?", [args.boardId]);
        if (boardRows.length === 0) throw new Error("板块不存在");
        boardId = args.boardId;
      }
      const minOrder = await minSortOrder(ctx.storage);
      const hasDue = args && Object.prototype.hasOwnProperty.call(args, "due");
      // Prefer explicit args; fall back to body parsed from multi-line paste.
      const notesFromArgs =
        args && typeof args.notes === "string" ? String(args.notes).trim().slice(0, 4000) : "";
      const notes = notesFromArgs || parsed.notes;
      const subtasksFromArgs =
        args && Array.isArray(args.subtasks)
          ? args.subtasks
              .map(function (s: { title?: string; done?: boolean }) {
                const t = String((s && s.title) || "").trim().slice(0, 200);
                if (!t) return null;
                const done = Boolean(s && s.done);
                return {
                  id: uid("s"),
                  title: t,
                  done: done,
                  completedAt: done ? Date.now() : null,
                };
              })
              .filter(Boolean)
              .slice(0, 32)
          : null;
      const subtasks = (subtasksFromArgs && subtasksFromArgs.length
        ? subtasksFromArgs
        : parsed.subtasks.map(function (s) {
            return {
              id: uid("s"),
              title: s.title,
              done: s.done,
              completedAt: s.done ? Date.now() : null,
            };
          })) as Task["subtasks"];
      const created: Task = {
        id: uid("t"),
        title: title.slice(0, 200),
        notes: notes,
        done: false,
        priority: args && args.priority ? (args.priority as Priority) : parsed.priority,
        tags: args && Array.isArray(args.tags) ? args.tags.map(String).slice(0, 8) : parsed.tags,
        starts: parsed.starts,
        due: hasDue ? args.due : parsed.due,
        startTime: parsed.startTime,
        endTime: parsed.endTime,
        subtasks: subtasks,
        images: [],
        order: minOrder - 1,
        createdAt: Date.now(),
        completedAt: null,
        doing: false,
        doingAt: null,
        boardId: boardId,
      };
      await ctx.storage.transaction(async function (tx) {
        await insertTask(tx, created);
      });
      return snapshot(ctx);
    },

    async update(ctx, args) {
      const id = String((args && args.id) || "");
      const task = await loadTask(ctx.storage, id);
      if (!task) throw new Error("任务不存在");
      if (args && args.patch && Object.prototype.hasOwnProperty.call(args.patch, "boardId")) {
        const v = (args.patch as Record<string, unknown>).boardId;
        if (typeof v === "string") {
          const boardRows = await ctx.storage.query("SELECT id FROM boards WHERE id = ?", [v]);
          if (boardRows.length === 0) throw new Error("板块不存在");
        }
      }
      const next = applyPatch(task, args && args.patch);
      await ctx.storage.transaction(async function (tx) {
        await persistTask(tx, next);
      });
      return snapshot(ctx);
    },

    async toggle(ctx, args) {
      const id = String((args && args.id) || "");
      const task = await loadTask(ctx.storage, id);
      if (!task) throw new Error("任务不存在");
      const done = !task.done;
      const flag = done ? 1 : 0;
      await ctx.storage.run(
        "UPDATE tasks SET done = ?, completed_at = ?," +
          " doing = CASE WHEN ? = 1 THEN 0 ELSE doing END," +
          " doing_at = CASE WHEN ? = 1 THEN NULL ELSE doing_at END" +
          " WHERE id = ?",
        [flag, done ? Date.now() : null, flag, flag, id]
      );
      return snapshot(ctx);
    },

    async remove(ctx, args) {
      const id = String((args && args.id) || "");
      const task = await loadTask(ctx.storage, id);
      if (!task) throw new Error("任务不存在");
      await ctx.storage.transaction(async function (tx) {
        await tombstoneTaskLinks(tx, id);
        await deleteTask(tx, id);
      });
      return snapshot(ctx);
    },

    async restore(ctx, args) {
      const task = args && args.task;
      if (!task || !task.id) throw new Error("缺少任务");
      const existing = await loadTask(ctx.storage, String(task.id));
      if (existing) return snapshot(ctx);
      const minOrder = await minSortOrder(ctx.storage);
      const next = Object.assign({}, normalize(task), { order: minOrder - 1 });
      await ctx.storage.transaction(async function (tx) {
        await insertTask(tx, next);
      });
      return snapshot(ctx);
    },

    async reorder(ctx, args) {
      const ids: string[] = Array.isArray(args && args.ids) ? args.ids.map(String) : [];
      const rows = await ctx.storage.query("SELECT id FROM tasks ORDER BY sort_order, created_at");
      const sortedIds = rows.map(function (r) { return String(r.id); });
      const indexOf: Record<string, number> = {};
      for (let i = 0; i < sortedIds.length; i++) indexOf[sortedIds[i]] = i;
      const slots: number[] = [];
      for (let i = 0; i < ids.length; i++) {
        const at = indexOf[ids[i]];
        if (at !== undefined) slots.push(at);
      }
      slots.sort(function (a, b) { return a - b; });
      const out = sortedIds.slice();
      for (let i = 0; i < ids.length; i++) {
        if (indexOf[ids[i]] !== undefined && slots[i] !== undefined) out[slots[i]] = ids[i];
      }
      await ctx.storage.transaction(async function (tx) {
        for (let i = 0; i < out.length; i++) {
          await tx.run("UPDATE tasks SET sort_order = ? WHERE id = ?", [i, out[i]]);
        }
      });
      return snapshot(ctx);
    },

    async bulk(ctx, args) {
      const ids: string[] = Array.isArray(args && args.ids) ? args.ids.map(String) : [];
      const action = String((args && args.action) || "done");
      if (action === "remove") {
        await ctx.storage.transaction(async function (tx) {
          for (let i = 0; i < ids.length; i++) {
            await tombstoneTaskLinks(tx, ids[i]);
            await deleteTask(tx, ids[i]);
          }
        });
      } else if (action === "schedule") {
        const patch = args && args.patch && typeof args.patch === "object" ? args.patch : {};
        const sets: string[] = [];
        const params: unknown[] = [];
        if (Object.prototype.hasOwnProperty.call(patch, "due")) {
          sets.push("due = ?");
          params.push(patch.due);
        }
        if (Object.prototype.hasOwnProperty.call(patch, "starts")) {
          sets.push("starts = ?");
          params.push(patch.starts);
        }
        if (sets.length) {
          await ctx.storage.transaction(async function (tx) {
            for (let i = 0; i < ids.length; i++) {
              await tx.run("UPDATE tasks SET " + sets.join(", ") + " WHERE id = ?", params.concat([ids[i]]));
            }
          });
        }
      } else {
        const target = action === "active" ? false : true;
        await ctx.storage.transaction(async function (tx) {
          for (let i = 0; i < ids.length; i++) {
            if (target) {
              await tx.run(
                "UPDATE tasks SET done = 1, completed_at = COALESCE(completed_at, ?), doing = 0, doing_at = NULL WHERE id = ?",
                [Date.now(), ids[i]]
              );
            } else {
              await tx.run("UPDATE tasks SET done = 0, completed_at = NULL WHERE id = ?", [ids[i]]);
            }
          }
        });
      }
      return snapshot(ctx);
    },

    async clearDone(ctx) {
      await ctx.storage.transaction(async function (tx) {
        const doneIds = (await tx.query("SELECT id FROM tasks WHERE done = 1")).map(function (r) { return String(r.id); });
        for (let i = 0; i < doneIds.length; i++) await tombstoneTaskLinks(tx, doneIds[i]);
        await clearDoneRows(tx);
      });
      return snapshot(ctx);
    },

    /** SQL-side search over title / notes / tags / subtask titles. */
    async search(ctx, args) {
      const q = String((args && args.q) || "").trim();
      if (!q) return { tasks: [], tags: [] };
      const ids = await searchTaskIds(ctx.storage, q);
      if (ids.length === 0) return { tasks: [], tags: [] };
      const all = await loadTasks(ctx.storage);
      const wanted: Record<string, boolean> = {};
      for (let i = 0; i < ids.length; i++) wanted[ids[i]] = true;
      const tasks = all.filter(function (t) { return wanted[t.id] === true; });
      return { tasks: tasks, tags: collectTags(tasks) };
    },

    async imageAdd(ctx, args) {
      const tasks = await loadTasks(ctx.storage);
      const id = uid("i");
      const data = String((args && args.data) || "");
      if (!data) return snapshot(ctx);
      const taskId = String(args && args.taskId);
      const w = Number(args && args.w) || 0;
      const h = Number(args && args.h) || 0;
      const found = await ctx.storage.query("SELECT 1 AS ok FROM tasks WHERE id = ?", [taskId]);
      if (found.length > 0) {
        await ctx.storage.run(
          "INSERT INTO task_images (id, task_id, pos, w, h, data) VALUES (?, ?," +
            " (SELECT COALESCE(MAX(pos), 0) + 1 FROM task_images WHERE task_id = ?), ?, ?, ?)",
          [id, taskId, taskId, w, h, data]
        );
      }
      return snapshot(ctx);
    },

    async imageRemove(ctx, args) {
      const tasks = await loadTasks(ctx.storage);
      const id = String((args && args.id) || "");
      if (id) await ctx.storage.run("DELETE FROM task_images WHERE id = ?", [id]);
      return snapshot(ctx);
    },

    async imagesGet(ctx, args) {
      const ids: string[] = Array.isArray(args && args.ids) ? args.ids.map(String) : [];
      const out: Record<string, string> = {};
      if (ids.length === 0) return out;
      const marks = ids.map(function () { return "?"; }).join(", ");
      const rows = await ctx.storage.query(
        "SELECT id, data FROM task_images WHERE id IN (" + marks + ")",
        ids
      );
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i] as { id?: unknown; data?: unknown };
        if (typeof row.data === "string") out[String(row.id)] = row.data;
      }
      return out;
    },

    async reset(ctx) {
      const fresh = seed(todayKey());
      await ctx.storage.transaction(async function (tx) {
        await clearAllTasks(tx);
        for (let i = 0; i < fresh.length; i++) await insertTask(tx, fresh[i]);
      });
      await ctx.storage.kv().set(K_SEEDED, true);
      return snapshot(ctx);
    },

    async boardsAdd(ctx, args) {
      const name = validBoardName(args && args.name);
      const dup = await ctx.storage.query("SELECT id FROM boards WHERE name = ?", [name]);
      if (dup.length > 0) throw new Error("已有这个板块：" + name);
      const id = uid("b");
      const order = await nextBoardSort(ctx.storage);
      await ctx.storage.run(
        "INSERT INTO boards (id, name, sort_order, created_at) VALUES (?, ?, ?, ?)",
        [id, name, order, Date.now()]
      );
      return snapshot(ctx);
    },

    async boardsRename(ctx, args) {
      const id = String((args && args.id) || "");
      const name = validBoardName(args && args.name);
      const row = await ctx.storage.query("SELECT id FROM boards WHERE id = ?", [id]);
      if (row.length === 0) throw new Error("板块不存在");
      const dup = await ctx.storage.query("SELECT id FROM boards WHERE name = ? AND id != ?", [name, id]);
      if (dup.length > 0) throw new Error("已有这个板块：" + name);
      await ctx.storage.run("UPDATE boards SET name = ? WHERE id = ?", [name, id]);
      return snapshot(ctx);
    },

    async boardsRemove(ctx, args) {
      const id = String((args && args.id) || "");
      const row = await ctx.storage.query("SELECT id FROM boards WHERE id = ?", [id]);
      if (row.length === 0) throw new Error("板块不存在");
      const used = await ctx.storage.query("SELECT COUNT(*) AS n FROM tasks WHERE board_id = ?", [id]);
      const first = used[0] as { n?: unknown } | undefined;
      if (Number(first && first.n !== undefined ? first.n : 0) > 0) {
        throw new Error("板块里还有任务，先移走再删");
      }
      await ctx.storage.run("DELETE FROM boards WHERE id = ?", [id]);
      return snapshot(ctx);
    },

    /* ── 接入：外部数据源 ── */

    /** Connectors + boards + templates + host MCP servers, for the 接入 panel. */
    async connectorsList(ctx) {
      const connectors = await loadConnectors(ctx.storage);
      let mcpServers: Array<{ id: string; status: string; tools?: string[]; error?: { code: string; message?: string } }> = [];
      try {
        // includeAll: show failed ones so the picker can explain why a server is missing
        const listed = await ctx.mcpServers(true);
        mcpServers = (listed.servers || []).map(function (s) {
          return {
            id: s.id,
            status: s.status,
            tools: s.tools ? s.tools.slice() : undefined,
            error: s.error ? { code: s.error.code, message: s.error.message } : undefined,
          };
        });
      } catch (e) {
        // older host without mcpServers — UI falls back to free text
        ctx.log("mcpServers list failed", String((e as { message?: string }).message || e));
      }
      return {
        connectors: connectors,
        boards: await loadBoards(ctx.storage),
        templates: TEMPLATES,
        mcpServers: mcpServers,
      };
    },

    /** Debug: the raw shape a MCP tool returns (for choosing rootPath). */
    async connectorDebug(ctx, args) {
      const serverId = String((args && args.serverId) || "");
      const toolName = String((args && args.toolName) || "");
      if (!serverId || !toolName) throw new Error("serverId 和 toolName 都要填");
      const res = await ctx.mcp(serverId, toolName, (args && args.params) || {});
      let text: string;
      try {
        text = JSON.stringify(res);
      } catch (e) {
        text = String(res);
      }
      return { raw: text.slice(0, 600) };
    },

    /**
     * Pull up to 20 sample rows and answer everything the mapping editor needs:
     * roots (if not yet chosen), the aggregated field catalog, and mapped drafts.
     */
    async connectorSample(ctx, args) {
      const source = (args && args.source) as ConnectorSource | undefined;
      const params = (args && args.params && typeof args.params === "object" ? args.params : {}) as Record<string, unknown>;
      const rootPath = typeof (args && args.rootPath) === "string" ? (args as { rootPath: string }).rootPath : "";
      const mapping = (args && args.mapping) as ConnectorMapping | undefined;
      const rows = await fetchRows(ctx, source || { serverId: "", toolName: "" }, params, rootPath, 20);
      const roots = detectRoots(rows);
      const catalog = buildCatalog(rows);
      const today = todayKey();
      const drafts = rows.slice(0, 8).map(function (r) {
        return evalMapping(mapping || { externalId: { const: "" }, title: { const: "" } }, r, today);
      });
      return {
        count: rows.length,
        roots: roots,
        rootPath: rootPath || roots[0] || "",
        catalog: catalog,
        drafts: drafts,
        rows: rows.slice(0, 8),
      };
    },

    async connectorSave(ctx, args) {
      const c = (args && args.connector) as Partial<Connector> | undefined;
      if (!c || !c.name || !String(c.name).trim()) throw new Error("连接器还差个名字");
      const kind: ConnectorKind = c.kind === "http" ? "http" : "mcp";
      if (!c.source || !("serverId" in (c.source as object) || "url" in (c.source as object))) {
        throw new Error("数据源没配完整");
      }
      const mapping = c.mapping || { externalId: { const: "" }, title: { const: "" } };
      if (!mapping.externalId || !mapping.title) throw new Error("至少映射出唯一键和标题");
      const options = Object.assign({ boardId: "default", syncDone: true, keepDeleted: true }, c.options || {});
      if (options.boardId && options.boardId !== "default") {
        const found = await ctx.storage.query("SELECT id FROM boards WHERE id = ?", [options.boardId]);
        if (found.length === 0) throw new Error("目标板块不存在，重新选一个");
      }
      const id = typeof c.id === "string" && c.id ? c.id : connectorUid();
      const existing = await loadConnector(ctx.storage, id);
      if (existing) {
        await ctx.storage.run(
          "UPDATE connectors SET name = ?, kind = ?, source = ?, params = ?, root_path = ?, mapping = ?, options = ? WHERE id = ?",
          [
            String(c.name).trim(),
            kind,
            JSON.stringify(c.source),
            JSON.stringify(c.params || {}),
            String(c.rootPath || ""),
            JSON.stringify(mapping),
            JSON.stringify(options),
            id,
          ]
        );
      } else {
        await ctx.storage.run(
          "INSERT INTO connectors (id, name, kind, source, params, root_path, mapping, options, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            id,
            String(c.name).trim(),
            kind,
            JSON.stringify(c.source),
            JSON.stringify(c.params || {}),
            String(c.rootPath || ""),
            JSON.stringify(mapping),
            JSON.stringify(options),
            Date.now(),
          ]
        );
      }
      const connectors = await loadConnectors(ctx.storage);
      return { connectors: connectors, boards: await loadBoards(ctx.storage), templates: TEMPLATES };
    },

    async connectorRemove(ctx, args) {
      const id = String((args && args.id) || "");
      if (!id) throw new Error("缺少连接器");
      await ctx.storage.transaction(async function (tx) {
        await tx.run("DELETE FROM task_links WHERE connector_id = ?", [id]);
        await tx.run("DELETE FROM connectors WHERE id = ?", [id]);
      });
      const connectors = await loadConnectors(ctx.storage);
      return { connectors: connectors, boards: await loadBoards(ctx.storage), templates: TEMPLATES };
    },

    /**
     * Sync a connector. `limit` > 0 = 试运行 (import only the first N).
     * Returns the pack so the store refreshes, plus a run summary.
     */
    async connectorRun(ctx, args) {
      const id = String((args && args.id) || "");
      const limit = Number(args && args.limit) || 0;
      const connector = await loadConnector(ctx.storage, id);
      if (!connector) throw new Error("连接器不存在");
      const boardIds = new Set(
        (await ctx.storage.query("SELECT id FROM boards")).map(function (r) { return String(r.id); })
      );
      const rows = await fetchRows(ctx, connector.source, connector.params, connector.rootPath, limit > 0 ? limit : 200);
      const today = todayKey();
      const drafts = rows.map(function (r) { return evalMapping(connector.mapping, r, today); });
      const result = await ctx.storage.transaction(async function (tx) {
        return await upsertDrafts(tx, {
          insertTask: function (t) { return insertTask(tx, t); },
          loadTask: function (tid) { return loadTask(tx, tid); },
          persistTask: function (t) { return persistTask(tx, t); },
        }, connector, drafts, function (bid) { return bid === "default" || boardIds.has(bid); });
      });
      const summary =
        "新增 " + String(result.added) + " · 更新 " + String(result.updated) + " · 跳过 " + String(result.skipped) +
        (result.errors.length ? " · " + result.errors[0] : "");
      await ctx.storage.run("UPDATE connectors SET last_run_at = ?, last_run_result = ? WHERE id = ?", [
        Date.now(),
        summary,
        id,
      ]);
      const pack = await snapshot(ctx);
      return Object.assign(pack, { summary: summary, added: result.added, updated: result.updated, skipped: result.skipped });
    },
  },
});
