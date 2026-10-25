import type { Storage } from "./store";
import type { Task } from "../shared/types";
import type {
  Connector,
  ConnectorMapping,
  ConnectorSource,
  ConnectorTemplate,
  TaskDraft,
  ValueSpec,
} from "../shared/connectors";
import { detectRoots, getPath } from "../shared/connectors";
import { JIRA_MAPPING } from "../shared/dialects";

/**
 * Connector backend: fetch, persist, upsert. The pure evaluation engine
 * (catalog / mapping) lives in shared/connectors.ts so the UI preview and
 * the real run share one implementation.
 */

/* ───────────────────────── fetch ───────────────────────── */

export type FetchCtx = {
  mcp(serverId: string, toolName: string, args?: unknown): Promise<unknown>
  http(url: string, opts?: Record<string, unknown>): Promise<{ ok: boolean; status: number; json?: unknown; text?: string }>
}

function extractList(payload: unknown, rootPath: string): unknown[] {
  if (!rootPath || rootPath === "$") {
    return Array.isArray(payload) ? payload : [];
  }
  const path = rootPath.replace(/\[\]$/, "");
  const v = getPath(payload, path);
  return Array.isArray(v) ? v : [];
}

/**
 * Unwrap MCP tool results: content[].text -> JSON.parse, then single-key
 * JSON-string wrappers like {json_string: "<json>"} (the Jira tool does both).
 */
export function unwrapMcp(res: unknown): unknown {
  let payload: unknown = res;
  // ctx.mcp may hand back the tool text as a plain string: parse it.
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch (e) {
      /* not JSON; nothing to unwrap */
    }
  }
  if (payload && typeof payload === "object" && Array.isArray((payload as { content?: unknown }).content)) {
    const first = (payload as { content: Array<{ text?: unknown }> }).content[0];
    if (first && typeof first.text === "string") {
      try {
        payload = JSON.parse(first.text);
      } catch (e) {
        /* keep the text; it is not JSON */
      }
    }
  }
  for (let i = 0; i < 2; i++) {
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const keys = Object.keys(payload as Record<string, unknown>);
      if (keys.length === 1) {
        const v = (payload as Record<string, unknown>)[keys[0]];
        if (typeof v === "string") {
          let parsed: unknown;
          try {
            parsed = JSON.parse(v);
          } catch (e) {
            break;
          }
          payload = parsed;
          continue;
        }
      }
    }
    break;
  }
  return payload;
}

/** Pull up to `limit` rows from the source. Throws with a readable message on failure. */
export async function fetchRows(
  ctx: FetchCtx,
  source: ConnectorSource | undefined,
  params: Record<string, unknown>,
  rootPath: string,
  limit: number
): Promise<unknown[]> {
  if (!source) throw new Error("数据源没配完整");
  if ("serverId" in source && source.serverId) {
    if (!source.toolName) throw new Error("还差工具名");
    const res = await ctx.mcp(source.serverId, source.toolName, params);
    const payload = unwrapMcp(res);
    let list = extractList(payload, rootPath);
    if (!list.length && !Array.isArray(payload)) {
      const roots = detectRoots(payload);
      for (let i = 0; i < roots.length; i++) {
        const tryList = extractList(payload, roots[i]);
        if (tryList.length) {
          list = tryList;
          break;
        }
      }
    }
    return list.slice(0, limit);
  }
  if ("url" in source && source.url) {
    const method = (source.method || "GET").toUpperCase();
    let url = source.url;
    let body: string | undefined;
    if (method === "GET" && params && Object.keys(params).length) {
      const qs = Object.keys(params)
        .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(String(params[k])); })
        .join("&");
      url = url + (url.indexOf("?") >= 0 ? "&" : "?") + qs;
    } else {
      body = JSON.stringify(params || {});
    }
    const res = await ctx.http(url, { method: method, body: body, headers: source.headers });
    if (!res.ok) throw new Error("HTTP " + String(res.status) + (res.text ? "：" + res.text.slice(0, 140) : ""));
    return extractList(res.json, rootPath).slice(0, limit);
  }
  throw new Error("数据源没配完整");
}

/* ───────────────────────── storage ───────────────────────── */

type Row = Record<string, unknown>;

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    return fallback;
  }
}

export function rowToConnector(r: Row): Connector {
  return {
    id: String(r.id),
    name: String(r.name ?? ""),
    kind: r.kind === "http" ? "http" : "mcp",
    source: parseJson<ConnectorSource>(r.source, { serverId: "", toolName: "" }),
    params: parseJson<Record<string, unknown>>(r.params, {}),
    rootPath: typeof r.root_path === "string" ? r.root_path : "",
    mapping: parseJson<ConnectorMapping>(r.mapping, { externalId: { const: "" }, title: { const: "" } }),
    options: parseJson(r.options, { boardId: "default", syncDone: true, keepDeleted: true }),
    createdAt: Number(r.created_at) || 0,
    lastRunAt: r.last_run_at == null ? null : Number(r.last_run_at),
    lastRunResult: r.last_run_result == null ? null : String(r.last_run_result),
  };
}

export async function loadConnectors(store: Storage): Promise<Connector[]> {
  const rows = await store.query("SELECT * FROM connectors ORDER BY created_at");
  return rows.map(rowToConnector);
}

export async function loadConnector(store: Storage, id: string): Promise<Connector | null> {
  const rows = await store.query("SELECT * FROM connectors WHERE id = ?", [id]);
  return rows.length ? rowToConnector(rows[0]) : null;
}

export function connectorUid(): string {
  return "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ───────────────────────── upsert ───────────────────────── */

/**
 * A date slot filled with a fixed preset is decided once, at import time — it is
 * not data from the source. So it must not enter the content hash, or a rolling
 * preset ("today", "this-week") would look like a change every day and rewrite
 * the task on every sync. Slots that read a field keep participating exactly as
 * before, which leaves every other connector untouched.
 */
function isFixedDateSpec(spec: ValueSpec | undefined): boolean {
  return Boolean(spec && typeof (spec as { const?: unknown }).const === "string");
}

function draftHash(d: TaskDraft, mapping?: ConnectorMapping): string {
  const fixedStarts = mapping ? isFixedDateSpec(mapping.starts) : false;
  const fixedDue = mapping ? isFixedDateSpec(mapping.due) : false;
  return JSON.stringify([
    d.title,
    d.notes || "",
    d.priority || 0,
    fixedStarts ? "" : d.starts || "",
    fixedDue ? "" : d.due || "",
    (d.tags || []).join(","),
    (d.subtasks || []).join("␟"),
  ]);
}

export type UpsertDeps = {
  insertTask(t: Task): Promise<void>
  loadTask(id: string): Promise<Task | null>
  persistTask(t: Task): Promise<void>
}

export type UpsertResult = { added: number; updated: number; skipped: number; errors: string[] };

/**
 * Sync drafts into tasks via task_links.
 * - tombstoned links (local delete) stay deleted
 * - existing links: update content fields only; board stays local, done may set, never reopen
 * - new records: create with options.boardId
 */
export async function upsertDrafts(
  store: Storage,
  deps: UpsertDeps,
  connector: Connector,
  drafts: TaskDraft[],
  boardExists: (id: string) => boolean
): Promise<UpsertResult> {
  const out: UpsertResult = { added: 0, updated: 0, skipped: 0, errors: [] };
  const targetBoard = boardExists(connector.options.boardId) ? connector.options.boardId : "default";
  const now = Date.now();

  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];
    if (!d.externalId || !d.title) {
      out.skipped += 1;
      out.errors.push("第 " + String(i + 1) + " 条缺唯一键或标题，跳过");
      continue;
    }
    try {
      const linkRows = await store.query(
        "SELECT task_id, raw_hash, deleted_at FROM task_links WHERE connector_id = ? AND external_id = ?",
        [connector.id, d.externalId]
      );
      if (linkRows.length) {
        const link = linkRows[0] as { task_id: unknown; raw_hash: unknown; deleted_at: unknown };
        if (link.deleted_at != null) {
          if (connector.options.keepDeleted !== false) {
            out.skipped += 1;
            continue; // keepDeleted on: do not resurrect
          }
          // keepDeleted off: drop the tombstone and fall through to create-as-new below.
          await store.run("DELETE FROM task_links WHERE connector_id = ? AND external_id = ?", [connector.id, d.externalId]);
        } else {
        const taskId = String(link.task_id);
        const task = await deps.loadTask(taskId);
        if (!task) {
          out.skipped += 1;
          continue;
        }
        const hash = draftHash(d, connector.mapping);
        if (String(link.raw_hash || "") !== hash) {
          // A fixed date was set when the task was created; a later content
          // change must not pull it forward to today.
          const fixedStarts = isFixedDateSpec(connector.mapping.starts);
          const fixedDue = isFixedDateSpec(connector.mapping.due);
          const next: Task = {
            id: task.id,
            title: d.title.slice(0, 200),
            notes: d.notes || "",
            done: task.done,
            priority: d.priority || 3,
            tags: d.tags || [],
            boardId: task.boardId,
            starts: fixedStarts ? task.starts : d.starts || null,
            due: fixedDue ? task.due : d.due || null,
            startTime: task.startTime,
            endTime: task.endTime,
            subtasks: (d.subtasks || []).map(function (t, k) {
              return { id: task.id + "_s" + String(k) + "_" + Math.random().toString(36).slice(2, 6), title: t, done: false, completedAt: null };
            }),
            images: task.images,
            order: task.order,
            createdAt: task.createdAt,
            completedAt: task.completedAt,
            doing: task.doing,
            doingAt: task.doingAt,
          };
          await deps.persistTask(next);
          await store.run(
            "UPDATE task_links SET raw_hash = ? WHERE connector_id = ? AND external_id = ?",
            [hash, connector.id, d.externalId]
          );
        }
        if (connector.options.syncDone && d.done && !task.done) {
          await store.run("UPDATE tasks SET done = 1, completed_at = ?, doing = 0, doing_at = NULL WHERE id = ?", [now, taskId]);
        }
        out.updated += 1;
        continue;
        }
      }
      {
        const taskId = "t_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        const created: Task = {
          id: taskId,
          title: d.title.slice(0, 200),
          notes: d.notes || "",
          done: Boolean(d.done),
          priority: d.priority || 3,
          tags: d.tags || [],
          boardId: targetBoard === "default" ? null : targetBoard,
          starts: d.starts || null,
          due: d.due || null,
          startTime: null,
          endTime: null,
          subtasks: (d.subtasks || []).map(function (t, k) {
            return { id: taskId + "_s" + String(k), title: t, done: false, completedAt: null };
          }),
          images: [],
          order: 0,
          createdAt: now,
          completedAt: d.done ? now : null,
          doing: false,
          doingAt: null,
        };
        await deps.insertTask(created);
        await store.run(
          "INSERT INTO task_links (connector_id, external_id, task_id, raw_hash, deleted_at) VALUES (?, ?, ?, ?, NULL)",
          [connector.id, d.externalId, taskId, draftHash(d, connector.mapping)]
        );
        out.added += 1;
      }
    } catch (e) {
      out.errors.push(String((e as { message?: string }).message || e));
    }
  }
  return out;
}

/** When the user deletes a linked task, tombstone its link so sync will not bring it back. */
export async function tombstoneTaskLinks(store: Storage, taskId: string): Promise<void> {
  await store.run(
    "UPDATE task_links SET deleted_at = ? WHERE task_id = ? AND deleted_at IS NULL",
    [Date.now(), taskId]
  );
}

/* ───────────────────────── templates ───────────────────────── */

export const TEMPLATES: ConnectorTemplate[] = [
  {
    id: "jira-mcp",
    name: "Jira（MCP）",
    description: "接入本机任意 Jira MCP server：自动认出搜索工具，用 JQL 圈范围，字段点选映射。",
    // The template declares what it is. The server, the tool and the parameters
    // are resolved from the live schema, so this works for any Jira MCP server
    // and never ships a parameter the tool would reject.
    hints: { dialect: "jira" },
    connector: {
      name: "工作 Jira",
      kind: "mcp",
      source: { serverId: "", toolName: "" },
      params: {},
      rootPath: "issues[]",
      mapping: JIRA_MAPPING,
      options: { boardId: "default", syncDone: true, keepDeleted: true },
    },
  },
  {
    id: "github-issues",
    name: "GitHub Issues",
    description: "REST 拉取指派给你的 open issues。",
    connector: {
      name: "GitHub",
      kind: "http",
      source: {
        url: "https://api.github.com/issues",
        method: "GET",
        headers: { Accept: "application/vnd.github+json" },
      },
      params: { filter: "assigned", state: "open", per_page: "50" },
      rootPath: "$",
      mapping: {
        externalId: { template: [{ field: "id" }] },
        title: { template: [{ field: "title" }] },
        notes: { field: "body" },
        tags: [{ lit: "github" }],
      },
      options: { boardId: "default", syncDone: false, keepDeleted: true },
    },
  },
  {
    id: "blank",
    name: "空白",
    description: "任何 JSON 列表：选一个 MCP 工具，或填一个 URL。",
    connector: {
      name: "",
      kind: "mcp",
      source: { serverId: "", toolName: "" },
      params: {},
      rootPath: "",
      mapping: { externalId: { const: "" }, title: { const: "" } },
      options: { boardId: "default", syncDone: true, keepDeleted: true },
    },
  },
];
