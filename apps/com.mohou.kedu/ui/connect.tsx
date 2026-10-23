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
import { evalMapping, evalSpec } from "../shared/connectors";
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

/** The connector being edited — split so each step edits its slice. */
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

/* ───────────────────────── slot editor ───────────────────────── */

type SlotId = "externalId" | "title" | "priority" | "dates" | "notes" | "tags" | "subtasks";

const SLOTS: { id: SlotId; label: string; required?: boolean }[] = [
  { id: "externalId", label: "唯一键", required: true },
  { id: "title", label: "标题", required: true },
  { id: "priority", label: "优先级" },
  { id: "dates", label: "日期" },
  { id: "notes", label: "备注" },
  { id: "tags", label: "标签" },
  { id: "subtasks", label: "子任务" },
];

/** The slot the user has active; catalog clicks land there. */
type Active =
  | { slot: "title" | "externalId"; mode: "template" }
  | { slot: "priority" | "notes" | "subtasks" | "starts" | "due"; mode: "field" }
  | { slot: "tags" };

function SlotEditor(props: {
  slot: SlotId;
  draft: Draft;
  catalog: CatalogEntry[];
  rows: unknown[];
  active: Active | null;
  setActive: (a: Active | null) => void;
  patch: (fn: (d: Draft) => void) => void;
}) {
  const { slot, draft, catalog, rows, active, setActive, patch } = props;
  const m = draft.mapping;

  function specOf(id: string): ValueSpec | undefined {
    if (id === "externalId") return m.externalId;
    if (id === "title") return m.title;
    if (id === "priority") return m.priority;
    if (id === "notes") return m.notes;
    if (id === "subtasks") return m.subtasks;
    return undefined;
  }

  /* value mapper for the priority enum */
  const prioEntry = m.priority && "field" in m.priority ? catalog.find(function (c) { return c.path === m.priority!.field; }) : null;

  function renderTokenEditor(spec: ValueSpec, id: string) {
    const tokens = "template" in spec && Array.isArray(spec.template) ? spec.template : [];
    return (
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
                  const s = id === "title" ? d.mapping.title : d.mapping.externalId;
                  s.template.splice(i, 1);
                });
              }}
            />
          );
        })}
      </div>
    );
  }

  if (slot === "externalId" || slot === "title") {
    const spec = specOf(slot) as ValueSpec;
    return (
      <div>
        <div className="mb-2 inline-flex overflow-hidden rounded-md border border-border">
          <SegBtn on={"template" in spec} label="模板" onClick={function () { setActive({ slot: slot as "title" | "externalId", mode: "template" }); }} />
        </div>
        {renderTokenEditor(spec, slot)}
        <p className="mt-2 text-[11px] text-muted-foreground">在字段目录里点一个字段，加进这里</p>
      </div>
    );
  }

  if (slot === "priority") {
    const spec = m.priority;
    return (
      <div>
        <div className="mb-2 inline-flex overflow-hidden rounded-md border border-border">
          <SegBtn on={!spec} label="不设" onClick={function () { patch(function (d) { d.mapping.priority = undefined; }); }} />
          <SegBtn on={Boolean(spec && "field" in spec)} label="从字段" onClick={function () { setActive({ slot: "priority", mode: "field" }); }} />
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
                            if (!d.mapping.priority || !("field" in d.mapping.priority)) return;
                            d.mapping.priority.map = Object.assign({}, d.mapping.priority.map, (function () { const o: Record<string, string> = {}; o[v] = val; return o; })());
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
    const dateRow = function (label: string, key: "due" | "starts") {
      const spec = m[key];
      return (
        <div className="mb-2.5">
          <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>{label}</span>
            {spec && "field" in spec && spec.field ? <FieldChip path={spec.field} /> : <span className="opacity-70">未设</span>}
          </div>
        </div>
      );
    };
    return (
      <div>
        {dateRow("to（截止 = due）", "due")}
        {dateRow("from（开始，可选）", "starts")}
        <div className="flex flex-wrap gap-1.5">
          {[
            { v: "today", t: "今天" },
            { v: "+3d", t: "+3 天" },
            { v: "next-monday", t: "下周一" },
            { v: "this-week", t: "本周" },
            { v: "next-week", t: "下周" },
          ].map(function (c) {
            return (
              <button
                key={c.v}
                type="button"
                onClick={function () {
                  patch(function (d) {
                    d.mapping.due = { const: c.v };
                    if (c.v === "this-week" || c.v === "next-week") d.mapping.starts = { const: c.v };
                  });
                }}
                className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {c.t}
              </button>
            );
          })}
        </div>
        <div className="mt-2 flex gap-3">
          <button type="button" onClick={function () { setActive({ slot: "due", mode: "field" }); }} className="text-[11.5px] text-muted-foreground underline underline-offset-2 hover:text-foreground">
            to 从字段选
          </button>
          <button type="button" onClick={function () { setActive({ slot: "starts", mode: "field" }); }} className="text-[11.5px] text-muted-foreground underline underline-offset-2 hover:text-foreground">
            from 从字段选
          </button>
        </div>
      </div>
    );
  }

  if (slot === "notes" || slot === "subtasks") {
    const spec = slot === "notes" ? m.notes : m.subtasks;
    return (
      <div>
        <div className="mb-2 inline-flex overflow-hidden rounded-md border border-border">
          <SegBtn on={!spec} label="不设" onClick={function () { patch(function (d) { if (slot === "notes") d.mapping.notes = undefined; else d.mapping.subtasks = undefined; }); }} />
          <SegBtn on={Boolean(spec && "field" in spec)} label="从字段" onClick={function () { setActive({ slot: slot as "notes" | "subtasks", mode: "field" }); }} />
          <SegBtn on={Boolean(spec && "const" in spec)} label="固定值" onClick={function () { patch(function (d) { if (slot === "notes") d.mapping.notes = { const: "" }; else d.mapping.subtasks = { const: "" }; }); }} />
        </div>
        {spec && "field" in spec && spec.field ? <FieldChip path={spec.field} /> : null}
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
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tokens.map(function (tok, i) {
        return tok.lit !== undefined ? (
          <FieldChip
            key={i}
            path={String(tok.lit)}
            onRemove={function () { patch(function (d) { d.mapping.tags.splice(i, 1); }); }}
          />
        ) : (
          <FieldChip
            key={i}
            path={String(tok.field)}
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
      <button
        type="button"
        onClick={function () {
          const v = window.prompt("固定标签文字");
          if (v && v.trim()) patch(function (d) { (d.mapping.tags = d.mapping.tags || []).push({ lit: v.trim() }); });
        }}
        className="rounded-full border border-dashed border-border px-2.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
      >
        ＋ 固定
      </button>
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

  /* one sample fetch; preview evaluates locally afterwards */
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

  /* local preview from cached rows */
  const previews: TaskDraft[] = React.useMemo(
    function () {
      if (!draft || !sample.rows.length) return [];
      return sample.rows.map(function (r) { return evalMapping(draft.mapping, r, today); });
    },
    [draft, sample.rows, today]
  );

  /* catalog click → land in the active slot */
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
      patch(function (d) { d.mapping.priority = { field: path, transform: transform, map: transform === "enum" ? {} : undefined }; });
      return;
    }
    if (a.slot === "due" || a.slot === "starts") {
      const transform = entry.type === "date" ? ("date" as const) : undefined;
      patch(function (d) {
        if (a.slot === "due") d.mapping.due = { field: path, transform: transform };
        else d.mapping.starts = { field: path, transform: transform };
      });
      setActive(null);
      return;
    }
    // notes / subtasks
    patch(function (d) {
      if (a.slot === "notes") d.mapping.notes = { field: path };
      else d.mapping.subtasks = { field: path };
    });
    setActive(null);
  }

  async function runConnector(c: Connector, limit: number) {
    setRunning(c.id + ":" + String(limit));
    try {
      const res = await call("connectorRun", { id: c.id, limit: limit });
      props.onPack(res);
      const s = (res as { summary?: string }).summary;
      toast.add({
        title: limit ? "试运行完成" : "同步完成",
        description: s || undefined,
      });
      void load();
    } catch (e) {
      toast.add({ title: "同步没有完成", description: String((e as { message?: string }).message || e) });
    } finally {
      setRunning(null);
    }
  }

  async function save() {
    if (!draft) return;
    try {
      const res = await call("connectorSave", {
        connector: {
          id: draft.id || undefined,
          name: draft.name,
          kind: draft.kind,
          source: draftSource(draft),
          params: draft.params,
          rootPath: draft.rootPath,
          mapping: draft.mapping,
          options: { boardId: draft.boardId, syncDone: draft.syncDone },
        },
      });
      const r = res as { connectors?: Connector[] };
      if (r.connectors) setConnectors(r.connectors);
      toast.add({ title: "已保存" + (draft.id ? "" : "，可全量同步") });
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
              <span className={"size-1.5 shrink-0 rounded-full " + (c.lastRunResult && c.lastRunResult.indexOf("跳过 0") < 0 && c.lastRunResult.indexOf("HTTP") >= 0 ? "bg-destructive" : "bg-foreground/60")} />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{c.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {c.kind === "mcp"
                    ? "mcp · " + ("serverId" in c.source ? c.source.serverId + "/" + c.source.toolName : "")
                    : "http"}
                  {c.lastRunAt ? " · 上次 " + String(c.lastRunAt) : ""}
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
          <div className="mt-1 flex items-center justify-between">
            <button
              type="button"
              onClick={function () {
                const t = templates[templates.length - 1];
                setDraft(draftFromTemplate(t));
                setView("wizard");
                setStep(2);
                setSample(EMPTY_SAMPLE);
              }}
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              ＋ 新建连接器
            </button>
          </div>
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
                  <input value={draft.toolName} onChange={function (e) { patch(function (d) { d.toolName = e.target.value; }); }} className={inputCls} placeholder="getIssues" />
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
              请求参数决定“导入哪些”。导入后本地改动不会被同步覆盖，删除的任务不会复活。
            </p>
            {Object.keys(draft.params).length === 0 ? (
              <p className="mb-2 text-xs text-muted-foreground">暂无参数（Jira 常用 jql，GitHub 常用 state）</p>
            ) : null}
            {Object.keys(draft.params).map(function (k) {
              return (
                <div key={k} className="mb-2 grid grid-cols-3 gap-2">
                  <input
                    value={k}
                    readOnly
                    className={inputCls + " h-8 font-mono text-xs"}
                  />
                  <input
                    value={String(draft.params[k] ?? "")}
                    onChange={function (e) {
                      patch(function (d) { d.params[k] = e.target.value; });
                    }}
                    className={inputCls + " col-span-2 h-8 text-xs"}
                    placeholder="值"
                  />
                </div>
              );
            })}
            <button
              type="button"
              onClick={function () {
                const k = window.prompt("参数名（如 jql）");
                if (!k) return;
                const v = window.prompt("值") || "";
                patch(function (d) { d.params[k] = v; });
              }}
              className="mb-4 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              ＋ 加参数
            </button>
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
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-2.5 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)] lg:grid-cols-[280px_minmax(0,1.4fr)_300px]">
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
                        const a: Active | null = s.id === "title" || s.id === "externalId"
                          ? { slot: s.id, mode: "template" }
                          : s.id === "tags"
                            ? { slot: "tags" }
                            : s.id === "priority" || s.id === "notes" || s.id === "subtasks"
                              ? { slot: s.id, mode: "field" }
                              : null;
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
                        <SlotEditor slot={s.id} draft={draft} catalog={sample.catalog} rows={sample.rows} active={active} setActive={setActive} patch={patch} />
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
                            (c.type === "enum"
                              ? "border-foreground/30 text-muted-foreground"
                              : c.type === "date"
                                ? "border-foreground/30 text-muted-foreground"
                                : "border-border text-muted-foreground")
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
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              导入的任务先进板块，之后随你怎么挪——同步不会把它搬回去。本地删过的，不会复活。
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
                      const res = await call("connectorSave", {
                        connector: {
                          id: draft.id || undefined,
                          name: draft.name,
                          kind: draft.kind,
                          source: draftSource(draft),
                          params: draft.params,
                          rootPath: draft.rootPath,
                          mapping: draft.mapping,
                          options: { boardId: draft.boardId, syncDone: draft.syncDone },
                        },
                      });
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

function slotFilled(d: Draft, id: SlotId): boolean {
  const m = d.mapping;
  if (id === "externalId") return Boolean(evalSpec({}, m.externalId)) || ("field" in m.externalId && Boolean(m.externalId.field));
  if (id === "title") return ("template" in m.title && m.title.template.some(function (t) { return Boolean(t.field); })) || ("field" in m.title && Boolean(m.title.field)) || ("const" in m.title && Boolean(m.title.const));
  if (id === "priority") return Boolean(m.priority);
  if (id === "dates") return Boolean(m.due || m.starts);
  if (id === "notes") return Boolean(m.notes);
  if (id === "tags") return Boolean(m.tags && m.tags.length);
  if (id === "subtasks") return Boolean(m.subtasks);
  return false;
}
