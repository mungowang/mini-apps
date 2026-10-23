import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button, Kbd, toast } from "@mohou/ui";

import type {
  CatalogEntry,
  Connector,
  ConnectorKind,
  ConnectorMapping,
  ConnectorSource,
  ConnectorTemplate,
  TaskDraft,
  TplToken,
  ValueSpec,
} from "../shared/connectors";
import { evalMapping } from "../shared/connectors";
import { useStore } from "./store";

const EASE = [0.16, 1, 0.3, 1] as const;

function useReducedMotion(): boolean {
  const [reduce, setReduce] = React.useState(false);
  React.useEffect(function () {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    function apply() {
      setReduce(mq.matches);
    }
    apply();
    mq.addEventListener("change", apply);
    return function () {
      mq.removeEventListener("change", apply);
    };
  }, []);
  return reduce;
}

/* ───────────────────────── wizard state ───────────────────────── */

type Draft = {
  id: string;
  name: string;
  kind: ConnectorKind;
  serverId: string;
  toolName: string;
  url: string;
  method: string;
  params: Record<string, unknown>;
  rootPath: string;
  mapping: ConnectorMapping;
  boardId: string;
  syncDone: boolean;
  keepDeleted: boolean;
};

function draftFromTemplate(t: ConnectorTemplate): Draft {
  const c = t.connector;
  const src = c.source;
  return {
    id: "",
    name: c.name,
    kind: c.kind,
    serverId: "serverId" in src ? src.serverId : "",
    toolName: "serverId" in src ? src.toolName : "",
    url: "url" in src ? src.url : "",
    method: "url" in src && src.method ? src.method : "GET",
    params: Object.assign({}, c.params),
    rootPath: c.rootPath,
    mapping: JSON.parse(JSON.stringify(c.mapping)),
    boardId: c.options.boardId,
    syncDone: c.options.syncDone,
    keepDeleted: c.options.keepDeleted !== false,
  };
}

function draftFromConnector(c: Connector): Draft {
  const src = c.source;
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    serverId: "serverId" in src ? src.serverId : "",
    toolName: "serverId" in src ? src.toolName : "",
    url: "url" in src ? src.url : "",
    method: "url" in src && src.method ? src.method : "GET",
    params: Object.assign({}, c.params),
    rootPath: c.rootPath,
    mapping: JSON.parse(JSON.stringify(c.mapping)),
    boardId: c.options.boardId,
    syncDone: c.options.syncDone,
    keepDeleted: c.options.keepDeleted !== false,
  };
}

function draftSource(d: Draft): ConnectorSource {
  if (d.kind === "mcp") return { serverId: d.serverId, toolName: d.toolName };
  return { url: d.url, method: d.method };
}

type SampleState = {
  loading: boolean;
  error: string | null;
  count: number;
  roots: string[];
  catalog: CatalogEntry[];
  rows: unknown[];
};

const EMPTY_SAMPLE: SampleState = { loading: false, error: null, count: 0, roots: [], catalog: [], rows: [] };

/** 参数名提示：按 kind / 模板给常用键。 */
const PARAM_HINTS: Record<string, { name: string; note: string }[]> = {
  jira: [
    { name: "jql", note: "圈范围，如 assignee = currentUser() AND statusCategory != Done" },
    { name: "num_results", note: "拉多少条" },
    { name: "fields", note: "要哪些字段，一行一个（summary / priority / status / duedate …）" },
  ],
  http: [
    { name: "state", note: "GitHub 等常用" },
    { name: "per_page", note: "每页条数" },
  ],
};

/* ───────────────────────── small pieces ───────────────────────── */

function StepChip(props: { n: number; label: string; on: boolean; done: boolean; go: () => void }) {
  return (
    <button
      type="button"
      disabled={props.on || !props.done}
      onClick={props.go}
      className={
        "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors " +
        (props.on
          ? "border-border bg-muted text-foreground"
          : props.done
            ? "text-foreground hover:bg-muted"
            : "border-transparent text-muted-foreground/50")
      }
    >
      <span
        className={
          "grid size-4 place-items-center rounded-full text-[10px] " +
          (props.on ? "bg-foreground text-background" : props.done ? "bg-foreground/80 text-background" : "bg-muted text-muted-foreground")
        }
      >
        {props.done ? "✓" : String(props.n)}
      </span>
      {props.label}
    </button>
  );
}

function FieldChip(props: { path: string; onRemove?: () => void }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-[11px]">
      <span className="truncate">{props.path}</span>
      {props.onRemove ? (
        <button type="button" aria-label="移除" onClick={props.onRemove} className="text-muted-foreground hover:text-foreground">
          ✕
        </button>
      ) : null}
    </span>
  );
}

function SegBtn(props: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={"rounded-md px-2 py-1 text-[11.5px] transition-colors " + (props.on ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}
    >
      {props.label}
    </button>
  );
}

function Labeled(props: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs text-muted-foreground">{props.label}</span>
      {props.children}
    </label>
  );
}

const inputCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus:border-foreground placeholder:text-muted-foreground";

/* ───────────────────────── slot model ───────────────────────── */

type SlotId = "externalId" | "title" | "priority" | "dates" | "notes" | "tags" | "subtasks";

const SLOTS: { id: SlotId; label: string; required?: boolean }[] = [
  { id: "externalId", label: "唯一键", required: true },
  { id: "title", label: "标题", required: true },
  { id: "priority", label: "优先级" },
  { id: "dates", label: "日期", hint: "from / to" },
  { id: "notes", label: "备注" },
  { id: "tags", label: "标签" },
  { id: "subtasks", label: "子任务" },
];

/**
 * Which slot the catalog clicks land in. `sub` only matters for dates
 * (due / starts); the slot row stays open while its sub-row is armed.
 */
type Active =
  | { slot: "title" | "externalId" }
  | { slot: "priority" | "notes" | "subtasks" | "tags" }
  | { slot: "dates"; sub: "due" | "starts" };

function specFilled(spec: ValueSpec | TplToken[] | undefined): boolean {
  if (!spec) return false;
  if (Array.isArray(spec)) return spec.length > 0;
  if (typeof (spec as { const?: unknown }).const === "string") return Boolean((spec as { const: string }).const);
  const f = (spec as { field?: string }).field;
  if (typeof f === "string") return Boolean(f);
  const t = (spec as { template?: TplToken[] }).template;
  if (Array.isArray(t)) return t.length > 0;
  return false;
}

function slotFilled(d: Draft, id: SlotId): boolean {
  const m = d.mapping;
  if (id === "externalId") return specFilled(m.externalId);
  if (id === "title") return specFilled(m.title);
  if (id === "priority") return specFilled(m.priority);
  if (id === "dates") return specFilled(m.due) || specFilled(m.starts);
  if (id === "notes") return specFilled(m.notes);
  if (id === "tags") return specFilled(m.tags);
  if (id === "subtasks") return specFilled(m.subtasks);
  return false;
}

/* ───────────────────────── slot editor ───────────────────────── */

function SlotEditor(props: {
  slot: SlotId;
  draft: Draft;
  catalog: CatalogEntry[];
  active: Active | null;
  setActive: (a: Active | null) => void;
  patch: (fn: (d: Draft) => void) => void;
}) {
  const { slot, draft, catalog, active, setActive, patch } = props;
  const m = draft.mapping;

  if (slot === "externalId" || slot === "title") {
    const spec = (slot === "title" ? m.title : m.externalId) as ValueSpec;
    const tokens = "template" in spec && Array.isArray(spec.template) ? spec.template : [];
    const setSpec = function (s: ValueSpec) {
      patch(function (d) {
        if (slot === "title") d.mapping.title = s as ConnectorMapping["title"];
        else d.mapping.externalId = s as ConnectorMapping["externalId"];
      });
    };
    return (
      <div>
        <div className="mb-2 inline-flex overflow-hidden rounded-md border border-border">
          <SegBtn on label="模板" onClick={function () { setActive({ slot: slot }); }} />
          <SegBtn
            on={"const" in spec}
            label="固定值"
            onClick={function () { setSpec({ const: "" }); }}
          />
        </div>
        {"const" in spec ? (
          <input
            value={spec.const}
            onChange={function (e) { setSpec({ const: e.target.value }); }}
            className={inputCls + " h-8"}
            placeholder={slot === "title" ? "所有任务同一标题（一般不建议）" : "如外部系统没有唯一键"}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {tokens.map(function (tok, i) {
              return tok.lit !== undefined ? (
                <span key={i} className="text-xs text-muted-foreground">{tok.lit}</span>
              ) : (
                <FieldChip
                  key={i}
                  path={String(tok.field)}
                  onRemove={function () {
                    patch(function (d) {
                      const s = slot === "title" ? d.mapping.title : d.mapping.externalId;
                      s.template.splice(i, 1);
                    });
                  }}
                />
              );
            })}
          </div>
        )}
        <p className="mt-2 text-[11px] text-muted-foreground">在字段目录里点一个字段，加进这里</p>
      </div>
    );
  }

  if (slot === "priority") {
    const spec = m.priority;
    const prioEntry =
      spec && "field" in spec
        ? catalog.find(function (c) { return c.path === (m.priority as { field: string }).field; })
        : null;
    return (
      <div>
        <div className="mb-2 inline-flex overflow-hidden rounded-md border border-border">
          <SegBtn on={!spec} label="不设" onClick={function () { patch(function (d) { d.mapping.priority = undefined; }); }} />
          <SegBtn on={Boolean(spec && "field" in spec)} label="从字段" onClick={function () { setActive({ slot: "priority" }); }} />
          <SegBtn on={Boolean(spec && "const" in spec)} label="固定值" onClick={function () { patch(function (d) { d.mapping.priority = { const: "3" }; }); }} />
        </div>
        {spec && "field" in spec && spec.field ? (
          <div className="space-y-2">
            <FieldChip path={spec.field} />
            {prioEntry && prioEntry.type === "enum" ? (
              <div className="rounded-md border border-border p-2">
                <p className="mb-1.5 text-[11px] text-muted-foreground">按实际出现的值映射</p>
                {prioEntry.samples.map(function (v) {
                  return (
                    <div key={v} className="flex items-center gap-2 py-0.5">
                      <span className="min-w-0 flex-1 truncate text-xs">{v}</span>
                      <select
                        value={String((spec.map && spec.map[v]) || "")}
                        onChange={function (e) {
                          const val = e.target.value;
                          patch(function (d) {
                            const p = d.mapping.priority;
                            if (!p || !("field" in p)) return;
                            p.map = Object.assign({}, p.map, (function () { const o: Record<string, string> = {}; o[v] = val; return o; })());
                          });
                        }}
                        className="h-7 rounded-md border border-border bg-transparent px-1.5 text-xs"
                      >
                        <option value="">不设</option>
                        <option value="1">P1</option>
                        <option value="2">P2</option>
                        <option value="3">P3</option>
                        <option value="4">P4</option>
                      </select>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}
        {spec && "const" in spec ? (
          <select
            value={spec.const || "3"}
            onChange={function (e) { patch(function (d) { d.mapping.priority = { const: e.target.value }; }); }}
            className={inputCls + " h-8"}
          >
            <option value="1">P1 紧急</option>
            <option value="2">P2 高</option>
            <option value="3">P3 中</option>
            <option value="4">P4 低</option>
          </select>
        ) : null}
      </div>
    );
  }

  if (slot === "dates") {
    const sub = active && active.slot === "dates" ? active.sub : null;
    /** One from/to row: 不设 / 字段 / 固定 */
    const dateRow = function (label: string, key: "due" | "starts") {
      const spec = m[key];
      const armed = sub === key;
      return (
        <div className={"mb-2 rounded-lg border p-2 " + (armed ? "border-foreground/40 bg-muted/60" : "border-border")}>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
            {spec && "field" in spec && spec.field ? <FieldChip path={spec.field} /> : null}
          </div>
          <div className="mb-2 inline-flex overflow-hidden rounded-md border border-border">
            <SegBtn on={!spec} label="不设" onClick={function () { patch(function (d) { d.mapping[key] = undefined; }); }} />
            <SegBtn on={Boolean(spec && "field" in spec)} label="字段" onClick={function () { setActive({ slot: "dates", sub: key }); }} />
            <SegBtn on={Boolean(spec && "const" in spec)} label="固定" onClick={function () { patch(function (d) { d.mapping[key] = { const: key === "due" ? "next-monday" : "today" }; }); }} />
          </div>
          {spec && "field" in spec ? (
            <p className="text-[11px] text-muted-foreground">{armed ? "在字段目录里点一个日期字段" : "已从字段取"}</p>
          ) : null}
          {spec && "const" in spec ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                type="date"
                value={/^\d{4}-\d{2}-\d{2}$/.test(spec.const) ? spec.const : ""}
                onChange={function (e) {
                  if (e.target.value) patch(function (d) { d.mapping[key] = { const: e.target.value }; });
                }}
                className="h-7 rounded-md border border-border bg-transparent px-1.5 text-xs"
              />
              {["today", "+3d", "next-monday", key === "due" ? "this-week" : "", key === "due" ? "next-week" : ""]
                .filter(Boolean)
                .map(function (v) {
                  return (
                    <button
                      key={v}
                      type="button"
                      onClick={function () { patch(function (d) { d.mapping[key] = { const: v }; }); }}
                      className={"rounded-full border px-2 py-0.5 text-[11px] " + (spec.const === v ? "border-foreground bg-muted text-foreground" : "border-border text-muted-foreground hover:text-foreground")}
                    >
                      {v}
                    </button>
                  );
                })}
            </div>
          ) : null}
        </div>
      );
    };
    return (
      <div>
        {dateRow("to（截止 = due）", "due")}
        {dateRow("from（开始，可选）", "starts")}
        <p className="text-[11px] text-muted-foreground">只设 from 不设 to 时，to 取 from（单日）。</p>
      </div>
    );
  }

  if (slot === "notes" || slot === "subtasks") {
    const spec = slot === "notes" ? m.notes : m.subtasks;
    return (
      <div>
        <div className="mb-2 inline-flex overflow-hidden rounded-md border border-border">
          <SegBtn on={!spec} label="不设" onClick={function () { patch(function (d) { if (slot === "notes") d.mapping.notes = undefined; else d.mapping.subtasks = undefined; }); }} />
          <SegBtn on={Boolean(spec && "field" in spec)} label="从字段" onClick={function () { setActive({ slot: slot as "notes" | "subtasks" }); }} />
          <SegBtn on={Boolean(spec && "const" in spec)} label="固定值" onClick={function () { patch(function (d) { if (slot === "notes") d.mapping.notes = { const: "" }; else d.mapping.subtasks = { const: "" }; }); }} />
        </div>
        {spec && "field" in spec && spec.field ? (
          <div>
            <FieldChip path={spec.field} />
            <p className="mt-1.5 text-[11px] text-muted-foreground">已从字段取</p>
          </div>
        ) : null}
        {spec && "const" in spec ? (
          <input
            value={spec.const}
            onChange={function (e) { patch(function (d) { if (slot === "notes") d.mapping.notes = { const: e.target.value }; else d.mapping.subtasks = { const: e.target.value }; }); }}
            className={inputCls + " h-8"}
            placeholder={slot === "notes" ? "固定文本" : "一条子任务"}
          />
        ) : null}
        {!spec ? <p className="text-[11px] text-muted-foreground">在字段目录里点一个字段，或设固定值</p> : null}
      </div>
    );
  }

  // tags
  const tokens = m.tags || [];
  const [adding, setAdding] = React.useState(false);
  const [lit, setLit] = React.useState("");
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tokens.map(function (tok, i) {
        return (
          <FieldChip
            key={i}
            path={tok.lit !== undefined ? String(tok.lit) : String(tok.field)}
            onRemove={function () { patch(function (d) { d.mapping.tags.splice(i, 1); }); }}
          />
        );
      })}
      <button
        type="button"
        onClick={function () { setActive({ slot: "tags" }); }}
        className="rounded-full border border-dashed border-border px-2.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
      >
        ＋ 字段
      </button>
      {adding ? (
        <span className="inline-flex items-center gap-1">
          <input
            autoFocus
            value={lit}
            onChange={function (e) { setLit(e.target.value); }}
            onKeyDown={function (e) {
              if (e.key === "Enter" && lit.trim()) {
                patch(function (d) { (d.mapping.tags = d.mapping.tags || []).push({ lit: lit.trim() }); });
                setLit("");
                setAdding(false);
              }
            }}
            className="h-7 w-24 rounded-md border border-border bg-transparent px-2 text-[11px] outline-none focus:border-foreground"
            placeholder="标签名"
          />
          <button
            type="button"
            onClick={function () {
              if (lit.trim()) patch(function (d) { (d.mapping.tags = d.mapping.tags || []).push({ lit: lit.trim() }); });
              setLit("");
              setAdding(false);
            }}
            className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            加上
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={function () { setAdding(true); }}
          className="rounded-full border border-dashed border-border px-2.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
        >
          ＋ 固定
        </button>
      )}
    </div>
  );
}

/* ───────────────────────── main component ───────────────────────── */

export function Connect(props: { onPack: (res: unknown) => void }) {
  const { call } = useApp();
  const { boards, today } = useStore();
  const reduce = useReducedMotion();

  const [view, setView] = React.useState<"list" | "wizard">("list");
  const [step, setStep] = React.useState(1);
  const [connectors, setConnectors] = React.useState<Connector[]>([]);
  const [templates, setTemplates] = React.useState<ConnectorTemplate[]>([]);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [sample, setSample] = React.useState<SampleState>(EMPTY_SAMPLE);
  const [active, setActive] = React.useState<Active | null>(null);
  const [catQuery, setCatQuery] = React.useState("");
  const [running, setRunning] = React.useState<string | null>(null);
  const [tried, setTried] = React.useState(false);

  const load = React.useCallback(
    async function () {
      try {
        const res = await call("connectorsList", {});
        if (res && typeof res === "object" && Array.isArray((res as { connectors?: Connector[] }).connectors)) {
          setConnectors((res as { connectors: Connector[] }).connectors);
          setTemplates(((res as { templates?: ConnectorTemplate[] }).templates || []) as ConnectorTemplate[]);
        }
      } catch (e) {
        toast.add({ title: "接入面板没打开", description: String((e as { message?: string }).message || e) });
      }
    },
    [call]
  );

  React.useEffect(function () { void load(); }, [load]);

  function patch(fn: (d: Draft) => void) {
    setDraft(function (prev) {
      if (!prev) return prev;
      const next: Draft = JSON.parse(JSON.stringify(prev));
      fn(next);
      return next;
    });
  }

  async function takeSample(d: Draft) {
    setSample(Object.assign({}, EMPTY_SAMPLE, { loading: true }));
    try {
      const res = await call("connectorSample", {
        source: draftSource(d),
        params: d.params,
        rootPath: d.rootPath,
        mapping: d.mapping,
      });
      const r = res as { count?: number; roots?: string[]; catalog?: CatalogEntry[]; rows?: unknown[]; rootPath?: string };
      setSample({
        loading: false,
        error: null,
        count: Number(r.count) || 0,
        roots: r.roots || [],
        catalog: r.catalog || [],
        rows: r.rows || [],
      });
      if (r.rootPath && !d.rootPath) patch(function (x) { x.rootPath = String(r.rootPath); });
    } catch (e) {
      setSample({ loading: false, error: String((e as { message?: string }).message || e), count: 0, roots: [], catalog: [], rows: [] });
    }
  }

  const previews: TaskDraft[] = React.useMemo(
    function () {
      if (!draft || !sample.rows.length) return [];
      return sample.rows.map(function (r) { return evalMapping(draft.mapping, r, today); });
    },
    [draft, sample.rows, today]
  );

  function catalogClick(entry: CatalogEntry) {
    if (!draft) return;
    const path = entry.path;
    if (!active) {
      toast.add({ title: "先点亮左边一个任务字段" });
      return;
    }
    const a = active;
    if (a.slot === "title" || a.slot === "externalId") {
      patch(function (d) {
        const s = a.slot === "title" ? d.mapping.title : d.mapping.externalId;
        if ("template" in s && Array.isArray(s.template)) s.template.push({ field: path });
        else d.mapping[a.slot] = { template: [{ field: path }] };
      });
      return;
    }
    if (a.slot === "tags") {
      patch(function (d) { (d.mapping.tags = d.mapping.tags || []).push({ field: path }); });
      return;
    }
    if (a.slot === "priority") {
      const transform = entry.type === "enum" ? ("enum" as const) : entry.type === "date" ? ("date" as const) : undefined;
      patch(function (d) {
        d.mapping.priority = { field: path, transform: transform, map: transform === "enum" ? {} : undefined };
      });
      return;
    }
    if (a.slot === "dates") {
      const transform = entry.type === "date" ? ("date" as const) : undefined;
      const key = a.sub;
      patch(function (d) { d.mapping[key] = { field: path, transform: transform }; });
      return;
    }
    // notes / subtasks
    patch(function (d) {
      if (a.slot === "notes") d.mapping.notes = { field: path };
      else d.mapping.subtasks = { field: path };
    });
  }

  async function runConnector(c: Connector, limit: number) {
    setRunning(c.id + ":" + String(limit));
    try {
      const res = await call("connectorRun", { id: c.id, limit: limit });
      props.onPack(res);
      const s = (res as { summary?: string }).summary;
      toast.add({ title: limit ? "试运行完成" : "同步完成", description: s || undefined });
      void load();
    } catch (e) {
      toast.add({ title: "同步没有完成", description: String((e as { message?: string }).message || e) });
    } finally {
      setRunning(null);
    }
  }

  function connectorPayload(d: Draft) {
    return {
      id: d.id || undefined,
      name: d.name,
      kind: d.kind,
      source: draftSource(d),
      params: d.params,
      rootPath: d.rootPath,
      mapping: d.mapping,
      options: { boardId: d.boardId, syncDone: d.syncDone, keepDeleted: d.keepDeleted },
    };
  }

  async function save() {
    if (!draft) return;
    try {
      const res = await call("connectorSave", { connector: connectorPayload(draft) });
      const r = res as { connectors?: Connector[] };
      if (r.connectors) setConnectors(r.connectors);
      toast.add({ title: "已保存" });
      setView("list");
      setStep(1);
      setDraft(null);
      setSample(EMPTY_SAMPLE);
    } catch (e) {
      toast.add({ title: "没保存成", description: String((e as { message?: string }).message || e) });
    }
  }

  const boardName = function (id: string): string {
    const b = boards.find(function (x) { return x.id === id; });
    return b ? b.name : id;
  };

  /* ───────── list view ───────── */

  function renderList() {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {connectors.length === 0 ? (
          <div className="mb-4">
            <p className="mb-3 text-sm text-muted-foreground">从模板开始，五步配好一个数据源。</p>
            <div className="grid gap-2.5 sm:grid-cols-3">
              {templates.map(function (t) {
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={function () {
                      setDraft(draftFromTemplate(t));
                      setView("wizard");
                      setStep(2);
                      setSample(EMPTY_SAMPLE);
                      setActive(null);
                    }}
                    className="rounded-xl border border-border p-4 text-left transition-colors hover:bg-muted"
                  >
                    <p className="mb-1 text-sm font-semibold">{t.name}</p>
                    <p className="text-xs leading-relaxed text-muted-foreground">{t.description}</p>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        {connectors.map(function (c) {
          const busy = running === c.id + ":0" || running === c.id + ":3";
          return (
            <div key={c.id} className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-border px-3.5 py-3">
              <span className="size-1.5 shrink-0 rounded-full bg-foreground/60" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{c.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {c.kind === "mcp"
                    ? "mcp · " + ("serverId" in c.source ? c.source.serverId + "/" + c.source.toolName : "")
                    : "http"}
                  {c.lastRunAt ? " · " + new Date(c.lastRunAt).toLocaleString() : ""}
                  {c.lastRunResult ? " · " + c.lastRunResult : ""}
                </p>
              </div>
              <div className="ml-auto flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={function () {
                    setDraft(draftFromConnector(c));
                    setView("wizard");
                    setStep(2);
                    void takeSample(draftFromConnector(c));
                  }}
                >
                  编辑
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={function () { void runConnector(c, 3); }}>
                  试 3 条
                </Button>
                <Button size="sm" disabled={busy} onClick={function () { void runConnector(c, 0); }}>
                  {busy ? "同步中…" : "同步"}
                </Button>
              </div>
            </div>
          );
        })}
        {connectors.length ? (
          <button
            type="button"
            onClick={function () {
              const t = templates[templates.length - 1];
              setDraft(draftFromTemplate(t));
              setView("wizard");
              setStep(2);
              setSample(EMPTY_SAMPLE);
            }}
            className="mt-1 self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            ＋ 新建连接器
          </button>
        ) : null}
      </div>
    );
  }

  /* ───────── wizard view ───────── */

  function renderWizard() {
    if (!draft) return null;
    const canSample =
      draft.kind === "mcp" ? Boolean(draft.serverId && draft.toolName) : Boolean(draft.url);
    const mapped = previews.filter(function (p) { return p.title && p.externalId; }).length;
    const ready = mapped > 0;

    const steps = [1, 2, 3, 4, 5];
    const stepLabels: Record<number, string> = { 1: "模板", 2: "连接", 3: "范围", 4: "映射", 5: "落点" };

    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="mb-3 flex items-center gap-1">
          {steps.map(function (n) {
            return (
              <React.Fragment key={n}>
                <StepChip n={n} label={stepLabels[n]} on={step === n} done={step > n} go={function () { setStep(n); }} />
                {n < 5 ? <span className="mx-0.5 text-[10px] text-muted-foreground/60">—</span> : null}
              </React.Fragment>
            );
          })}
          <button type="button" onClick={function () { setView("list"); }} className="ml-auto text-xs text-muted-foreground hover:text-foreground">
            ← 返回
          </button>
        </div>

        {step === 2 ? (
          <div className="max-w-md">
            <Labeled label="名字">
              <input value={draft.name} onChange={function (e) { patch(function (d) { d.name = e.target.value; }); }} className={inputCls} placeholder="工作 Jira" />
            </Labeled>
            <div className="mt-3 inline-flex overflow-hidden rounded-md border border-border">
              <SegBtn on={draft.kind === "mcp"} label="MCP 工具" onClick={function () { patch(function (d) { d.kind = "mcp"; }); }} />
              <SegBtn on={draft.kind === "http"} label="HTTP" onClick={function () { patch(function (d) { d.kind = "http"; }); }} />
            </div>
            {draft.kind === "mcp" ? (
              <div className="mt-2 grid grid-cols-2 gap-2.5">
                <Labeled label="MCP Server id">
                  <input value={draft.serverId} onChange={function (e) { patch(function (d) { d.serverId = e.target.value; }); }} className={inputCls} placeholder="jira" />
                </Labeled>
                <Labeled label="工具名">
                  <input value={draft.toolName} onChange={function (e) { patch(function (d) { d.toolName = e.target.value; }); }} className={inputCls} placeholder="JiraQuery" />
                </Labeled>
              </div>
            ) : (
              <div className="mt-2 grid grid-cols-3 gap-2.5">
                <div className="col-span-2">
                  <Labeled label="URL">
                    <input value={draft.url} onChange={function (e) { patch(function (d) { d.url = e.target.value; }); }} className={inputCls} placeholder="https://…" />
                  </Labeled>
                </div>
                <Labeled label="方法">
                  <select value={draft.method} onChange={function (e) { patch(function (d) { d.method = e.target.value; }); }} className={inputCls}>
                    <option>GET</option>
                    <option>POST</option>
                  </select>
                </Labeled>
              </div>
            )}
            <div className="mt-4">
              <Button size="sm" disabled={!canSample || sample.loading} onClick={function () { void takeSample(draft); }}>
                {sample.loading ? "取样本中…" : sample.rows.length ? "重新取样本" : "测试连接 · 取样本"}
              </Button>
              {sample.error ? <p className="mt-2 text-xs text-destructive">{sample.error}</p> : null}
              {!sample.error && sample.rows.length ? (
                <p className="mt-2 text-xs text-muted-foreground">✓ 拿到 {String(sample.count)} 条</p>
              ) : null}
            </div>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="max-w-lg">
            <p className="mb-3 text-sm text-muted-foreground">
              请求参数决定「导入哪些」。导入后本地改动不会被同步覆盖，删除过的（除非关掉「不再导入」）不会复活。
            </p>
            {Object.keys(draft.params).map(function (k) {
              const v = draft.params[k];
              const isArr = Array.isArray(v);
              return (
                <div key={k} className="mb-2">
                  <div className="grid grid-cols-3 gap-2">
                    <input
                      value={k}
                      onChange={function (e) {
                        const nk = e.target.value;
                        patch(function (d) {
                          const val = d.params[k];
                          delete d.params[k];
                          if (nk) d.params[nk] = val;
                        });
                      }}
                      className={inputCls + " h-8 font-mono text-xs"}
                      placeholder="参数名"
                    />
                    {isArr ? null : (
                      <input
                        value={String(v ?? "")}
                        onChange={function (e) {
                          const nk = k;
                          const nv = e.target.value;
                          patch(function (d) { d.params[nk] = nv; });
                        }}
                        className={inputCls + " col-span-2 h-8 text-xs"}
                        placeholder="值"
                      />
                    )}
                    <div className="col-span-3 flex items-center justify-between">
                      {isArr ? (
                        <textarea
                          value={(v as unknown[]).map(String).join("\n")}
                          onChange={function (e) {
                            const lines = e.target.value.split("\n");
                            patch(function (d) { d.params[k] = lines; });
                          }}
                          rows={Math.min(6, (v as unknown[]).length + 1)}
                          className="w-full rounded-md border border-input bg-transparent px-2 py-1 font-mono text-[11px] outline-none focus:border-foreground"
                        />
                      ) : (
                        <span className="text-[10px] text-muted-foreground">数组参数一行一个值</span>
                      )}
                      <button
                        type="button"
                        onClick={function () { patch(function (d) { delete d.params[k]; }); }}
                        className="text-[11px] text-muted-foreground hover:text-destructive"
                      >
                        ✕ 删
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
            <button
              type="button"
              onClick={function () {
                const nk = "p" + String(Object.keys(draft.params).length + 1);
                patch(function (d) { d.params[nk] = ""; });
                setStep(3);
              }}
              className="mb-3 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              ＋ 加参数
            </button>
            <p className="mb-2 text-[11px] text-muted-foreground">
              常用参数（点一下就加上）：
            </p>
            <div className="mb-4 flex flex-wrap gap-1.5">
              {(PARAM_HINTS[draft.kind === "mcp" && /jira/i.test(draft.serverId + draft.toolName) ? "jira" : draft.kind] || []).map(function (h) {
                return (
                  <button
                    key={h.name}
                    type="button"
                    title={h.note}
                    onClick={function () {
                      patch(function (d) {
                        if (d.params[h.name] === undefined) {
                          d.params[h.name] = h.name === "fields" ? ["summary"] : "";
                        }
                      });
                    }}
                    className="rounded-full border border-border px-2.5 py-1 font-mono text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    {h.name}
                  </button>
                );
              })}
            </div>
            <p className="mb-1.5 text-xs text-muted-foreground">样本根路径（自动检测）</p>
            <div className="mb-4 flex flex-wrap gap-1.5">
              {(sample.roots.length ? sample.roots : [draft.rootPath || "$"]).map(function (r) {
                return (
                  <button
                    key={r || "$"}
                    type="button"
                    onClick={function () { patch(function (d) { d.rootPath = r; }); }}
                    className={
                      "rounded-full border px-2.5 py-1 font-mono text-[11px] " +
                      (draft.rootPath === r ? "border-foreground bg-muted text-foreground" : "border-border text-muted-foreground hover:text-foreground")
                    }
                  >
                    {r || "$"}
                  </button>
                );
              })}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={sample.loading || !canSample} onClick={function () { void takeSample(draft); }}>
                {sample.loading ? "取样本中…" : "取样本（20 条）"}
              </Button>
              <Button size="sm" disabled={!sample.rows.length} onClick={function () { setStep(4); }}>
                下一步 · 映射
              </Button>
            </div>
            {sample.rows.length ? <p className="mt-2 text-xs text-muted-foreground">✓ {String(sample.count)} 条样本在手上</p> : null}
          </div>
        ) : null}

        {step === 4 ? (
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-2.5 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)] lg:grid-cols-[300px_minmax(0,1.4fr)_300px]">
            {/* slots */}
            <div className="flex min-h-0 flex-col overflow-y-auto rounded-xl border border-border p-2">
              <p className="px-1.5 pb-1.5 pt-1 text-[11px] tracking-[0.18em] text-muted-foreground">任务字段</p>
              {SLOTS.map(function (s) {
                const on = active && active.slot === s.id;
                const filled = slotFilled(draft, s.id);
                return (
                  <div key={s.id} className="mb-1">
                    <button
                      type="button"
                      onClick={function () {
                        if (on) {
                          setActive(null);
                          return;
                        }
                        const a: Active =
                          s.id === "dates"
                            ? { slot: "dates", sub: "due" }
                            : s.id === "externalId" || s.id === "title" || s.id === "priority" || s.id === "notes" || s.id === "subtasks" || s.id === "tags"
                              ? { slot: s.id as Active["slot"] }
                              : { slot: "dates", sub: "due" };
                        setActive(a);
                      }}
                      className={
                        "w-full rounded-lg border px-2.5 py-2 text-left " +
                        (on ? "border-foreground/30 bg-muted" : "border-transparent hover:bg-muted/50")
                      }
                    >
                      <span className="flex items-center gap-2 text-[13px] font-medium">
                        {s.label}
                        {s.required ? <span className="text-destructive">*</span> : null}
                        <span className={"ml-auto text-[11px] font-normal " + (filled ? "text-muted-foreground" : "text-muted-foreground/50")}>
                          {filled ? "✓" : "未设"}
                        </span>
                      </span>
                    </button>
                    {on ? (
                      <div className="mt-1 border-t border-dashed border-border px-1 pt-2">
                        <SlotEditor slot={s.id} draft={draft} catalog={sample.catalog} active={active} setActive={setActive} patch={patch} />
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {/* catalog */}
            <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border">
              <p className="px-3 pb-1 pt-2.5 text-[11px] tracking-[0.18em] text-muted-foreground">字段目录 · {String(sample.count)} 条样本聚合</p>
              <div className="px-2 pb-1.5">
                <input
                  value={catQuery}
                  onChange={function (e) { setCatQuery(e.target.value); }}
                  placeholder="搜索字段…"
                  className={inputCls + " h-7 text-xs"}
                />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
                {sample.catalog
                  .filter(function (c) { return !catQuery || c.path.toLowerCase().indexOf(catQuery.toLowerCase()) >= 0; })
                  .map(function (c) {
                    return (
                      <button
                        key={c.path}
                        type="button"
                        onClick={function () { catalogClick(c); }}
                        title={c.samples.join(" ｜ ")}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
                      >
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{c.path}</span>
                        <span
                          className={
                            "shrink-0 rounded border px-1 text-[9.5px] " +
                            (c.type === "enum" || c.type === "date" ? "border-foreground/30 text-muted-foreground" : "border-border text-muted-foreground")
                          }
                        >
                          {c.type}
                        </span>
                        <span className={"shrink-0 text-[10px] tabular-nums " + (c.cov * 2 < c.total ? "text-muted-foreground/70" : "text-muted-foreground")}>
                          {String(c.cov)}/{String(c.total)}
                        </span>
                      </button>
                    );
                  })}
                {!sample.catalog.length ? (
                  <p className="px-2 py-3 text-xs text-muted-foreground">{sample.loading ? "聚合中…" : "先在范围里取一次样本"}</p>
                ) : null}
              </div>
            </div>
            {/* preview */}
            <div className="hidden min-h-0 flex-col overflow-y-auto rounded-xl border border-border lg:flex">
              <p className="px-3 pb-1 pt-2.5 text-[11px] tracking-[0.18em] text-muted-foreground">预览 · 实时</p>
              {previews.slice(0, 6).map(function (p, i) {
                return (
                  <div key={i} className="mx-2 mb-1.5 rounded-lg border border-border px-2.5 py-2">
                    <p className="text-[13px] font-medium leading-snug">{p.title || <span className="text-destructive">（标题为空）</span>}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {p.priority ? <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{"P" + String(p.priority)}</span> : null}
                      {p.due ? <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{p.due}</span> : null}
                      {(p.tags || []).map(function (t) {
                        return <span key={t} className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{"#" + t}</span>;
                      })}
                      {(p.subtasks || []).length ? (
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">子任务 {String((p.subtasks || []).length)}</span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
              {!previews.length ? <p className="px-3 py-3 text-xs text-muted-foreground">取样本后这里实时映射</p> : null}
            </div>
          </div>
        ) : null}

        {step === 5 ? (
          <div className="max-w-md">
            <Labeled label="导入到板块">
              <select value={draft.boardId} onChange={function (e) { patch(function (d) { d.boardId = e.target.value; }); }} className={inputCls}>
                {boards.map(function (b) {
                  return (
                    <option key={b.id} value={b.id}>
                      {b.name + (b.fixed ? "（默认）" : "")}
                    </option>
                  );
                })}
              </select>
            </Labeled>
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.syncDone}
                onChange={function (e) { patch(function (d) { d.syncDone = e.target.checked; }); }}
                className="size-3.5 accent-foreground"
              />
              远端关闭 / Done 的任务标为完成
            </label>
            <label className="mt-2.5 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.keepDeleted}
                onChange={function (e) { patch(function (d) { d.keepDeleted = e.target.checked; }); }}
                className="size-3.5 accent-foreground"
              />
              本地删过的外部任务不再导入
            </label>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              导入的任务先进板块，之后随你怎么挪——同步不会把它搬回去。
            </p>
            <div className="mt-5 rounded-xl border border-dashed border-border p-3.5">
              <p className="mb-2 text-xs text-muted-foreground">先真实导入 3 条看看，可撤销</p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async function () {
                    if (!draft) return;
                    try {
                      const res = await call("connectorSave", { connector: connectorPayload(draft) });
                      const r = res as { connectors?: Connector[] };
                      if (r.connectors) setConnectors(r.connectors);
                      const saved = (r.connectors || []).find(function (c) { return c.name === draft.name; });
                      setTried(true);
                      if (saved) await runConnector(saved, 3);
                    } catch (e) {
                      toast.add({ title: "没保存成", description: String((e as { message?: string }).message || e) });
                    }
                  }}
                >
                  试运行 · 导入 3 条
                </Button>
                <Button size="sm" onClick={function () { void save(); }}>
                  保存{ready ? "" : "（映射可能没配全）"}
                </Button>
              </div>
              {tried ? <p className="mt-2 text-xs text-muted-foreground">已导入 3 条到「{boardName(draft.boardId)}」</p> : null}
            </div>
            <div className="mt-4 flex gap-2">
              <Button size="sm" variant="ghost" onClick={function () { setStep(4); }}>
                ← 回映射
              </Button>
            </div>
          </div>
        ) : null}

        {step < 5 ? (
          <div className="mt-auto flex justify-end gap-2 pt-3">
            {step > 2 ? (
              <Button size="sm" variant="ghost" onClick={function () { setStep(step - 1); }}>
                ← 上一步
              </Button>
            ) : null}
            {step === 2 && sample.rows.length ? (
              <Button size="sm" onClick={function () { setStep(3); }}>
                下一步 · 范围
              </Button>
            ) : null}
            {step === 3 && sample.rows.length ? (
              <Button size="sm" onClick={function () { setStep(4); }}>
                下一步 · 映射
              </Button>
            ) : null}
            {step === 4 ? (
              <Button size="sm" disabled={!ready} onClick={function () { setStep(5); }}>
                下一步 · 落点
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0 }}
      transition={{ duration: 0.3, ease: EASE }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-xl"
      data-kedu="connect"
    >
      <div className="flex h-full max-h-[min(760px,92vh)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
        <div className="flex items-center gap-3 px-6 pt-5">
          <p className="text-[11px] tracking-[0.42em] text-muted-foreground">接 入</p>
          <div className="ml-auto flex items-center gap-2">
            {view === "wizard" && draft ? <span className="text-xs text-muted-foreground">{draft.name || "未命名"}</span> : null}
            <Kbd>esc</Kbd>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col px-6 pb-5 pt-4">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={view + String(step)}
              initial={reduce ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? undefined : { opacity: 0 }}
              transition={{ duration: 0.18, ease: EASE }}
              className="flex min-h-0 flex-1 flex-col"
            >
              {view === "list" ? renderList() : renderWizard()}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}
