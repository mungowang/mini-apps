/**
 * A parameter form built from a tool's own `inputSchema`.
 *
 * The form is the contract: a key reaches the tool only if the server declared
 * it. Optional keys are hidden until added, so the wizard starts from the
 * small set that actually matters. `suggestions` lets the caller offer chips
 * for a known vocabulary (Jira's field ids) without this file knowing Jira.
 */
import * as React from "react";

import type { JsonSchema } from "../shared/schema";
import {
  allowsExtraParams,
  arrayItemChoices,
  coerceParam,
  enumValues,
  paramDescription,
  paramKind,
  schemaProps,
  schemaRequired,
} from "../shared/schema";

const inputCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus:border-foreground placeholder:text-muted-foreground";
const areaCls =
  "w-full rounded-md border border-input bg-transparent px-2 py-1.5 font-mono text-[11px] leading-relaxed outline-none focus:border-foreground placeholder:text-muted-foreground";

export type SchemaParamsFormProps = {
  schema: JsonSchema;
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /** Chip vocabulary per parameter, e.g. `{ fields: ["summary", …] }`. */
  suggestions?: Record<string, string[]>;
  /** `additionalProperties: false` (the default) hides the free-form key input. */
  allowExtra?: boolean;
  disabled?: boolean;
};

function cloneValues(v: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = Object.keys(v);
  for (let i = 0; i < keys.length; i++) out[keys[i]] = v[keys[i]];
  return out;
}

export function SchemaParamsForm(props: SchemaParamsFormProps) {
  const schema = props.schema;
  const values = props.values;
  const props_ = schemaProps(schema);
  const required = schemaRequired(schema);
  const suggestions = props.suggestions || {};
  const allowExtra = props.allowExtra === true || allowsExtraParams(schema);

  const [adding, setAdding] = React.useState<string>("");

  const declared = Object.keys(props_);
  const present = Object.keys(values).filter(function (k) { return k in props_; });
  const absentOptional = declared.filter(function (k) {
    return required.indexOf(k) < 0 && !(k in values);
  });

  function set(key: string, raw: unknown): void {
    const next = cloneValues(values);
    const v = coerceParam(paramKind(props_[key]), raw);
    if (v === undefined) delete next[key];
    else next[key] = v;
    props.onChange(next);
  }

  function drop(key: string): void {
    const next = cloneValues(values);
    delete next[key];
    props.onChange(next);
  }

  function renderWidget(key: string): React.ReactNode {
    const prop = props_[key];
    const raw = values[key];
    const kind = paramKind(prop);
    const choices = suggestions[key] || [];
    const disabled = props.disabled === true;

    if (kind === "enum") {
      const vals = enumValues(prop);
      return (
        <select
          value={raw === undefined ? "" : String(raw)}
          disabled={disabled}
          onChange={function (e) { set(key, e.target.value); }}
          className={inputCls}
        >
          <option value="">（不设）</option>
          {vals.map(function (v) { return <option key={v} value={v}>{v}</option>; })}
        </select>
      );
    }

    if (kind === "boolean") {
      return (
        <label className="inline-flex items-center gap-2 pt-1.5 text-sm">
          <input
            type="checkbox"
            checked={raw === true}
            disabled={disabled}
            onChange={function (e) { set(key, e.target.checked); }}
            className="size-4 rounded border-input"
          />
          <span className="text-xs text-muted-foreground">{raw === true ? "true" : "false"}</span>
        </label>
      );
    }

    if (kind === "number") {
      return (
        <input
          type="number"
          value={raw === undefined || raw === null ? "" : String(raw)}
          disabled={disabled}
          onChange={function (e) { set(key, e.target.value); }}
          placeholder={prop.default === undefined ? "" : String(prop.default)}
          className={inputCls}
        />
      );
    }

    if (kind === "array") {
      const itemChoices = arrayItemChoices(prop);
      const vocab = choices.length ? choices : itemChoices;
      const arr = Array.isArray(raw) ? raw.map(String) : [];
      if (vocab.length) {
        return (
          <div className="flex flex-wrap gap-1.5">
            {vocab.map(function (name) {
              const on = arr.indexOf(name) >= 0;
              return (
                <button
                  key={name}
                  type="button"
                  disabled={disabled}
                  onClick={function () {
                    const cur = arr.slice();
                    const at = cur.indexOf(name);
                    if (at >= 0) cur.splice(at, 1);
                    else cur.push(name);
                    set(key, cur);
                  }}
                  className={
                    "rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors " +
                    (on ? "border-foreground bg-muted text-foreground" : "border-border text-muted-foreground hover:text-foreground")
                  }
                >
                  {name}
                </button>
              );
            })}
            <span className="mt-1 w-full text-[11px] text-muted-foreground">已选 {String(arr.length)} 项</span>
          </div>
        );
      }
      return (
        <textarea
          value={arr.join("\n")}
          disabled={disabled}
          rows={Math.min(10, Math.max(3, arr.length + 1))}
          onChange={function (e) { set(key, e.target.value.split("\n")); }}
          placeholder="一行一个"
          className={areaCls}
        />
      );
    }

    if (kind === "object") {
      return (
        <textarea
          value={raw === undefined ? "" : JSON.stringify(raw, null, 2)}
          disabled={disabled}
          rows={4}
          onChange={function (e) { set(key, e.target.value); }}
          placeholder="{ }"
          className={areaCls}
        />
      );
    }

    return (
      <input
        value={raw === undefined || raw === null ? "" : String(raw)}
        disabled={disabled}
        onChange={function (e) { set(key, e.target.value); }}
        placeholder={prop.default === undefined ? "" : String(prop.default)}
        className={inputCls}
      />
    );
  }

  function renderRow(key: string, isRequired: boolean): React.ReactNode {
    const prop = props_[key];
    const desc = paramDescription(prop);
    const kind = paramKind(prop);
    return (
      <div key={key} className="mb-2.5 rounded-lg border border-border p-2.5">
        <div className="mb-1.5 flex items-baseline gap-2">
          <span className="font-mono text-xs font-medium">{key}</span>
          {isRequired ? <span className="text-[11px] text-destructive">必填</span> : null}
          <span className="text-[11px] text-muted-foreground">{kind}</span>
          {!isRequired ? (
            <button
              type="button"
              onClick={function () { drop(key); }}
              className="ml-auto text-[11px] text-muted-foreground hover:text-destructive"
            >
              ✕
            </button>
          ) : null}
        </div>
        {renderWidget(key)}
        {desc ? <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{desc}</p> : null}
      </div>
    );
  }

  const requiredShown = required.filter(function (k) { return k in props_; });

  return (
    <div>
      {requiredShown.map(function (k) { return renderRow(k, true); })}
      {present.filter(function (k) { return requiredShown.indexOf(k) < 0; }).map(function (k) {
        return renderRow(k, false);
      })}

      {absentOptional.length || allowExtra ? (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {absentOptional.length ? (
            <select
              value={adding}
              onChange={function (e) {
                const k = e.target.value;
                setAdding("");
                if (!k) return;
                const prop = props_[k];
                const seed = paramKind(prop) === "array" ? [] : "";
                const next = cloneValues(values);
                next[k] = seed;
                props.onChange(next);
              }}
              className="h-8 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus:border-foreground"
            >
              <option value="">＋ 可选参数</option>
              {absentOptional.map(function (k) {
                return (
                  <option key={k} value={k}>
                    {k} · {paramKind(props_[k])}
                  </option>
                );
              })}
            </select>
          ) : null}
          {allowExtra ? (
            <button
              type="button"
              onClick={function () {
                let n = 1;
                while ("extra" + String(n) in values) n += 1;
                const next = cloneValues(values);
                next["extra" + String(n)] = "";
                props.onChange(next);
              }}
              className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              ＋ 额外参数
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
