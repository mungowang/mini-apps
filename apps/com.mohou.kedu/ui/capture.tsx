import * as React from "react";
import { toast } from "@mohou/ui";

import { diffDays, parseQuickAdd, scheduleOf } from "../shared/model";
import { useStore } from "./store";

type Kind = "due" | "tag" | "prio";
type Assist = { kind: Kind; start: number; end: number; query: string };

const DUE_PRESETS: { label: string; token: string }[] = [
  { label: "今天", token: "@今天" },
  { label: "明天", token: "@明天" },
  { label: "后天", token: "@后天" },
  { label: "本周末", token: "@本周末" },
  { label: "下周一", token: "@下周一" },
  { label: "一周后", token: "@7天后" },
];

const PRIO_PRESETS: { label: string; token: string }[] = [
  { label: "P1 紧急", token: "!1" },
  { label: "P2 高", token: "!2" },
  { label: "P3 中", token: "!3" },
  { label: "P4 低", token: "!4" },
];

function assistAt(raw: string, caret: number, suppressed: string | null): Assist | null {
  let start = caret;
  while (start > 0 && raw.charAt(start - 1) !== " ") start -= 1;
  let end = caret;
  while (end < raw.length && raw.charAt(end) !== " ") end += 1;
  if (start === end) return null;
  const text = raw.slice(start, end);
  const head = text.charAt(0);
  let kind: Kind | null = null;
  if (head === "@") kind = "due";
  else if (head === "#") kind = "tag";
  else if (head === "!" || head === "！") kind = "prio";
  if (!kind) return null;
  if (suppressed === text) return null;
  return { kind, start, end, query: text.slice(1) };
}

function optionsFor(assist: Assist, tags: string[]): { label: string; token: string }[] {
  const q = assist.query.toLowerCase();
  if (assist.kind === "prio") {
    return PRIO_PRESETS.filter(function (o) {
      return !q || o.label.toLowerCase().indexOf(q) >= 0 || o.token.slice(1).indexOf(q) >= 0;
    });
  }
  if (assist.kind === "due") {
    return DUE_PRESETS.filter(function (o) {
      return !q || o.label.toLowerCase().indexOf(q) >= 0 || o.token.toLowerCase().indexOf(q) >= 0;
    });
  }
  const out: { label: string; token: string }[] = [];
  const typed = assist.query.trim();
  if (typed && typed.length <= 16 && tags.indexOf(typed) < 0) {
    out.push({ label: "加上 #" + typed, token: "#" + typed });
  }
  for (let i = 0; i < tags.length; i++) {
    const name = tags[i];
    if (!q || name.toLowerCase().indexOf(q) >= 0) out.push({ label: "#" + name, token: "#" + name });
    if (out.length >= 8) break;
  }
  return out.slice(0, 8);
}

export function Capture(props: { inputRef: React.RefObject<HTMLInputElement | null>; dock?: boolean }) {
  const { actions, tags, today, lens } = useStore();
  const [raw, setRaw] = React.useState("");
  const [caret, setCaret] = React.useState(0);
  const [focused, setFocused] = React.useState(false);
  const [suppress, setSuppress] = React.useState<string | null>(null);
  const [index, setIndex] = React.useState(0);
  const [pending, setPending] = React.useState(false);

  const assist = assistAt(raw, caret, suppress);
  const options = assist ? optionsFor(assist, tags) : [];
  const parsed = raw.trim() ? parseQuickAdd(raw, today) : null;
  const schedule = parsed ? scheduleOf(parsed, today) : null;

  React.useEffect(
    function () {
      setIndex(0);
    },
    [assist ? assist.kind + ":" + assist.query : ""]
  );

  function rememberCaret(el: HTMLInputElement) {
    setCaret(el.selectionStart === null ? el.value.length : el.selectionStart);
  }

  function applyToken(token: string) {
    if (!assist) return;
    const next = raw.slice(0, assist.start) + token + " " + raw.slice(assist.end);
    const pos = assist.start + token.length + 1;
    setRaw(next);
    setSuppress(null);
    setCaret(pos);
    window.requestAnimationFrame(function () {
      const el = props.inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  async function submit() {
    if (pending) return;
    const text = raw.trim();
    if (!text) return;
    const read = parseQuickAdd(text, today);
    if (!read.title.trim()) {
      toast.add({ title: "还差要做的事", description: "日期和标签之外，写上这一件是什么" });
      return;
    }
    setPending(true);
    try {
      const id = await actions.add(text);
      if (!id) return;
      setRaw("");
      setCaret(0);
      if (read.warnings.length) {
        toast.add({ title: "有一段没读懂", description: read.warnings.join(" ") });
        return;
      }
      if (read.due && diffDays(read.due, today) > 0 && lens === "today") {
        const when = scheduleOf(read, today);
        toast.add({ title: "已放到之后", description: when ? when.label : undefined });
      } else if (!read.due && lens !== "inbox") {
        toast.add({ title: "已放到收集", description: "还没有日期，排好就会离开收集" });
      }
    } finally {
      setPending(false);
    }
  }

  const showSuggest = Boolean(assist && options.length);
  const showChips = Boolean(!showSuggest && parsed && (schedule || parsed.priority !== 3 || parsed.tags.length || parsed.warnings.length));

  const field = (
    <div className={props.dock ? "rounded-xl border border-input px-3 py-2 focus-within:border-foreground" : "contents"}>
      <input
        ref={props.inputRef}
        data-kedu="capture"
        value={raw}
        autoComplete="off"
        spellCheck={false}
        placeholder="添加一件事，回车加入"
        aria-label="添加一件事"
        onFocus={function () {
          setFocused(true);
        }}
        onBlur={function () {
          setFocused(false);
        }}
        onChange={function (e) {
          setRaw(e.target.value);
          setSuppress(null);
          rememberCaret(e.target);
        }}
        onSelect={function (e) {
          rememberCaret(e.currentTarget);
        }}
        onKeyUp={function (e) {
          rememberCaret(e.currentTarget);
        }}
        onKeyDown={function (e) {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Escape") {
            if (assist) {
              e.preventDefault();
              const text = raw.slice(assist.start, assist.end);
              setSuppress(text);
            }
            return;
          }
          if (showSuggest && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            const dir = e.key === "ArrowDown" ? 1 : -1;
            setIndex(function (prev) {
              return (prev + dir + options.length) % options.length;
            });
            return;
          }
          if (e.key !== "Enter") return;
          e.preventDefault();
          if (showSuggest) {
            applyToken(options[Math.min(index, options.length - 1)].token);
            return;
          }
          void submit();
        }}
        className="h-8 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />

      {showSuggest ? (
        <div className="flex flex-wrap gap-1.5 pt-1" role="listbox" aria-label="补全">
          {options.map(function (o, i) {
            const on = i === index;
            return (
              <button
                key={o.token + o.label}
                type="button"
                role="option"
                aria-selected={on}
                onMouseDown={function (e) {
                  e.preventDefault();
                  applyToken(o.token);
                }}
                onMouseEnter={function () {
                  setIndex(i);
                }}
                className={
                  "rounded-full border px-2 py-0.5 text-xs " +
                  (on ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")
                }
              >
                {o.label}
              </button>
            );
          })}
        </div>
      ) : null}

      {showChips && parsed ? (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {parsed.priority !== 3 ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{"P" + String(parsed.priority)}</span>
          ) : null}
          {schedule ? <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{schedule.label}</span> : null}
          {parsed.tags.map(function (name) {
            return (
              <span key={name} className="rounded-full bg-muted px-2 py-0.5 text-xs">
                {"#" + name}
              </span>
            );
          })}
          {parsed.warnings.length ? (
            <span className="text-xs text-destructive">{parsed.warnings.join(" ")}</span>
          ) : null}
        </div>
      ) : null}

      {focused && !raw.trim() ? (
        <p className="pt-1 text-xs text-muted-foreground">例如：整理纪要 @周五 !2 #工作 · 也可以 @9/13-9/15 或 @14:00</p>
      ) : null}
    </div>
  );

  return (
    <div
      data-kedu={props.dock ? "quick" : undefined}
      className={
        props.dock
          ? "shrink-0 border-t border-border bg-background px-4 pb-4 pt-3"
          : "mx-4 mt-3 rounded-xl border border-input px-3 py-2 focus-within:border-foreground"
      }
    >
      {props.dock ? <p className="pb-2 text-xs text-muted-foreground">快记</p> : null}
      {field}
    </div>
  );
}
