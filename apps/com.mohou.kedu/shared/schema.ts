/**
 * JSON Schema reading for MCP tool arguments. Pure, so the UI form and the
 * backend defaults agree on what a tool accepts.
 *
 * `ctx.mcpTools` hands back the server's own `inputSchema`/`outputSchema`;
 * nothing here invents a parameter. A key that is not in `properties` must
 * never reach the tool.
 */

export type JsonSchema = Record<string, unknown>;

/** One tool as `ctx.mcpTools(serverId)` returns it. */
export type McpToolSchema = {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
};

export function schemaProps(schema: JsonSchema | undefined): Record<string, JsonSchema> {
  const p = schema ? schema.properties : undefined;
  if (!p || typeof p !== "object" || Array.isArray(p)) return {};
  return p as Record<string, JsonSchema>;
}

export function schemaRequired(schema: JsonSchema | undefined): string[] {
  const r = schema ? schema.required : undefined;
  if (!Array.isArray(r)) return [];
  return r.filter(function (x): x is string { return typeof x === "string"; });
}

export type ParamKind = "string" | "number" | "boolean" | "array" | "object" | "enum";

export function paramKind(prop: JsonSchema | undefined): ParamKind {
  if (!prop) return "string";
  if (Array.isArray(prop.enum)) return "enum";
  const t = prop.type;
  if (Array.isArray(t)) {
    // Type unions: follow the first concrete branch.
    for (let i = 0; i < t.length; i++) {
      const one = paramKind({ ...prop, type: t[i] });
      if (one !== "string") return one;
    }
    return "string";
  }
  if (t === "array") return "array";
  if (t === "boolean") return "boolean";
  if (t === "number" || t === "integer") return "number";
  if (t === "object") return "object";
  return "string";
}

export function enumValues(prop: JsonSchema | undefined): string[] {
  const e = prop ? prop.enum : undefined;
  return Array.isArray(e) ? e.map(String) : [];
}

/** Array item suggestions: items.enum, else nothing. */
export function arrayItemChoices(prop: JsonSchema | undefined): string[] {
  const items = prop && typeof prop.items === "object" && !Array.isArray(prop.items) ? (prop.items as JsonSchema) : undefined;
  if (!items) return [];
  const e = items.enum;
  return Array.isArray(e) ? e.map(String) : [];
}

/** The server's own hint: `default`, else `examples[0]`, else the first enum value. */
export function schemaDefault(prop: JsonSchema | undefined): unknown {
  if (!prop) return undefined;
  if (prop.default !== undefined) return prop.default;
  const ex = prop.examples;
  if (Array.isArray(ex) && ex.length > 0) return ex[0];
  const vals = enumValues(prop);
  return vals.length > 0 ? vals[0] : undefined;
}

export function paramDescription(prop: JsonSchema | undefined): string {
  const d = prop ? prop.description : undefined;
  return typeof d === "string" ? d : "";
}

/** `additionalProperties: false` means the tool rejects a key it did not declare. */
export function allowsExtraParams(schema: JsonSchema | undefined): boolean {
  return !schema || schema.additionalProperties !== false;
}

/**
 * Every array path inside an output schema, as a ready rootPath chip:
 * `{ issues: { type: "array" } }` -> `"issues[]"`.
 */
export function arrayPaths(schema: JsonSchema | undefined, limit = 6): string[] {
  const out: string[] = [];
  const seen: Record<string, true> = {};
  function walk(node: JsonSchema | undefined, prefix: string, depth: number): void {
    if (!node || typeof node !== "object" || depth > 4 || out.length >= limit) return;
    const props = schemaProps(node);
    const keys = Object.keys(props);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const child = props[key];
      const path = prefix ? prefix + "." + key : key;
      if (child && child.type === "array") {
        const chip = path + "[]";
        if (!seen[chip]) {
          seen[chip] = true;
          out.push(chip);
        }
        continue;
      }
      walk(child, path, depth + 1);
    }
  }
  walk(schema, "", 0);
  return out;
}

/** Turn a raw form value into the type the schema declares. `undefined` = leave the key out. */
export function coerceParam(kind: ParamKind, raw: unknown): unknown {
  if (kind === "number") {
    if (raw === "" || raw === undefined || raw === null) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  if (kind === "boolean") return raw === true || raw === "true";
  if (kind === "array") {
    if (Array.isArray(raw)) return raw.map(String).filter(function (s) { return s !== ""; });
    if (typeof raw === "string") {
      return raw.split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
    }
    return [];
  }
  if (kind === "object") {
    if (raw && typeof raw === "object") return raw;
    if (typeof raw === "string" && raw.trim()) {
      try {
        return JSON.parse(raw) as unknown;
      } catch (e) {
        return undefined;
      }
    }
    return undefined;
  }
  if (raw === undefined || raw === null) return "";
  return String(raw);
}

/** Human summary of a parameter set, for the wizard's collapsed state. */
export function describeParamValue(kind: ParamKind, v: unknown): string {
  if (v === undefined || v === null) return "";
  if (kind === "array") {
    if (!Array.isArray(v)) return String(v);
    if (v.length === 0) return "(空)";
    return v.length + " 项：" + v.slice(0, 3).map(String).join(", ") + (v.length > 3 ? "…" : "");
  }
  if (kind === "object") return JSON.stringify(v).slice(0, 60);
  return String(v);
}
