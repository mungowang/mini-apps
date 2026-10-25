import * as React from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Icon,
  IlluEmpty,
  Kbd,
  ScrollArea,
  toast,
  useApp,
  WizardShell,
} from "@mohou/ui";

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
import {
  STOCK_JIRA_FIELDS,
  defaultParamsFor,
  detectDialect,
  missingRequired,
  AUTO_PICK_MIN_SCORE,
  autoPickTool,
  rankTools,
  recommendTool,
  unknownParamKeys,
} from "../shared/dialects";
import type { McpToolSchema } from "../shared/schema";
import { arrayPaths, allowsExtraParams, schemaProps } from "../shared/schema";
import { SchemaParamsForm } from "./schema-form";
import { useStore } from "./store";

/* ───────────────────────── draft ───────────────────────── */

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

/** title/externalId UI 只认 template|const；把遗留 field 形态归一成单 token 模板。 */
function normalizeMapping(m: ConnectorMapping): ConnectorMapping {
  const next: ConnectorMapping = JSON.parse(JSON.stringify(m));
  function toTpl(spec: ValueSpec | undefined): ValueSpec {
    if (!spec) return { template: [] };
    if ("const" in spec) return spec;
    if ("template" in spec && Array.isArray(spec.template)) return spec;
    if ("field" in spec && typeof spec.field === "string" && spec.field) {
      return { template: [{ field: spec.field }] };
    }
    return { template: [] };
  }
  next.externalId = toTpl(next.externalId) as ConnectorMapping["externalId"];
  next.title = toTpl(next.title) as ConnectorMapping["title"];
  return next;
}

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
    mapping: normalizeMapping(c.mapping),
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
    mapping: normalizeMapping(c.mapping),
    boardId: c.options.boardId,
    syncDone: c.options.syncDone,
    keepDeleted: c.options.keepDeleted !== false,
  };
}

function blankDraft(boardId: string): Draft {
  return {
    id: "",
    name: "",
    kind: "mcp",
    serverId: "",
    toolName: "",
    url: "",
    method: "GET",
    params: {},
    rootPath: "",
    mapping: { externalId: { template: [] }, title: { template: [] } },
    boardId: boardId,
    syncDone: true,
    keepDeleted: true,
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

/* ───────────────────────── template string helpers ───────────────────────── */

function parseTemplateString(s: string): TplToken[] {
  const out: TplToken[] = [];
  const re = /\{([^{}]+)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push({ lit: s.slice(last, m.index) });
    out.push({ field: m[1].trim() });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ lit: s.slice(last) });
  return out.filter(function (t) {
    return t.lit !== undefined ? t.lit !== "" : true;
  });
}

function templateToString(spec: ValueSpec): string {
  const t = "template" in spec && Array.isArray(spec.template) ? spec.template : [];
  return t
    .map(function (tok) {
      return tok.lit !== undefined ? tok.lit : "{" + String(tok.field) + "}";
    })
    .join("");
}

/* ───────────────────────── small pieces ───────────────────────── */

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

/* ───────────────────────── sample field discovery (generic) ───────────────────────── */

/**
 * From sample rows, collect candidate field names for a "fields" param.
 * Prefers keys under `fields` objects; falls back to top-level scalar keys.
 * No source-specific hardcoding — whatever the sample contains.
 */
function fieldsFromSample(rows: unknown[]): string[] {
  const seen: Record<string, boolean> = {};
  const out: string[] = [];
  function add(k: string) {
    if (!k || seen[k]) return;
    seen[k] = true;
    out.push(k);
  }
  rows.forEach(function (row) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return;
    const r = row as Record<string, unknown>;
    const fields = r.fields;
    if (fields && typeof fields === "object" && !Array.isArray(fields)) {
      Object.keys(fields as object).forEach(add);
      return;
    }
    Object.keys(r).forEach(function (k) {
      if (k === "id" || k === "key" || k === "self") return;
      add(k);
    });
  });
  return out;
}

/**
 * Clickable JSON tree. path uses dot + [] for arrays, e.g. fields.priority.name / fields.subtasks[].
 * - leaf/object click → onPickPath(fullPath)
 * - keys under fields.* also offer onToggleField(topLevelName) for the fields[] param
 */
function SampleTreeNode(props: {
  label?: string;
  value: unknown;
  path: string;
  depth: number;
  selectedFields: string[];
  onPickPath: (path: string) => void;
  onToggleField?: (name: string) => void;
}) {
  const isObj = props.value !== null && typeof props.value === "object";
  const [open, setOpen] = React.useState(props.depth < 3);
  const entries = isObj ? Object.entries(props.value as Record<string, unknown>) : [];

  // fields.foo → foo；fields.foo.bar 仍只 toggle foo
  const fieldsTop =
    props.path.indexOf("fields.") === 0
      ? props.path.slice("fields.".length).split(".")[0].replace(/\[\]$/, "")
      : null;
  const fieldOn = fieldsTop ? props.selectedFields.indexOf(fieldsTop) >= 0 : false;

  if (!isObj) {
    return (
      <div className="flex items-start gap-1 font-mono text-[11px]" style={{ paddingLeft: props.depth * 12 }}>
        <button
          type="button"
          title={"选用路径 " + props.path}
          onClick={function () { props.onPickPath(props.path); }}
          className="min-w-0 flex-1 truncate text-left hover:underline"
        >
          {props.label ? props.label + ": " : ""}
          <span className="text-muted-foreground">{JSON.stringify(props.value)}</span>
        </button>
        {fieldsTop && props.onToggleField ? (
          <button
            type="button"
            onClick={function () { props.onToggleField!(fieldsTop); }}
            className={"shrink-0 rounded border px-1 text-[9px] " + (fieldOn ? "border-foreground text-foreground" : "border-border text-muted-foreground")}
            title="加入/移出 fields 参数"
          >
            {fieldOn ? "fields✓" : "+fields"}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div style={{ paddingLeft: props.depth ? props.depth * 12 : 0 }}>
      <div className="flex items-center gap-1">
        <button type="button" className="font-mono text-[11px] text-left" onClick={function () { setOpen(function (v) { return !v; }); }}>
          {open ? "▾" : "▸"} {props.label ? props.label + ": " : ""}
          {Array.isArray(props.value) ? "Array(" + String(entries.length) + ")" : "Object"}
        </button>
        {props.path ? (
          <button
            type="button"
            title={"选用路径 " + props.path}
            onClick={function () { props.onPickPath(props.path); }}
            className="rounded border border-border px-1 font-mono text-[9px] text-muted-foreground hover:text-foreground"
          >
            路径
          </button>
        ) : null}
        {fieldsTop && props.onToggleField ? (
          <button
            type="button"
            onClick={function () { props.onToggleField!(fieldsTop); }}
            className={"rounded border px-1 text-[9px] " + (fieldOn ? "border-foreground text-foreground" : "border-border text-muted-foreground")}
          >
            {fieldOn ? "fields✓" : "+fields"}
          </button>
        ) : null}
      </div>
      {open
        ? entries.map(function (pair) {
            const key = pair[0];
            const child = pair[1];
            const childPath = Array.isArray(props.value)
              ? props.path
                ? props.path + "[]"
                : "[]"
              : props.path
                ? props.path + "." + key
                : key;
            // arrays: only show first element as shape sample
            if (Array.isArray(props.value) && Number(key) > 0) return null;
            return (
              <SampleTreeNode
                key={key}
                label={Array.isArray(props.value) ? "[0]" : key}
                value={child}
                path={childPath}
                depth={props.depth + 1}
                selectedFields={props.selectedFields}
                onPickPath={props.onPickPath}
                onToggleField={props.onToggleField}
              />
            );
          })
        : null}
    </div>
  );
}

/**
 * Right-side sample pane for step 范围:
 * - full expandable sample tree (depth 3 open)
 * - click value → pick path (toast + optional callback)
 * - +fields on keys under fields.* toggles the fields[] param
 */
function SamplePane(props: {
  sample: SampleState;
  fieldsParam: string[] | null;
  onToggleField?: (name: string) => void;
  onPickPath?: (path: string) => void;
  onSample: () => void;
  /** 临时去掉 fields 参数再取，用来发现默认/更多字段 */
  onWideSample?: () => void;
  canSample: boolean;
}) {
  const row = props.sample.rows[0];
  const candidates = fieldsFromSample(props.sample.rows);
  const selected = props.fieldsParam || [];

  function pick(path: string) {
    if (props.onPickPath) props.onPickPath(path);
    toast.add({ title: "已选路径", description: path });
  }

  return (
    <div className="flex h-full min-h-0 flex-col rounded-xl border border-border bg-muted/20">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <p className="text-[11px] tracking-[0.18em] text-muted-foreground">样本</p>
        <span className="text-[11px] text-muted-foreground">
          {props.sample.rows.length ? String(props.sample.count) + " 条 · 看第 1 条" : "还没有"}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {props.onWideSample ? (
            <Button size="sm" variant="ghost" className="h-7" disabled={!props.canSample || props.sample.loading} onClick={props.onWideSample} title="不传 fields，看源头默认返回哪些字段">
              宽取
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" className="h-7" disabled={!props.canSample || props.sample.loading} onClick={props.onSample}>
            {props.sample.loading ? "拉取中…" : props.sample.rows.length ? "重取" : "取样本"}
          </Button>
        </div>
      </div>
      {props.sample.error ? (
        <p className="px-3 py-2 text-xs text-destructive">{props.sample.error}</p>
      ) : null}
      {!props.sample.rows.length && !props.sample.loading ? (
        <div className="flex flex-1 items-center justify-center p-4">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <IlluEmpty className="size-24" />
              </EmptyMedia>
              <EmptyTitle>先取一条样本</EmptyTitle>
              <EmptyDescription>右侧展开真实字段；点叶子取路径，+fields 写入参数。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-3 p-3">
            <p className="text-[10.5px] leading-relaxed text-muted-foreground">
              样本里只会出现「fields 参数」点过名的字段。自定义字段先在左侧 fields 写 id（如 customfield_12345）再重取。
              点叶子/「路径」→ 得到映射路径（如 fields.priority.name）；+fields → 写入请求参数。
            </p>
            {props.fieldsParam !== null && candidates.length ? (
              <div>
                <p className="mb-1.5 text-[11px] text-muted-foreground">样本里出现的 fields.*（点选进参数）</p>
                <div className="flex flex-wrap gap-1">
                  {candidates.map(function (f) {
                    const on = selected.indexOf(f) >= 0;
                    return (
                      <button
                        key={f}
                        type="button"
                        onClick={function () {
                          if (props.onToggleField) props.onToggleField(f);
                        }}
                        className={
                          "rounded-full border px-2 py-0.5 font-mono text-[10.5px] " +
                          (on ? "border-foreground bg-background text-foreground" : "border-border text-muted-foreground hover:text-foreground")
                        }
                      >
                        {f}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {row !== undefined ? (
              <div className="overflow-hidden rounded-lg border border-border bg-background p-2">
                <SampleTreeNode
                  value={row}
                  path=""
                  depth={0}
                  selectedFields={selected}
                  onPickPath={pick}
                  onToggleField={props.onToggleField}
                />
              </div>
            ) : null}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

/* ───────────────────────── slot model ───────────────────────── */

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

type Active =
  | { slot: "title" | "externalId" }
  | { slot: "priority" | "notes" | "subtasks" | "tags" }
  | { slot: "dates"; sub: "due" | "starts" };

function specFilled(spec: ValueSpec | TplToken[] | undefined): boolean {
  if (!spec) return false;
  if (Array.isArray(spec)) return spec.length > 0;
  if ("const" in (spec as object) && typeof (spec as { const?: unknown }).const === "string") {
    // 空字符串不算已设（空白模板的 const:""）
    return Boolean((spec as { const: string }).const);
  }
  if ("template" in (spec as object)) {
    const t = (spec as { template?: TplToken[] }).template;
    return Array.isArray(t) && t.length > 0;
  }
  const f = (spec as { field?: string }).field;
  if (typeof f === "string") return Boolean(f);
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
          <SegBtn on={!("const" in spec)} label="模板" onClick={function () { setActive({ slot: slot }); setSpec({ template: tokens.length ? tokens : [] }); }} />
          <SegBtn on={"const" in spec} label="固定值" onClick={function () { setSpec({ const: "" }); }} />
        </div>
        {"const" in spec ? (
          <input
            value={spec.const}
            onChange={function (e) { setSpec({ const: e.target.value }); }}
            className={inputCls + " h-8"}
            placeholder={slot === "title" ? "所有任务同一标题" : "固定唯一键"}
          />
        ) : (
          <div className="space-y-2">
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
                        if ("template" in s && Array.isArray(s.template)) s.template.splice(i, 1);
                      });
                    }}
                  />
                );
              })}
            </div>
            <input
              value={templateToString(spec)}
              onChange={function (e) { setSpec({ template: parseTemplateString(e.target.value) }); }}
              className={inputCls + " h-8 font-mono text-[11.5px]"}
              placeholder={"{key}: {fields.summary}"}
              aria-label="模板字符串"
            />
            <p className="text-[11px] text-muted-foreground">{"{字段路径}"} 引用字段；也可在目录里点字段追加</p>
          </div>
        )}
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
                            const next: Record<string, string> = Object.assign({}, p.map);
                            next[v] = val;
                            p.map = next;
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
          {spec && "const" in spec ? (
            <p className="mt-1 text-[11px] text-muted-foreground">固定日期只在导入时写入，之后同步不会改它。</p>
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
        {spec && "field" in spec && spec.field ? <FieldChip path={spec.field} /> : null}
        {spec && "const" in spec ? (
          <input
            value={spec.const}
            onChange={function (e) { patch(function (d) { if (slot === "notes") d.mapping.notes = { const: e.target.value }; else d.mapping.subtasks = { const: e.target.value }; }); }}
            className={inputCls + " h-8 mt-2"}
            placeholder={slot === "notes" ? "固定文本" : "一条子任务"}
          />
        ) : null}
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
      <button type="button" onClick={function () { setActive({ slot: "tags" }); }} className="rounded-full border border-dashed border-border px-2.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground">
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
        <button type="button" onClick={function () { setAdding(true); }} className="rounded-full border border-dashed border-border px-2.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground">
          ＋ 固定
        </button>
      )}
    </div>
  );
}

/* ───────────────────────── main ───────────────────────── */

export function Connect(props: { onPack: (res: unknown) => void; onClose: () => void }) {
  const { call } = useApp();
  const { boards, today, actions } = useStore();
  const defaultBoard = boards[0] ? boards[0].id : "default";

  const [view, setView] = React.useState<"list" | "wizard">("list");
  /** 0-based wizard index: 模板 / 连接 / 范围 / 映射 / 落点 */
  const [step, setStep] = React.useState(0);
  const [connectors, setConnectors] = React.useState<Connector[]>([]);
  const [templates, setTemplates] = React.useState<ConnectorTemplate[]>([]);
  type McpServerRow = { id: string; status: string; tools?: string[]; error?: { code: string; message?: string } };
  const [mcpServers, setMcpServers] = React.useState<McpServerRow[]>([]);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [sample, setSample] = React.useState<SampleState>(EMPTY_SAMPLE);
  const [active, setActive] = React.useState<Active | null>(null);
  const [catQuery, setCatQuery] = React.useState("");
  const [running, setRunning] = React.useState<string | null>(null);
  /** 面板内联同步结果（试运行留下看；全量成功会关 dialog 改走主界面 toast） */
  const [runNote, setRunNote] = React.useState<null | { kind: "trial" | "full"; status: "running" | "ok" | "err"; text: string }>(null);
  const [tried, setTried] = React.useState(false);
  const [focusParam, setFocusParam] = React.useState<string | null>(null);

  /* ── tool schemas: fetched per server, on demand ── */
  type CatalogEntryState = { loading: boolean; error: string | null; unsupported: boolean; tools: McpToolSchema[] };
  const [catalog, setCatalog] = React.useState<Record<string, CatalogEntryState>>({});
  const catalogAsked = React.useRef<Record<string, boolean>>({});
  /** Jira's real field ids, loaded only when the user asks for them. */
  const [instanceFields, setInstanceFields] = React.useState<Record<string, string[]>>({});
  const [fieldsLoading, setFieldsLoading] = React.useState(false);
  /** Inline board creation on the 落点 step: the board a user needs may not exist yet. */
  const [boardAdding, setBoardAdding] = React.useState(false);
  const [boardDraft, setBoardDraft] = React.useState("");
  const [boardBusy, setBoardBusy] = React.useState(false);

  const ensureCatalog = React.useCallback(
    async function (serverId: string, refresh?: boolean) {
      if (!serverId) return;
      if (catalogAsked.current[serverId] && !refresh) return;
      catalogAsked.current[serverId] = true;
      setCatalog(function (prev) {
        const next: Record<string, CatalogEntryState> = Object.assign({}, prev);
        next[serverId] = { loading: true, error: null, unsupported: false, tools: (prev[serverId] || { tools: [] }).tools };
        return next;
      });
      try {
        const res = await call("mcpToolCatalog", { serverId: serverId, refresh: refresh === true });
        const r = res as { tools?: McpToolSchema[]; unsupported?: boolean };
        setCatalog(function (prev) {
          const next: Record<string, CatalogEntryState> = Object.assign({}, prev);
          next[serverId] = { loading: false, error: null, unsupported: r.unsupported === true, tools: r.tools || [] };
          return next;
        });
      } catch (e) {
        catalogAsked.current[serverId] = false;
        setCatalog(function (prev) {
          const next: Record<string, CatalogEntryState> = Object.assign({}, prev);
          next[serverId] = { loading: false, error: String((e as { message?: string }).message || e), unsupported: false, tools: [] };
          return next;
        });
      }
    },
    [call]
  );

  /** The schema the wizard is currently working against, if the server listed it. */
  function toolSchema(d: Draft): McpToolSchema | null {
    const entry = catalog[d.serverId];
    if (!entry || !entry.tools.length) return null;
    for (let i = 0; i < entry.tools.length; i++) {
      if (entry.tools[i].name === d.toolName) return entry.tools[i];
    }
    return null;
  }

  /** Pull the schema as soon as a server is picked, and once on entry. */
  React.useEffect(
    function () {
      if (!draft || draft.kind !== "mcp" || !draft.serverId) return;
      if (step !== 1 && step !== 2) return;
      void ensureCatalog(draft.serverId);
    },
    [draft, step, ensureCatalog]
  );

  /**
   * Pick the tool for an empty template. Ranking reads the schema, so a server
   * renamed or swapped for a different Jira build still resolves correctly.
   */
  React.useEffect(
    function () {
      if (!draft || draft.kind !== "mcp" || !draft.serverId) return;
      const entry = catalog[draft.serverId];
      if (!entry || entry.loading || !entry.tools.length) return;
      const known = draft.toolName && entry.tools.some(function (t) { return t.name === draft.toolName; });
      if (known) return;
      const pick = autoPickTool(entry.tools);
      if (!pick) return;
      setDraft(function (prev) {
        if (!prev) return prev;
        const next: Draft = JSON.parse(JSON.stringify(prev));
        next.toolName = pick.tool.name;
        if (Object.keys(next.params).length === 0) next.params = defaultParamsFor(pick.tool);
        return next;
      });
    },
    [draft, catalog]
  );

  async function loadInstanceFields(serverId: string) {
    if (!serverId || fieldsLoading) return;
    setFieldsLoading(true);
    try {
      const res = await call("jiraFields", { serverId: serverId });
      const r = res as { fields?: Array<{ id?: string }> };
      const ids = (r.fields || []).map(function (f) { return String(f.id || ""); }).filter(Boolean);
      setInstanceFields(function (prev) {
        const next = Object.assign({}, prev);
        next[serverId] = ids;
        return next;
      });
    } catch (e) {
      toast.add({ title: "拉字段失败", description: String((e as { message?: string }).message || e) });
    } finally {
      setFieldsLoading(false);
    }
  }

  /**
   * Create a board from the 落点 step and select it. A failed create (duplicate
   * name is the usual one) leaves the field open so the name can be fixed.
   */
  async function commitBoardAdd() {
    const name = boardDraft.trim();
    if (!name || boardBusy) return;
    setBoardBusy(true);
    try {
      const id = await actions.addBoard(name);
      if (!id) return;
      patch(function (d) { d.boardId = id; });
      setBoardAdding(false);
      setBoardDraft("");
    } catch (e) {
      toast.add({ title: "建板块失败", description: String((e as { message?: string }).message || e) });
    } finally {
      setBoardBusy(false);
    }
  }

  const load = React.useCallback(
    async function () {
      try {
        const res = await call("connectorsList", {});
        if (res && typeof res === "object" && Array.isArray((res as { connectors?: Connector[] }).connectors)) {
          setConnectors((res as { connectors: Connector[] }).connectors);
          setTemplates(((res as { templates?: ConnectorTemplate[] }).templates || []) as ConnectorTemplate[]);
          setMcpServers(((res as { mcpServers?: McpServerRow[] }).mcpServers || []) as McpServerRow[]);
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
    patch(function (d) {
      if (a.slot === "notes") d.mapping.notes = { field: path };
      else d.mapping.subtasks = { field: path };
    });
  }

  async function runConnector(c: Connector, limit: number) {
    const kind = limit ? ("trial" as const) : ("full" as const);
    setRunning(c.id + ":" + String(limit));
    setRunNote({ kind: kind, status: "running", text: kind === "trial" ? "试运行中…" : "同步中…" });
    try {
      const res = await call("connectorRun", { id: c.id, limit: limit });
      props.onPack(res);
      const s = String((res as { summary?: string }).summary || "完成");
      void load();
      if (kind === "full") {
        // 全量：关面板，让主界面 toast 不被 dialog 挡住，用户直接看到清单变化
        setRunNote(null);
        props.onClose();
        // 关后再弹，避免仍挂在 dialog 层下
        window.setTimeout(function () {
          toast.add({ title: "同步完成 · " + c.name, description: s });
        }, 80);
      } else {
        setRunNote({ kind: "trial", status: "ok", text: s });
      }
    } catch (e) {
      const msg = String((e as { message?: string }).message || e);
      setRunNote({ kind: kind, status: "err", text: msg });
      if (kind === "full") {
        // 失败留在面板看错误，不关
        toast.add({ title: "同步没有完成", description: msg });
      }
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
      setStep(0);
      setDraft(null);
      setSample(EMPTY_SAMPLE);
    } catch (e) {
      toast.add({ title: "没保存成", description: String((e as { message?: string }).message || e) });
    }
  }

  function startNew() {
    setDraft(blankDraft(defaultBoard));
    setView("wizard");
    setStep(0);
    setSample(EMPTY_SAMPLE);
    setActive(null);
    setTried(false);
  }

  function startFromTemplate(t: ConnectorTemplate) {
    const d = draftFromTemplate(t);
    if (!d.boardId || d.boardId === "default") d.boardId = defaultBoard;
    setDraft(d);
    setView("wizard");
    setStep(1);
    setSample(EMPTY_SAMPLE);
    setActive(null);
    setTried(false);
  }

  function startEdit(c: Connector) {
    const d = draftFromConnector(c);
    setDraft(d);
    setView("wizard");
    setStep(1);
    setActive(null);
    setTried(false);
    void takeSample(d);
  }

  const boardName = function (id: string): string {
    const b = boards.find(function (x) { return x.id === id; });
    return b ? b.name : id;
  };

  /* ─── list body ─── */

  function renderList() {
    return (
      <div className="flex min-h-0 flex-1 flex-col px-5 pb-5 pt-2">
        {runNote ? (
          <div
            className={
              "mb-3 rounded-lg border px-3 py-2 text-xs " +
              (runNote.status === "err"
                ? "border-destructive/40 bg-destructive/5 text-destructive"
                : runNote.status === "running"
                  ? "border-border bg-muted text-muted-foreground"
                  : "border-border bg-muted text-foreground")
            }
            role="status"
          >
            <span className="font-medium">{runNote.kind === "trial" ? "试运行" : "同步"}</span>
            <span className="mx-1.5 text-muted-foreground">·</span>
            <span>{runNote.text}</span>
            {runNote.status !== "running" ? (
              <button type="button" className="ml-2 underline underline-offset-2" onClick={function () { setRunNote(null); }}>
                知道了
              </button>
            ) : null}
          </div>
        ) : null}
        {connectors.length === 0 ? (
          <div className="mb-4">
            <p className="mb-3 text-sm text-muted-foreground">从模板开始，五步配好一个数据源。</p>
            <div className="grid gap-2.5 sm:grid-cols-3">
              {templates.map(function (t) {
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={function () { startFromTemplate(t); }}
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
        <ScrollArea className="min-h-0 flex-1">
          <div className="pr-2">
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
                    <Button size="sm" variant="ghost" disabled={busy} onClick={function () { startEdit(c); }}>
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
          </div>
        </ScrollArea>
        {connectors.length ? (
          <button type="button" onClick={startNew} className="mt-3 self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
            ＋ 新建连接器
          </button>
        ) : null}
      </div>
    );
  }

  /* ─── wizard bodies ─── */

  function bodyTemplate() {
    return (
      <div>
        <p className="mb-3 text-sm text-muted-foreground">选一个起点。之后每一步都能改。</p>
        {templates.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <IlluEmpty className="size-28" />
              </EmptyMedia>
              <EmptyTitle>没有模板</EmptyTitle>
              <EmptyDescription>也可以从空白开始。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid gap-2.5 sm:grid-cols-3">
            {templates.map(function (t) {
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={function () {
                    const d = draftFromTemplate(t);
                    if (!d.boardId || d.boardId === "default") d.boardId = defaultBoard;
                    setDraft(d);
                    setStep(1);
                    setSample(EMPTY_SAMPLE);
                  }}
                  className="rounded-xl border border-border p-4 text-left transition-colors hover:bg-muted"
                >
                  <p className="mb-1 text-sm font-semibold">{t.name}</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">{t.description}</p>
                </button>
              );
            })}
          </div>
        )}
        <button
          type="button"
          onClick={function () {
            setDraft(blankDraft(defaultBoard));
            setStep(1);
            setSample(EMPTY_SAMPLE);
          }}
          className="mt-4 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          从空白开始
        </button>
      </div>
    );
  }

  function bodyConnect() {
    if (!draft) return null;
    const canSample = draft.kind === "mcp" ? Boolean(draft.serverId && draft.toolName) : Boolean(draft.url);
    return (
      <div className="max-w-lg">
        <Labeled label="名字">
          <input value={draft.name} onChange={function (e) { patch(function (d) { d.name = e.target.value; }); }} className={inputCls} placeholder="工作清单" />
        </Labeled>
        <div className="mt-3 inline-flex overflow-hidden rounded-md border border-border">
          <SegBtn on={draft.kind === "mcp"} label="MCP 工具" onClick={function () { patch(function (d) { d.kind = "mcp"; }); }} />
          <SegBtn on={draft.kind === "http"} label="HTTP" onClick={function () { patch(function (d) { d.kind = "http"; }); }} />
        </div>
        {draft.kind === "mcp" ? (
          <div className="mt-3 grid grid-cols-2 gap-2.5">
            <Labeled label="MCP Server">
              {mcpServers.length ? (
                <select
                  value={draft.serverId}
                  onChange={function (e) {
                    const id = e.target.value;
                    patch(function (d) {
                      d.serverId = id;
                      // The tool and its parameters belong to the old server.
                      d.toolName = "";
                      d.params = {};
                    });
                    void ensureCatalog(id);
                  }}
                  className={inputCls}
                >
                  <option value="">选一个已接入的 server…</option>
                  {mcpServers.map(function (s) {
                    const label =
                      s.status === "alive"
                        ? s.id + (s.tools && s.tools.length ? " · " + String(s.tools.length) + " tools" : "")
                        : s.id + " · 不可用" + (s.error && s.error.code ? " (" + s.error.code + ")" : "");
                    return (
                      <option key={s.id} value={s.id} disabled={s.status !== "alive"}>
                        {label}
                      </option>
                    );
                  })}
                </select>
              ) : (
                <input
                  value={draft.serverId}
                  onChange={function (e) { patch(function (d) { d.serverId = e.target.value; }); }}
                  className={inputCls}
                  placeholder="host 未返回列表时手填 server id"
                />
              )}
            </Labeled>
            <Labeled label="工具">
              {function () {
                const row = mcpServers.find(function (s) { return s.id === draft.serverId; });
                const tools = (row && row.tools) || [];
                if (tools.length) {
                  return (
                    <select
                      value={draft.toolName}
                      onChange={function (e) {
                        const name = e.target.value;
                        patch(function (d) {
                          d.toolName = name;
                          const entry = catalog[d.serverId];
                          const t = entry
                            ? entry.tools.find(function (x) { return x.name === name; })
                            : undefined;
                          d.params = t ? defaultParamsFor(t) : {};
                        });
                      }}
                      className={inputCls}
                    >
                      <option value="">选工具…</option>
                      {tools.map(function (t) {
                        return (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        );
                      })}
                    </select>
                  );
                }
                return (
                  <input
                    value={draft.toolName}
                    onChange={function (e) { patch(function (d) { d.toolName = e.target.value; }); }}
                    className={inputCls}
                    placeholder={draft.serverId ? "该 server 无工具列表，手填" : "先选 server"}
                  />
                );
              }()}
            </Labeled>
            {function () {
              const row = mcpServers.find(function (s) { return s.id === draft.serverId; });
              if (row && row.status !== "alive") {
                return (
                  <p className="col-span-2 text-[11px] text-destructive">
                    {row.id} 不可用{row.error ? "：" + (row.error.message || row.error.code) : ""}
                  </p>
                );
              }
              if (!mcpServers.length) {
                return <p className="col-span-2 text-[11px] text-muted-foreground">没有从 host 拉到 MCP 列表，可手填。</p>;
              }
              return (
                <p className="col-span-2 text-[11px] text-muted-foreground">
                  共 {String(mcpServers.filter(function (s) { return s.status === "alive"; }).length)} 个可用 server（host mcpServers）
                </p>
              );
            }()}
            {function () {
              const entry = catalog[draft.serverId];
              if (draft.kind !== "mcp" || !draft.serverId) return null;
              if (!entry) return null;
              if (entry.error) {
                return <p className="col-span-2 text-[11px] text-destructive">读不到该 server 的工具 schema：{entry.error}</p>;
              }
              if (entry.unsupported) {
                return (
                  <p className="col-span-2 text-[11px] text-muted-foreground">
                    当前 host 没有 ctx.mcpTools，参数只能手填（host ≥ 1.0.100 才有 schema）。
                  </p>
                );
              }
              if (entry.loading) {
                return <p className="col-span-2 text-[11px] text-muted-foreground">正在读工具 schema…</p>;
              }
              const ranked = rankTools(entry.tools);
              const pick = recommendTool(entry.tools);
              if (!pick) {
                return (
                  <p className="col-span-2 text-[11px] text-muted-foreground">
                    共 {String(entry.tools.length)} 个工具，没有可推荐的，请手选。
                  </p>
                );
              }
              const chosen = draft.toolName === pick.tool.name;
              const strong = pick.score >= AUTO_PICK_MIN_SCORE;
              return (
                <p className="col-span-2 text-[11px] text-muted-foreground">
                  {strong ? "推荐 " : "较像列表的 "}
                  <span className="font-mono text-foreground">{pick.tool.name}</span>（{pick.reason}）
                  {chosen ? " · 已选" : strong ? "" : " · 没自动选，请确认"}
                  {ranked.length > 1 ? " · 另有 " + String(ranked.length - 1) + " 个候选" : ""}
                </p>
              );
            }()}
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-3 gap-2.5">
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
        <div className="mt-4 flex items-center gap-2">
          <Button size="sm" disabled={!canSample || sample.loading} onClick={function () { void takeSample(draft); }}>
            {sample.loading ? "取样本中…" : sample.rows.length ? "重新取样本" : "测试连接 · 取样本"}
          </Button>
          {sample.error ? <p className="text-xs text-destructive">{sample.error}</p> : null}
          {!sample.error && sample.rows.length ? <p className="text-xs text-muted-foreground">✓ 拿到 {String(sample.count)} 条</p> : null}
        </div>
      </div>
    );
  }

  function bodyScope() {
    if (!draft) return null;
    const canSample = draft.kind === "mcp" ? Boolean(draft.serverId && draft.toolName) : Boolean(draft.url);
    const fieldsVal = Array.isArray(draft.params.fields) ? (draft.params.fields as unknown[]).map(String) : null;

    const entry = catalog[draft.serverId];
    const tool = draft.kind === "mcp" ? toolSchema(draft) : null;
    const dialect = tool ? detectDialect(tool.inputSchema) : null;
    const stale = tool ? unknownParamKeys(tool, draft.params) : [];
    const miss = tool ? missingRequired(tool, draft.params) : [];

    const suggestions: Record<string, string[]> = {};
    if (dialect && dialect.id === "jira") suggestions.fields = STOCK_JIRA_FIELDS.slice();
    if (draft.serverId && instanceFields[draft.serverId]) {
      const base = suggestions.fields || [];
      const extra = instanceFields[draft.serverId].filter(function (id) { return base.indexOf(id) < 0; });
      suggestions.fields = base.concat(extra);
    }

    const schemaRoots = tool && tool.outputSchema ? arrayPaths(tool.outputSchema) : [];
    const rootChips = schemaRoots
      .concat(sample.roots)
      .concat([draft.rootPath || "$"])
      .filter(function (r, i, all) { return all.indexOf(r) === i; });

    function toggleField(f: string) {
      patch(function (d) {
        const cur = Array.isArray(d.params.fields) ? (d.params.fields as unknown[]).map(String) : [];
        const at = cur.indexOf(f);
        if (at >= 0) cur.splice(at, 1);
        else cur.push(f);
        d.params.fields = cur;
      });
    }

    return (
      <div className="grid h-full min-h-[420px] grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="min-h-0 overflow-y-auto pr-1">
          <p className="mb-3 text-sm text-muted-foreground">
            请求参数决定「导入哪些」。导入后本地改动不会被同步覆盖；本地删过的默认不再导入。
          </p>
          {!tool && entry && (entry.loading || entry.error || entry.unsupported) ? (
            <p className="mb-2 text-[11px] text-muted-foreground">
              {entry.loading
                ? "正在读工具 schema…"
                : entry.unsupported
                  ? "当前 host 没有 ctx.mcpTools，参数只能手填（host ≥ 1.0.100 才有 schema）。"
                  : "读不到 schema：" + String(entry.error)}
            </p>
          ) : null}
          {tool ? (
            <div className="mb-3">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span className="font-mono text-foreground">{tool.name}</span>
                <span>· 参数来自这个工具自己的 inputSchema</span>
              </div>
              {stale.length ? (
                <p className="mb-2 text-[11px] text-destructive">
                  该工具不认这些参数：<span className="font-mono">{stale.join(", ")}</span>
                </p>
              ) : null}
              {miss.length ? (
                <p className="mb-2 text-[11px] text-muted-foreground">
                  还差必填：<span className="font-mono">{miss.join(", ")}</span>
                </p>
              ) : null}
              <SchemaParamsForm
                schema={tool.inputSchema}
                values={draft.params}
                allowExtra={allowsExtraParams(tool.inputSchema)}
                suggestions={suggestions}
                onChange={function (next) { patch(function (d) { d.params = next; }); }}
              />
              {dialect && dialect.id === "jira" && "fields" in schemaProps(tool.inputSchema) ? (
                <button
                  type="button"
                  disabled={fieldsLoading}
                  onClick={function () { void loadInstanceFields(draft.serverId); }}
                  className="mt-2 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  {fieldsLoading
                    ? "正在读实例字段…"
                    : instanceFields[draft.serverId]
                      ? "已载入 " + String(instanceFields[draft.serverId].length) + " 个实例字段"
                      : "从实例加载字段（含自定义字段）"}
                </button>
              ) : null}
            </div>
          ) : null}
          {tool ? null : Object.keys(draft.params).map(function (k) {
            const v = draft.params[k];
            const isArr = Array.isArray(v);
            const focused = focusParam === k;
            return (
              <div
                key={k}
                className={"mb-2.5 rounded-lg border p-2 " + (focused ? "border-foreground/40 bg-muted/40" : "border-transparent")}
                onFocusCapture={function () { setFocusParam(k); }}
              >
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
                        const nv = e.target.value;
                        patch(function (d) { d.params[k] = nv; });
                      }}
                      className={inputCls + " col-span-2 h-8 text-xs"}
                      placeholder="值"
                    />
                  )}
                  <div className="col-span-3">
                    {isArr ? (
                      <textarea
                        value={(v as unknown[]).map(String).join("\n")}
                        onChange={function (e) {
                          const lines = e.target.value.split("\n");
                          patch(function (d) { d.params[k] = lines; });
                        }}
                        rows={Math.min(8, Math.max(3, (v as unknown[]).length + 1))}
                        className="w-full rounded-md border border-input bg-transparent px-2 py-1 font-mono text-[11px] outline-none focus:border-foreground"
                        placeholder={"一行一个" + (k === "fields" ? "字段名" : "值")}
                      />
                    ) : null}
                    <div className="mt-1 flex justify-end">
                      <button type="button" onClick={function () { patch(function (d) { delete d.params[k]; }); }} className="text-[11px] text-muted-foreground hover:text-destructive">
                        ✕ 删
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          {tool ? null : (
            <button
              type="button"
              onClick={function () {
                const nk = "p" + String(Object.keys(draft.params).length + 1);
                patch(function (d) { d.params[nk] = ""; });
              }}
              className="mb-3 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              ＋ 加参数
            </button>
          )}

          <p className="mb-1.5 text-xs text-muted-foreground">样本根路径</p>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {rootChips.map(function (r) {
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
        </div>

        <SamplePane
          sample={sample}
          fieldsParam={fieldsVal}
          onToggleField={toggleField}
          onSample={function () { void takeSample(draft); }}
          onWideSample={function () {
            // 临时去掉 fields，发现源头默认字段集（不改 draft.params）
            const d: Draft = JSON.parse(JSON.stringify(draft));
            delete d.params.fields;
            void takeSample(d);
          }}
          canSample={canSample}
        />
      </div>
    );
  }

  function bodyMap() {
    if (!draft) return null;
    return (
      <div className="grid min-h-[420px] grid-cols-1 gap-2.5 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)] lg:grid-cols-[280px_minmax(0,1.4fr)_280px]">
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
                        : { slot: s.id as Exclude<Active, { slot: "dates" }>["slot"] };
                    setActive(a);
                  }}
                  className={"w-full rounded-lg border px-2.5 py-2 text-left " + (on ? "border-foreground/30 bg-muted" : "border-transparent hover:bg-muted/50")}
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
        <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border">
          <p className="px-3 pb-1 pt-2.5 text-[11px] tracking-[0.18em] text-muted-foreground">字段目录 · {String(sample.count)} 条样本</p>
          <div className="px-2 pb-1.5">
            <input value={catQuery} onChange={function (e) { setCatQuery(e.target.value); }} placeholder="搜索字段…" className={inputCls + " h-7 text-xs"} />
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
                    <span className="shrink-0 rounded border border-border px-1 text-[9.5px] text-muted-foreground">{c.type}</span>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
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
                    return (
                      <span key={t} className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {"#" + t}
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {!previews.length ? <p className="px-3 py-3 text-xs text-muted-foreground">取样本后这里实时映射</p> : null}
        </div>
      </div>
    );
  }

  function bodyLanding() {
    if (!draft) return null;
    return (
      <div className="max-w-md">
        <Labeled label="导入到板块">
          {boardAdding ? (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={boardDraft}
                placeholder="新板块名…"
                onChange={function (e) { setBoardDraft(e.target.value); }}
                onKeyDown={function (e) {
                  if (e.key === "Enter") void commitBoardAdd();
                  if (e.key === "Escape") {
                    setBoardAdding(false);
                    setBoardDraft("");
                  }
                }}
                className={inputCls + " flex-1"}
              />
              <Button
                size="sm"
                disabled={!boardDraft.trim() || boardBusy}
                onClick={function () { void commitBoardAdd(); }}
              >
                {boardBusy ? "建…" : "建"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={function () {
                  setBoardAdding(false);
                  setBoardDraft("");
                }}
              >
                取消
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <select value={draft.boardId} onChange={function (e) { patch(function (d) { d.boardId = e.target.value; }); }} className={inputCls + " min-w-0 flex-1"}>
                {boards.map(function (b) {
                  return (
                    <option key={b.id} value={b.id}>
                      {b.name + (b.fixed ? "（默认）" : "")}
                    </option>
                  );
                })}
              </select>
              <button
                type="button"
                aria-label="新建板块"
                title="新建板块"
                onClick={function () { setBoardAdding(true); setBoardDraft(""); }}
                className="grid size-9 shrink-0 place-items-center rounded-md border border-input text-muted-foreground outline-none transition-colors hover:border-foreground hover:text-foreground focus-visible:border-foreground"
              >
                <Icon.Plus size={15} strokeWidth={2} />
              </button>
            </div>
          )}
        </Labeled>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={draft.syncDone} onChange={function (e) { patch(function (d) { d.syncDone = e.target.checked; }); }} className="size-3.5 accent-foreground" />
          远端关闭 / Done 的任务标为完成
        </label>
        <label className="mt-2.5 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={draft.keepDeleted} onChange={function (e) { patch(function (d) { d.keepDeleted = e.target.checked; }); }} className="size-3.5 accent-foreground" />
          本地删过的外部任务不再导入
        </label>
        <p className="mt-1 text-[11px] text-muted-foreground">关掉后下次同步会清掉墓碑并重新导入。须先「保存」或「试运行」才会写进连接器；列表页直接点同步用的是已保存的配置。</p>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">导入的任务先进板块，之后随你怎么挪——同步不会把它搬回去。</p>
        <div className="mt-5 rounded-xl border border-dashed border-border p-3.5">
          <p className="mb-2 text-xs text-muted-foreground">先真实导入 3 条看看</p>
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
                  const saved = (r.connectors || []).find(function (c) { return c.name === draft.name; }) || (r.connectors || [])[0];
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
              保存
            </Button>
          </div>
          {tried ? <p className="mt-2 text-xs text-muted-foreground">已导入 3 条到「{boardName(draft.boardId)}」</p> : null}
        </div>
      </div>
    );
  }

  function wizardBody() {
    if (step === 0) return bodyTemplate();
    if (step === 1) return bodyConnect();
    if (step === 2) return bodyScope();
    if (step === 3) return bodyMap();
    return bodyLanding();
  }

  const canSample = draft
    ? draft.kind === "mcp"
      ? Boolean(draft.serverId && draft.toolName)
      : Boolean(draft.url)
    : false;
  const mappedOk = previews.filter(function (p) { return p.title && p.externalId; }).length > 0;

  const wizardSteps = [
    { id: "tpl", label: "模板", valid: true },
    { id: "conn", label: "连接", valid: canSample },
    { id: "scope", label: "范围", valid: sample.rows.length > 0 },
    { id: "map", label: "映射", valid: mappedOk },
    { id: "land", label: "落点", valid: Boolean(draft && draft.boardId) },
  ];

  return (
    <Dialog
      open
      onOpenChange={function (o) {
        if (!o) props.onClose();
      }}
    >
      <DialogContent
        width={960}
        showCloseButton
        className="flex h-[min(780px,92vh)] max-h-[92vh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[960px]"
        data-kedu="connect"
      >
        <DialogHeader className="shrink-0 border-b border-border px-5 py-3 text-left">
          <div className="flex items-center gap-3 pr-8">
            <DialogTitle className="text-[11px] font-normal tracking-[0.42em] text-muted-foreground">接 入</DialogTitle>
            <DialogDescription className="sr-only">从外部系统导入任务</DialogDescription>
            {view === "wizard" && draft ? (
              <span className="ml-auto text-xs text-muted-foreground">{draft.name || "未命名"}</span>
            ) : (
              <span className="ml-auto" />
            )}
            <Kbd>esc</Kbd>
          </div>
        </DialogHeader>

        {view === "list" ? (
          renderList()
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-border px-4 py-1.5">
              <button
                type="button"
                onClick={function () {
                  setView("list");
                  setDraft(null);
                  setSample(EMPTY_SAMPLE);
                  setStep(0);
                }}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                ← 返回列表
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <WizardShell
                steps={wizardSteps}
                index={step}
                body={wizardBody()}
                onBack={function () {
                  if (step === 0) {
                    setView("list");
                    setDraft(null);
                    return;
                  }
                  setStep(step - 1);
                }}
                onNext={function () {
                  if (step === 1 && draft && !sample.rows.length) void takeSample(draft);
                  setStep(Math.min(4, step + 1));
                }}
                onSubmit={function () {
                  void save();
                }}
              />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
