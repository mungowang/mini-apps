/**
 * Connector engine — pure, shared by UI and backend.
 *
 * The contract: rawRows --mapping--> TaskDraft. Everything a connector
 * knows about a source is data (source/params/rootPath/mapping/options),
 * so adding a source never touches code.
 *
 * UI imports: getPath, buildCatalog, detectRoots, evalMapping for live preview.
 * Backend imports the same for the real run.
 */
import { shiftKey, weekSpan } from "./model";

/* ───────────────────────── types ───────────────────────── */

/** One token inside a template: literal text or a raw field path. */
export type TplToken = { lit?: string; field?: string };

/**
 * ValueSpec — how one task slot gets its value.
 * - const: fixed value ("next-monday", "3", text)
 * - field: take a raw path, optional enum/date transform
 * - template: interpolate tokens
 */
export type ValueSpec =
  | { const: string }
  | { field: string; transform?: "enum" | "date"; map?: Record<string, string> }
  | { template: TplToken[] };

export type ConnectorSource =
  | { serverId: string; toolName: string }
  | { url: string; method?: string; headers?: Record<string, string> };

export type ConnectorOptions = {
  /** Board imported tasks land in. "default" or a board id. Set on create; sync never moves it. */
  boardId: string;
  /** Remote-closed records mark their kedu task done (never reopen). */
  syncDone: boolean;
};

export type ConnectorMapping = {
  /** Uniqueness key inside the source (Jira key, issue number). Required for dedupe. */
  externalId: ValueSpec;
  title: ValueSpec;
  priority?: ValueSpec;
  starts?: ValueSpec;
  due?: ValueSpec;
  notes?: ValueSpec;
  tags?: TplToken[];
  subtasks?: ValueSpec;
  /** Optional: raw value that reads as done/closed ("Done", "Resolved", true). */
  done?: ValueSpec;
};

export type ConnectorKind = "mcp" | "http";

export type Connector = {
  id: string;
  name: string;
  kind: ConnectorKind;
  source: ConnectorSource;
  params: Record<string, unknown>;
  /** Path of the record list inside the response: "issues[]", "values[]", "" ($ = response root). */
  rootPath: string;
  mapping: ConnectorMapping;
  options: ConnectorOptions;
  createdAt: number;
  lastRunAt: number | null;
  lastRunResult: string | null;
};

/** One aggregated field in the catalog built from sample rows. */
export type CatalogEntry = {
  path: string;
  type: "str" | "num" | "bool" | "date" | "enum" | "arr";
  cov: number;
  total: number;
  samples: string[];
};

export type TaskDraft = {
  externalId: string;
  title: string;
  notes?: string;
  priority?: 1 | 2 | 3 | 4;
  starts?: string;
  due?: string;
  tags?: string[];
  subtasks?: string[];
  done?: boolean;
};

/** Built-in starting points for the wizard. Pure JSON, editable after pick. */
export type ConnectorTemplate = {
  id: string;
  name: string;
  description: string;
  connector: {
    name: string;
    kind: ConnectorKind;
    source: ConnectorSource;
    params: Record<string, unknown>;
    rootPath: string;
    mapping: ConnectorMapping;
    options: ConnectorOptions;
  };
};

/* ───────────────────────── path access ───────────────────────── */

/** Read a catalog path ("fields.priority.name", "fields.subtasks[]") off a record. */
export function getPath(rec: unknown, path: string): unknown {
  if (!path) return undefined;
  const m = path.match(/^(.+?)(\[\])?$/);
  if (!m) return undefined;
  let cur: unknown = rec;
  for (const part of m[1].split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  if (m[2] && Array.isArray(cur)) {
    return (cur as unknown[]).map(function (x) {
      if (x !== null && typeof x === "object") {
        const o = x as Record<string, unknown>;
        // Jira-style subtask objects: prefer fields.summary
        const f = o.fields as Record<string, unknown> | undefined;
        if (f && typeof f === "object" && typeof f.summary === "string") return f.summary;
        if (typeof o.name === "string") return o.name;
        if (typeof o.title === "string") return o.title;
      }
      return String(x);
    });
  }
  return cur;
}

/* ───────────────────────── catalog ───────────────────────── */

function isDateString(v: unknown): boolean {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v);
}

function flattenInto(v: unknown, prefix: string, out: Array<[string, unknown]>, depth: number): void {
  if (v === null || typeof v !== "object") {
    out.push([prefix, v]);
    return;
  }
  if (depth >= 4) {
    out.push([prefix, "[已折叠]"]);
    return;
  }
  if (Array.isArray(v)) {
    if (v.length && typeof v[0] === "object" && v[0] !== null) {
      flattenInto(v[0], prefix + "[]", out, depth + 1);
    } else if (v.length) {
      out.push([prefix + "[]", v[0]]);
    }
    return;
  }
  for (const k of Object.keys(v as Record<string, unknown>)) {
    flattenInto((v as Record<string, unknown>)[k], prefix ? prefix + "." + k : k, out, depth + 1);
  }
}

/** Flatten every record, aggregate per-path coverage / type / distinct values. */
export function buildCatalog(rows: unknown[]): CatalogEntry[] {
  const agg = new Map<string, { count: number; types: Set<string>; values: string[]; seen: Set<string> }>();
  for (let i = 0; i < rows.length; i++) {
    const leaves: Array<[string, unknown]> = [];
    flattenInto(rows[i], "", leaves, 0);
    const seen = new Set<string>();
    for (let j = 0; j < leaves.length; j++) {
      const path = leaves[j][0];
      if (seen.has(path)) continue;
      seen.add(path);
      let e = agg.get(path);
      if (!e) {
        e = { count: 0, types: new Set(), values: [], seen: new Set() };
        agg.set(path, e);
      }
      const val = leaves[j][1];
      e.count += 1;
      e.types.add(val === null ? "null" : Array.isArray(val) ? "arr" : typeof val);
      if (val !== null && typeof val !== "object") {
        const s = String(val);
        if (!e.seen.has(s) && e.seen.size < 16) {
          e.seen.add(s);
          if (e.values.length < 8) e.values.push(s);
        }
      }
    }
  }
  const out: CatalogEntry[] = [];
  agg.forEach(function (e, path) {
    let type: CatalogEntry["type"] = "str";
    const distinct = e.values;
    if (e.types.has("arr")) type = "arr";
    else if (distinct.length > 0 && distinct.every(isDateString)) type = "date";
    else if (distinct.length > 0 && distinct.length <= 8 && e.count === rows.length) type = "enum";
    else if (e.types.has("number")) type = "num";
    else if (e.types.has("boolean")) type = "bool";
    out.push({ path: path, type: type, cov: e.count, total: rows.length, samples: distinct.slice(0, 4) });
  });
  out.sort(function (a, b) {
    return b.cov - a.cov || a.path.localeCompare(b.path);
  });
  return out;
}

/** Where a record list might live inside a sample response. */
export function detectRoots(sample: unknown): string[] {
  const roots: string[] = [];
  function walk(v: unknown, prefix: string, depth: number): void {
    if (v === null || typeof v !== "object" || depth >= 3) return;
    if (Array.isArray(v)) {
      if (v.length && typeof v[0] === "object" && v[0] !== null) roots.push(prefix + "[]");
      return;
    }
    for (const k of Object.keys(v as Record<string, unknown>)) {
      walk((v as Record<string, unknown>)[k], prefix ? prefix + "." + k : k, depth + 1);
    }
  }
  walk(sample, "", 0);
  if (roots.length === 0) roots.push("");
  return roots.slice(0, 6);
}

/* ───────────────────────── mapping evaluation ───────────────────────── */

function evalToken(rec: unknown, token: TplToken | undefined): string {
  if (!token) return "";
  if (token.lit !== undefined) return token.lit;
  if (token.field !== undefined) {
    const v = getPath(rec, token.field);
    if (v === undefined || v === null) return "";
    return Array.isArray(v) ? v.join(", ") : String(v);
  }
  return "";
}

/** "2026-10-24T16:00:00.000+0800" -> "2026-10-24". */
export function datePart(v: string): string {
  const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

/**
 * Resolve a fixed date against today. Supports "today", "+3d", "-2d",
 * "next-monday", "this-week" (fills starts+due), "next-week".
 * Absolute YYYY-MM-DD passes through. Returns null when not a date at all.
 */
export function resolveConstDate(raw: string, today: string): { starts: string | null; due: string } | null {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { starts: null, due: v };
  if (v === "today") return { starts: null, due: today };
  const rel = v.match(/^([+-])(\d+)d$/);
  if (rel) {
    const n = Number(rel[2]);
    return { starts: null, due: shiftKey(today, rel[1] === "-" ? -n : n) };
  }
  if (v === "this-week") {
    const span = weekSpan(today, "this");
    return { starts: span.starts, due: span.due };
  }
  if (v === "next-week") {
    const span = weekSpan(today, "next");
    return { starts: span.starts, due: span.due };
  }
  if (v === "next-monday") {
    const span = weekSpan(today, "next");
    return { starts: null, due: span.starts };
  }
  return null;
}

const DONE_WORDS = new Set(["done", "closed", "resolved", "complete", "completed", "true", "1", "已完成", "完成", "已关闭"]);

export function evalSpec(rec: unknown, spec: ValueSpec | undefined): string {
  if (!spec) return "";
  if (typeof (spec as { const?: unknown }).const === "string") return (spec as { const: string }).const;
  const f = spec as { field?: string; transform?: string; map?: Record<string, string> };
  if (typeof f.field === "string") {
    const v = getPath(rec, f.field);
    if (v === undefined || v === null) return "";
    const s = Array.isArray(v) ? v.join("\n") : String(v);
    if (f.transform === "date") return datePart(s);
    if (f.transform === "enum" && f.map) {
      const hit = f.map[s];
      return hit !== undefined ? hit : "";
    }
    return s;
  }
  const t = (spec as { template?: TplToken[] }).template;
  if (Array.isArray(t)) return t.map(function (tok) { return evalToken(rec, tok); }).join("");
  return "";
}

function evalPrio(rec: unknown, spec: ValueSpec | undefined): 1 | 2 | 3 | 4 {
  const n = Number(evalSpec(rec, spec));
  return n === 1 || n === 2 || n === 3 || n === 4 ? (n as 1 | 2 | 3 | 4) : 3;
}

/** The whole connector pipeline for one record. */
export function evalMapping(mapping: ConnectorMapping, rec: unknown, today: string): TaskDraft {
  const draft: TaskDraft = {
    externalId: evalSpec(rec, mapping.externalId).trim(),
    title: evalSpec(rec, mapping.title).trim(),
  };
  if (mapping.notes) draft.notes = evalSpec(rec, mapping.notes).trim() || undefined;
  if (mapping.priority) draft.priority = evalPrio(rec, mapping.priority);
  if (mapping.due) {
    const spec = mapping.due;
    if (typeof (spec as { const?: unknown }).const === "string") {
      const r = resolveConstDate((spec as { const: string }).const, today);
      if (r) {
        draft.due = r.due;
        if (r.starts) draft.starts = r.starts;
      }
    } else {
      const d = datePart(evalSpec(rec, spec));
      if (d) draft.due = d;
    }
  }
  if (mapping.starts) {
    const spec = mapping.starts;
    if (typeof (spec as { const?: unknown }).const === "string") {
      const r = resolveConstDate((spec as { const: string }).const, today);
      if (r) draft.starts = r.starts || r.due;
    } else {
      const d = datePart(evalSpec(rec, spec));
      if (d) draft.starts = d;
    }
  }
  // A from without a to does not span; single-day tasks keep starts = due.
  if (draft.starts && !draft.due) draft.due = draft.starts;
  if (Array.isArray(mapping.tags)) {
    draft.tags = mapping.tags
      .map(function (tok) { return evalToken(rec, tok); })
      .map(function (s) { return s.trim(); })
      .filter(Boolean)
      .slice(0, 8);
  }
  if (mapping.subtasks) {
    const v = getPath(rec, (mapping.subtasks as { field?: string }).field || "");
    if (Array.isArray(v)) {
      draft.subtasks = v.map(String).filter(Boolean).slice(0, 32);
    } else if (typeof (mapping.subtasks as { const?: unknown }).const === "string") {
      const c = (mapping.subtasks as { const: string }).const;
      draft.subtasks = c ? [c] : undefined;
    }
  }
  if (mapping.done) {
    const s = evalSpec(rec, mapping.done).trim().toLowerCase();
    if (s && DONE_WORDS.has(s)) draft.done = true;
  }
  return draft;
}
