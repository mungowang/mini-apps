/**
 * Dialect defaults — "开箱即用" without pinning one server.
 *
 * A dialect is recognised from a tool's own `inputSchema`, never from the
 * server id or the tool name. That is why an unknown Jira MCP server still
 * gets the right starting values: what makes it Jira is that it takes `jql`.
 *
 * Layering, weakest to strongest:
 *   1. the schema's own `default` / `examples` / `enum[0]`
 *   2. this dialect's values
 *   3. whatever the user last typed (the wizard never overwrites that)
 */
import type { ConnectorMapping } from "./connectors";
import type { JsonSchema, McpToolSchema } from "./schema";
import { paramKind, schemaDefault, schemaProps, schemaRequired } from "./schema";

/* ───────────────────────── Jira vocabulary ───────────────────────── */

/**
 * Fields every Jira instance carries, keyed by their system id.
 * No `customfield_xxxxx`: epic/sprint/environment are instance-specific,
 * which is exactly what made the old template 400 on `/search`.
 */
export const STOCK_JIRA_FIELDS = [
  "summary",
  "description",
  "status",
  "priority",
  "assignee",
  "reporter",
  "issuetype",
  "project",
  "parent",
  "subtasks",
  "labels",
  "components",
  "duedate",
  "created",
  "updated",
  "resolution",
  "resolutiondate",
  "issuelinks",
];

export const JIRA_DEFAULT_JQL =
  "assignee = currentUser() AND statusCategory != Done AND Sprint in openSprints() ORDER BY updated DESC";

/** Jira's five stock priorities, plus the Chinese instance naming. */
export const JIRA_PRIORITY_MAP: Record<string, string> = {
  Highest: "1",
  High: "2",
  Medium: "3",
  Low: "4",
  Lowest: "4",
  P1: "1",
  P2: "2",
  P3: "3",
  P4: "4",
  最高: "1",
  高: "2",
  中: "3",
  低: "4",
  最低: "4",
};

/**
 * The default mapping for a Jira issue. Only stock paths: `key`, `fields.*`.
 * Tags come from Jira's own `labels` — not from status, which churns on every
 * transition and would rewrite each imported task's content hash.
 */
export const JIRA_MAPPING: ConnectorMapping = {
  externalId: { template: [{ field: "key" }] },
  title: { template: [{ field: "key" }, { lit: " " }, { field: "fields.summary" }] },
  notes: { field: "fields.description" },
  due: { field: "fields.duedate", transform: "date" },
  // statusCategory.name is To Do / In Progress / Done; "done" is in DONE_WORDS.
  done: { field: "fields.status.statusCategory.name" },
  priority: { field: "fields.priority.name", transform: "enum", map: JIRA_PRIORITY_MAP },
  tags: [{ lit: "jira" }, { field: "fields.project.key" }, { field: "fields.labels[]" }],
  subtasks: { field: "fields.subtasks[]" },
};

/* ───────────────────────── dialects ───────────────────────── */

export type Dialect = {
  id: string;
  label: string;
  /** True when this tool speaks the dialect. Reads the schema, not the names. */
  detect: (props: Record<string, JsonSchema>) => boolean;
  /** Starting values, applied only to keys the tool actually declares. */
  values: Record<string, unknown>;
};

export const DIALECTS: Dialect[] = [
  {
    id: "jira",
    label: "Jira",
    detect: function (props) { return "jql" in props; },
    values: {
      jql: JIRA_DEFAULT_JQL,
      fields: STOCK_JIRA_FIELDS.slice(),
      maxResults: 50,
    },
  },
];

export function detectDialect(schema: JsonSchema | undefined): Dialect | null {
  const props = schemaProps(schema);
  for (let i = 0; i < DIALECTS.length; i++) {
    if (DIALECTS[i].detect(props)) return DIALECTS[i];
  }
  return null;
}

/* ───────────────────────── tool recommendation ───────────────────────── */

export type ToolScore = { tool: McpToolSchema; score: number; reason: string };

const SEARCHISH = /search|query|list|find/i;

/**
 * Rank a server's tools by how well each fits "pull a list of records".
 * Requires nothing but the schema, so it works for any MCP server.
 */
export function rankTools(tools: McpToolSchema[]): ToolScore[] {
  const out: ToolScore[] = [];
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];
    const props = schemaProps(tool.inputSchema);
    const required = schemaRequired(tool.inputSchema);
    const why: string[] = [];
    let score = 0;

    if ("jql" in props) {
      score += 60;
      why.push("有 jql 参数");
      // The discriminator: board/sprint variants also take jql but demand an id.
      if (required.length > 0 && required.every(function (r) { return r === "jql"; })) {
        score += 60;
        why.push("只需 jql");
      }
      if (tool.outputSchema) {
        score += 15;
        why.push("声明了返回结构");
      }
      if (SEARCHISH.test(tool.name)) {
        score += 10;
        why.push("名字像搜索");
      }
    } else if (required.length === 0 && SEARCHISH.test(tool.name)) {
      score += 25;
      why.push("无需参数、名字像列表");
    } else {
      continue;
    }

    if (tool.description && /issue|record|item|list|search/i.test(tool.description)) score += 3;
    out.push({ tool: tool, score: score, reason: why.join("、") });
  }
  out.sort(function (a, b) {
    return b.score - a.score || a.tool.name.localeCompare(b.tool.name);
  });
  return out;
}

/**
 * The one tool worth preselecting. A tie at the top means the choice is a real
 * question, so it returns null and the wizard leaves the picker unselected.
 */
export function recommendTool(tools: McpToolSchema[]): ToolScore | null {
  const ranked = rankTools(tools);
  if (ranked.length === 0 || ranked[0].score <= 0) return null;
  if (ranked.length > 1 && ranked[1].score === ranked[0].score) return null;
  return ranked[0];
}

/**
 * Only a schema-shaped match may preselect itself. The generic "no required
 * params and a list-ish name" fallback is worth showing as a hint, but picking
 * it silently would put words in the user's mouth.
 */
export const AUTO_PICK_MIN_SCORE = 100;

export function autoPickTool(tools: McpToolSchema[]): ToolScore | null {
  const pick = recommendTool(tools);
  return pick && pick.score >= AUTO_PICK_MIN_SCORE ? pick : null;
}

/* ───────────────────────── starting parameters ───────────────────────── */

/**
 * Layered starting parameters for one tool. Only declared keys survive, so a
 * dialect can never reintroduce the old `num_results`-style hallucination.
 */
export function defaultParamsFor(tool: McpToolSchema): Record<string, unknown> {
  const props = schemaProps(tool.inputSchema);
  const out: Record<string, unknown> = {};

  const keys = Object.keys(props);
  for (let i = 0; i < keys.length; i++) {
    const d = schemaDefault(props[keys[i]]);
    if (d !== undefined) out[keys[i]] = d;
  }

  const dialect = detectDialect(tool.inputSchema);
  if (dialect) {
    const dkeys = Object.keys(dialect.values);
    for (let i = 0; i < dkeys.length; i++) {
      const k = dkeys[i];
      if (k in props) out[k] = clone(dialect.values[k]);
    }
  }
  return out;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Keys the user still has to fill: required, and not present in `params`. */
export function missingRequired(tool: McpToolSchema, params: Record<string, unknown>): string[] {
  const required = schemaRequired(tool.inputSchema);
  return required.filter(function (k) {
    const v = params[k];
    return v === undefined || v === null || v === "";
  });
}

/** Keys in `params` the tool does not declare, for the stale-connector warning. */
export function unknownParamKeys(tool: McpToolSchema, params: Record<string, unknown>): string[] {
  const props = schemaProps(tool.inputSchema);
  return Object.keys(params).filter(function (k) { return !(k in props); });
}

/** Which parameters are worth a widget: declared, with a knowable kind. */
export function orderedParamKeys(tool: McpToolSchema): { required: string[]; optional: string[] } {
  const props = schemaProps(tool.inputSchema);
  const required = schemaRequired(tool.inputSchema).filter(function (k) { return k in props; });
  const optional = Object.keys(props).filter(function (k) { return required.indexOf(k) < 0; });
  return { required: required, optional: optional };
}

export { paramKind };
