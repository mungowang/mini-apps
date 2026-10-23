import * as React from "react";
import { motion } from "motion/react";
import { Kbd, KbdGroup, toast } from "@mohou/ui";

import { onToday, parseKeduPaste, scheduleOf } from "../shared/model";
import type { Board } from "../shared/types";
import { useStore } from "./store";

/** Shortcut strip for capture — Kbd keys + short labels. */
function CaptureHint(props: { compact?: boolean; className?: string }) {
  const compact = Boolean(props.compact);
  const kbd = compact ? "h-4 min-w-4 px-1 text-[10px] leading-none" : undefined;
  return (
    <div
      className={
        "inline-flex flex-wrap items-center gap-x-1.5 gap-y-1 text-muted-foreground " +
        (compact ? "text-[11px] leading-none" : "text-sm") +
        (props.className ? " " + props.className : "")
      }
    >
      <span className="inline-flex items-center gap-1">
        <Kbd className={kbd}>Enter</Kbd>
        <span>换行</span>
      </span>
      <span className="opacity-35" aria-hidden>
        ·
      </span>
      <span className="inline-flex items-center gap-1">
        <KbdGroup className="gap-0.5">
          <Kbd className={kbd}>Shift</Kbd>
          <Kbd className={kbd}>Enter</Kbd>
        </KbdGroup>
        <span>添加</span>
      </span>
      {!compact ? (
        <>
          <span className="opacity-35" aria-hidden>
            ·
          </span>
          <span className="text-muted-foreground/80">例如 整理纪要 @周五 !2 #工作 $Jira</span>
        </>
      ) : null}
    </div>
  );
}

type Kind = "due" | "tag" | "prio" | "board";
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

function isBreak(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\t";
}

function assistAt(raw: string, caret: number, suppressed: string | null): Assist | null {
  // Assist only on the DSL line (before the first newline).
  const nl = raw.indexOf("\n");
  if (nl >= 0 && caret > nl) return null;
  let start = caret;
  while (start > 0 && !isBreak(raw.charAt(start - 1))) start -= 1;
  let end = caret;
  while (end < raw.length && !isBreak(raw.charAt(end))) end += 1;
  if (start === end) return null;
  const text = raw.slice(start, end);
  const head = text.charAt(0);
  let kind: Kind | null = null;
  if (head === "@") kind = "due";
  else if (head === "#") kind = "tag";
  else if (head === "!" || head === "！") kind = "prio";
  else if (head === "$") kind = "board";
  if (!kind) return null;
  if (suppressed === text) return null;
  return { kind, start, end, query: text.slice(1) };
}

function optionsFor(assist: Assist, tags: string[], boards: Board[]): { label: string; token: string }[] {
  const q = assist.query.toLowerCase();
  if (assist.kind === "board") {
    const out: { label: string; token: string }[] = [];
    for (let i = 0; i < boards.length; i++) {
      const b = boards[i];
      if (b.fixed) continue;
      if (!q || b.name.toLowerCase().indexOf(q) >= 0) out.push({ label: "$" + b.name, token: "$" + b.name });
      if (out.length >= 8) break;
    }
    return out;
  }
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

export function Capture(props: { inputRef: React.RefObject<HTMLTextAreaElement | null>; dock?: boolean }) {
  const { actions, tags, boards, today, lens, followInbox, setLens, openTask, setSelectMode } = useStore();
  const [raw, setRaw] = React.useState("");
  const [caret, setCaret] = React.useState(0);
  const [focused, setFocused] = React.useState(false);
  const [suppress, setSuppress] = React.useState<string | null>(null);
  const [index, setIndex] = React.useState(0);
  const [pending, setPending] = React.useState(false);
  const [reduceMotion, setReduceMotion] = React.useState(false);

  React.useEffect(function () {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    function apply() {
      setReduceMotion(mq.matches);
    }
    apply();
    mq.addEventListener("change", apply);
    return function () {
      mq.removeEventListener("change", apply);
    };
  }, []);

  const assist = assistAt(raw, caret, suppress);
  const options = assist ? optionsFor(assist, tags, boards) : [];
  // Multi-line 刻度文本: line 1 is DSL; rest is notes / subtasks.
  const paste = raw.trim() ? parseKeduPaste(raw, today) : null;
  const parsed = paste;
  const schedule = parsed ? scheduleOf(parsed, today) : null;

  React.useEffect(
    function () {
      setIndex(0);
    },
    [assist ? assist.kind + ":" + assist.query : ""]
  );

  function rememberCaret(el: HTMLTextAreaElement) {
    setCaret(el.selectionStart === null ? el.value.length : el.selectionStart);
  }

  /** Grow/shrink with content. Collapse to 0 first so blur (xl→sm) does not keep a tall box. */
  function fitHeight(el: HTMLTextAreaElement | null, mode?: "idle" | "active") {
    if (!el) return;
    el.style.overflowY = "hidden";
    // Idle dock empty: fixed single-line height so the placeholder sits centered in the pill.
    const idleEmpty =
      props.dock &&
      !el.value.trim() &&
      (mode === "idle" || (mode !== "active" && document.activeElement !== el));
    if (idleEmpty) {
      el.style.height = "20px";
      return;
    }
    el.style.height = "0px";
    // Force layout so scrollHeight matches the current font metrics.
    void el.offsetHeight;
    // Focused dock: floor matches min-h-11 so empty placeholder and one-line text share height.
    // (Inline height alone can undercut min-height on some engines.)
    const active =
      mode === "active" || (mode !== "idle" && document.activeElement === el);
    const floor = props.dock && active ? 44 : 0;
    el.style.height = String(Math.max(el.scrollHeight, floor)) + "px";
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
      fitHeight(el);
    });
  }

  async function submit() {
    if (pending) return;
    const text = raw.trim();
    if (!text) return;
    const read = parseKeduPaste(text, today);
    if (!read.title.trim()) {
      toast.add({ title: "还差要做的事", description: "日期和标签之外，写上这一件是什么" });
      return;
    }
    setPending(true);
    try {
      // Send the full multi-line body; API parseKeduPaste splits DSL / notes / subtasks.
      const id = await actions.add(text, {
        notes: read.notes,
        subtasks: read.subtasks,
      });
      if (!id) return;
      setRaw("");
      setCaret(0);
      window.requestAnimationFrame(function () {
        fitHeight(props.inputRef.current);
      });
      if (read.warnings.length) {
        toast.add({ title: "有一段没读懂", description: read.warnings.join(" ") });
        return;
      }
      // Unscheduled → 收集. Optional follow: switch tab, select row, open detail so tags/schedule finish in one motion.
      if (!read.due && followInbox) {
        setSelectMode(false);
        setLens("inbox");
        openTask(id);
        return;
      }
      if (read.due && !onToday(read, today) && lens === "today") {
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
  const showChips = Boolean(
    !showSuggest &&
      parsed &&
      (schedule ||
        parsed.priority !== 3 ||
        parsed.tags.length ||
        parsed.notes ||
        parsed.subtasks.length ||
        parsed.warnings.length)
  );
  const boxRef = React.useRef<HTMLDivElement>(null);
  const lifted = Boolean(props.dock && focused);
  // Always bottom-anchored + translateY (avoids top-pin overflow scrollbar jump).
  const [liftY, setLiftY] = React.useState(0);
  const scrollTopRef = React.useRef(0);
  const empty = !raw.trim();

  function measureLiftY(): number {
    const el = boxRef.current;
    const parent = el ? (el.offsetParent as HTMLElement | null) : null;
    if (!el || !parent) return 0;
    const parentH = parent.clientHeight;
    const cardH = el.offsetHeight;
    const restingTop = parentH - cardH;
    const minTop = 112;
    let targetTop = Math.round(parentH * 0.4 - cardH / 2);
    const maxTop = Math.max(minTop, parentH - cardH - 20);
    if (targetTop < minTop) targetTop = minTop;
    if (targetTop > maxTop) targetTop = maxTop;
    return Math.min(0, targetTop - restingTop);
  }

  function scrollerEl(): HTMLElement | null {
    const root = boxRef.current ? (boxRef.current.offsetParent as HTMLElement | null) : null;
    return root ? (root.querySelector('[data-kedu="scroller"]') as HTMLElement | null) : null;
  }

  function holdScroller() {
    const el = scrollerEl();
    if (el) el.scrollTop = scrollTopRef.current;
  }

  // Fit textarea height when focus/content changes — no setState here.
  React.useLayoutEffect(
    function () {
      fitHeight(props.inputRef.current, focused ? "active" : "idle");
    },
    [focused, raw, props.inputRef]
  );

  const field = (
    <div
      className={
        props.dock
          ? focused
            ? ""
            : "kedu-edge flex min-h-10 items-center rounded-xl border px-3 py-2"
          : "contents"
      }
    >
      <textarea
        ref={props.inputRef}
        data-kedu="capture"
        value={raw}
        rows={1}
        autoComplete="off"
        spellCheck={false}
        placeholder={focused && props.dock ? "写下一件要做的事" : "添加一件事，Shift+Enter 添加"}
        aria-label="添加一件事"
        onFocus={function () {
          const el = scrollerEl();
          if (el) scrollTopRef.current = el.scrollTop;
          holdScroller();
          setFocused(true);
          // Measure lift after the expanded chrome class applies; freeze list scroll during motion.
          window.requestAnimationFrame(function () {
            fitHeight(props.inputRef.current, "active");
            holdScroller();
            setLiftY(measureLiftY());
            holdScroller();
            window.setTimeout(function () {
              fitHeight(props.inputRef.current, "active");
              holdScroller();
              setLiftY(measureLiftY());
              holdScroller();
            }, 300);
            window.setTimeout(holdScroller, 80);
            window.setTimeout(holdScroller, 160);
            window.setTimeout(holdScroller, 400);
          });
        }}
        onBlur={function () {
          setFocused(false);
          setLiftY(0);
          // Font-size transition is 200ms; refit after class flips and again when type settles.
          window.requestAnimationFrame(function () {
            fitHeight(props.inputRef.current, "idle");
          });
          window.setTimeout(function () {
            fitHeight(props.inputRef.current, "idle");
          }, 220);
        }}
        onChange={function (e) {
          setRaw(e.target.value);
          setSuppress(null);
          rememberCaret(e.target);
          fitHeight(e.target);
        }}
        onPaste={function (e) {
          const clip = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
          if (!clip || (clip.indexOf("\n") < 0 && clip.indexOf("\r") < 0)) return;
          // Keep multi-line 刻度文本 intact so notes/subtasks are not mashed into the title.
          e.preventDefault();
          const el = e.currentTarget;
          const start = el.selectionStart === null ? raw.length : el.selectionStart;
          const end = el.selectionEnd === null ? raw.length : el.selectionEnd;
          const normalized = clip.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
          const next = raw.slice(0, start) + normalized + raw.slice(end);
          const pos = start + normalized.length;
          setRaw(next);
          setSuppress(null);
          setCaret(pos);
          window.requestAnimationFrame(function () {
            el.focus();
            el.setSelectionRange(pos, pos);
            fitHeight(el);
          });
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
          if (showSuggest && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "ArrowRight")) {
            e.preventDefault();
            const dir = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
            setIndex(function (prev) {
              return (prev + dir + options.length) % options.length;
            });
            return;
          }
          if (e.key !== "Enter") return;
          // Enter = newline (notes / subtasks). Shift+Enter = add.
          // While @/#/! assist is open, plain Enter still picks the highlighted option.
          if (e.shiftKey) {
            e.preventDefault();
            void submit();
            return;
          }
          if (showSuggest) {
            e.preventDefault();
            applyToken(options[Math.min(index, options.length - 1)].token);
          }
        }}
        className={
          "box-border block w-full max-w-full resize-none overflow-hidden whitespace-pre-wrap break-words bg-transparent text-foreground outline-none transition-[font-size] duration-200 placeholder:text-muted-foreground [field-sizing:content] " +
          (focused
            ? // Same min height empty or single-line — avoids the card shrinking a few px when typing starts.
              "min-h-11 py-1 text-xl font-medium leading-snug"
            : // Idle: py-0 + fixed line box so placeholder is vertically centered in the pill.
              "py-0 text-sm leading-5" + (empty ? " h-5" : ""))
        }
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
          {parsed.notes ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">备注</span>
          ) : null}
          {parsed.subtasks.length ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {"子任务 " + String(parsed.subtasks.length)}
            </span>
          ) : null}
          {parsed.warnings.length ? (
            <span className="text-xs text-destructive">{parsed.warnings.join(" ")}</span>
          ) : null}
        </div>
      ) : null}

      {/* Non-dock: keep a single bottom hint while focused + empty. */}
      {!props.dock && empty && focused ? (
        <div className="pt-1.5">
          <CaptureHint />
        </div>
      ) : null}
    </div>
  );

  return (
    <>
      {lifted ? (
        <button
          type="button"
          aria-label="收起快记"
          className="kedu-quick-scrim"
          onMouseDown={function (e) {
            e.preventDefault();
            const el = props.inputRef.current;
            if (el) el.blur();
          }}
        />
      ) : null}
      <motion.div
        ref={boxRef}
        data-kedu={props.dock ? "quick" : undefined}
        data-active={lifted ? "1" : "0"}
        initial={false}
        animate={props.dock ? { y: lifted ? liftY : 0 } : { y: 0 }}
        transition={reduceMotion ? { duration: 0 } : { duration: 0.72, ease: [0.16, 1, 0.3, 1] }}
        onPointerDown={function () {
          // Snapshot before focus/scrollIntoView runs.
          const el = scrollerEl();
          if (el) scrollTopRef.current = el.scrollTop;
        }}
        className={
          props.dock
            ? "kedu-quick-card absolute inset-x-0 bottom-0 z-30 bg-background " +
              (lifted ? "px-8 pb-7 pt-7" : "border-t border-border px-4 pb-3 pt-2.5")
            : "kedu-edge mx-4 mt-3 rounded-xl border px-3 py-2.5"
        }
      >
        {props.dock ? (
          <div className={lifted ? "pb-4" : "pb-1.5"}>
            <div className="flex h-5 items-center gap-2.5">
              <p
                className={
                  // Slightly larger + medium; flex items-center handles vertical align with Kbd.
                  "shrink-0 leading-none text-muted-foreground " +
                  (lifted ? "text-[12px] font-medium tracking-[0.38em]" : "text-xs")
                }
              >
                快记
              </p>
              {/* Focused: shortcuts always beside 快记 (same row empty or typing — no jump). */}
              {lifted ? (
                <>
                  <div className="flex h-5 shrink-0 items-center">
                    <CaptureHint compact />
                  </div>
                  <span className="min-w-0 flex-1 truncate text-[11px] leading-none text-muted-foreground/75">
                    · 例如 整理纪要 @周五 !2 #工作
                  </span>
                </>
              ) : null}
            </div>
          </div>
        ) : null}
        {field}
      </motion.div>
    </>
  );
}
