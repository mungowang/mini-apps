import * as React from "react";
import {
  Button,
  ConfirmDialog,
  DatePicker,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Icon,
  Popover,
  PopoverContent,
  PopoverTrigger,
  toast,
  useApp,
  cn,
} from "@mohou/ui";

import {
  COPY_FORMAT_HINT,
  COPY_FORMAT_LABEL,
  COPY_FORMATS,
  dateKey,
  formatTaskExport,
  fmtShort,
  parseKey,
  relativeTime,
  scheduleOf,
  shiftKey,
  weekSpan,
} from "../shared/model";
import type { CopyFormat } from "../shared/model";
import type { Priority, Subtask, Task } from "../shared/types";
import { PRIORITY_LABEL, PRIORITY_TITLE } from "../shared/types";
import { Mono, TaskCheck } from "./atoms";
import { copyText } from "./clipboard";
import { ExpandEditor } from "./expand";
import { imageFilesFrom, shrinkImage } from "./image-utils";
import { useStore } from "./store";

const COPY_FORMAT_KEY = "kedu-copy-format";

function readCopyFormat(): CopyFormat {
  try {
    const value = window.localStorage.getItem(COPY_FORMAT_KEY);
    if (value === "dsl" || value === "markdown" || value === "plain") return value;
  } catch (e) {
    /* storage can be closed */
  }
  return "dsl";
}

function writeCopyFormat(next: CopyFormat) {
  try {
    window.localStorage.setItem(COPY_FORMAT_KEY, next);
  } catch (e) {
    /* choice still applies this visit */
  }
}

function firstLine(text: string): string {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return "";
}

/** Bottom-bar copy: one click uses the last format; ▾ switches format (and copies). Preview is opt-in. */
function CopyTaskButton(props: { task: Task }) {
  const [format, setFormat] = React.useState<CopyFormat>(readCopyFormat);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [previewOpen, setPreviewOpen] = React.useState(false);

  const taskRef = React.useRef(props.task);
  const formatRef = React.useRef(format);
  taskRef.current = props.task;
  formatRef.current = format;

  const copyWith = React.useCallback(async function (next: CopyFormat) {
    setFormat(next);
    writeCopyFormat(next);
    formatRef.current = next;
    const text = formatTaskExport(taskRef.current, next);
    const ok = await copyText(text);
    if (ok) toast.add({ title: "已复制 · " + COPY_FORMAT_LABEL[next] });
    else toast.add({ title: "没有复制成功", description: "浏览器挡住了剪贴板" });
    setMenuOpen(false);
    setPreviewOpen(false);
  }, []);

  React.useEffect(
    function () {
      function onKey(e: KeyboardEvent) {
        const el = e.target as HTMLElement | null;
        const typing = Boolean(el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable));
        if (typing) return;
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "c") {
          e.preventDefault();
          void copyWith(formatRef.current);
        }
      }
      window.addEventListener("keydown", onKey);
      return function () {
        window.removeEventListener("keydown", onKey);
      };
    },
    [copyWith]
  );

  const previewText = formatTaskExport(props.task, format);

  return (
    <>
      <div className="flex items-center" data-kedu="copy-task">
        <button
          type="button"
          onClick={function () {
            void copyWith(format);
          }}
          className="h-8 rounded-l-md px-2.5 text-sm text-foreground hover:bg-muted"
        >
          {"复制任务 · " + COPY_FORMAT_LABEL[format]}
        </button>
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label="选择复制格式"
                title="选择复制格式"
                className="grid h-8 w-7 place-items-center rounded-r-md text-muted-foreground hover:bg-muted hover:text-foreground"
              />
            }
          >
            <Icon.ChevronDown size={14} strokeWidth={2} />
          </PopoverTrigger>
          <PopoverContent align="end" side="top" sideOffset={8} className="w-56 p-1.5">
            <div role="menu" aria-label="复制格式">
              {COPY_FORMATS.map(function (id) {
                const on = format === id;
                const peek = firstLine(formatTaskExport(props.task, id));
                return (
                  <button
                    key={id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={on}
                    onClick={function () {
                      void copyWith(id);
                    }}
                    className={cn(
                      "flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left hover:bg-muted",
                      on ? "bg-muted/70" : ""
                    )}
                  >
                    <span className="flex items-center gap-2 text-sm text-foreground">
                      <span className={cn("w-3 text-xs", on ? "opacity-100" : "opacity-0")}>✓</span>
                      {COPY_FORMAT_LABEL[id]}
                    </span>
                    <span className="pl-5 text-[11px] text-muted-foreground">{COPY_FORMAT_HINT[id]}</span>
                    {peek ? (
                      <span className="truncate pl-5 font-mono text-[10px] text-muted-foreground/80">{peek}</span>
                    ) : null}
                  </button>
                );
              })}
              <div className="my-1 h-px bg-border" />
              <button
                type="button"
                role="menuitem"
                onClick={function () {
                  setMenuOpen(false);
                  setPreviewOpen(true);
                }}
                className="w-full rounded-md px-2.5 py-2 pl-7 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                先看一眼再复制…
              </button>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent width={440} className="gap-3">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              预览
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                {COPY_FORMAT_LABEL[format]}
              </span>
            </DialogTitle>
          </DialogHeader>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed text-foreground">
            {previewText}
          </pre>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={function () { setPreviewOpen(false); }}>
              关闭
            </Button>
            <Button
              size="sm"
              onClick={function () {
                void copyWith(format);
              }}
            >
              复制
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

const PRIOS: Priority[] = [1, 2, 3, 4];

const DAY_PARTS: { label: string; start: string; end: string }[] = [
  { label: "早晨", start: "07:00", end: "09:00" },
  { label: "上午", start: "09:00", end: "12:00" },
  { label: "下午", start: "13:00", end: "18:00" },
  { label: "晚上", start: "18:00", end: "22:00" },
];

function matchedPart(start: string | null, end: string | null): string | null {
  if (!start || !end) return null;
  for (let i = 0; i < DAY_PARTS.length; i++) {
    if (DAY_PARTS[i].start === start && DAY_PARTS[i].end === end) return DAY_PARTS[i].label;
  }
  return null;
}

function timeText(start: string | null, end: string | null): string {
  if (start && end) return start + "–" + end;
  return start || end || "";
}

function SubtaskLine(props: {
  sub: Subtask;
  dragging?: boolean;
  drop?: boolean;
  onToggle: () => void;
  onRename: (title: string) => void;
  onRemove: () => void;
  onGripDown: (e: React.PointerEvent<HTMLSpanElement>) => void;
}) {
  const [draft, setDraft] = React.useState(props.sub.title);
  React.useEffect(
    function () {
      setDraft(props.sub.title);
    },
    [props.sub.title]
  );
  function commit() {
    const next = draft.trim();
    if (!next || next === props.sub.title) {
      setDraft(props.sub.title);
      return;
    }
    props.onRename(next);
  }
  return (
    <li
      data-kedu="sub-row"
      data-id={props.sub.id}
      className={cn(
        "group relative flex items-center gap-1.5 border-b border-border py-1.5",
        props.dragging ? "opacity-40" : ""
      )}
    >
      {props.drop ? <span className="absolute inset-x-0 top-0 h-px bg-foreground" /> : null}
      {/* Always-on quiet grip — avoids a blank left gutter that only fills on hover. */}
      <span
        aria-label="拖动排序"
        title="拖动排序"
        onPointerDown={props.onGripDown}
        onClick={function (e) {
          e.stopPropagation();
        }}
        className={cn(
          "-ml-0.5 grid size-4 shrink-0 cursor-grab place-items-center transition-colors active:cursor-grabbing",
          props.dragging
            ? "text-foreground"
            : "text-muted-foreground/40 hover:text-muted-foreground group-hover:text-muted-foreground"
        )}
      >
        <Icon.GripVertical size={13} strokeWidth={2} />
      </span>
      <TaskCheck done={props.sub.done} onToggle={props.onToggle} />
      <input
        value={draft}
        aria-label="子任务"
        onChange={function (e) {
          setDraft(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={function (e) {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(props.sub.title);
            e.currentTarget.blur();
          }
        }}
        className={cn(
          "min-w-0 flex-1 bg-transparent text-sm outline-none",
          props.sub.done ? "text-muted-foreground line-through" : "text-foreground"
        )}
      />
      {props.sub.done ? (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/75">
          {props.sub.completedAt ? relativeTime(props.sub.completedAt) : "完成"}
        </span>
      ) : null}
      <button
        type="button"
        aria-label="删除子任务"
        onClick={props.onRemove}
        className="text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
      >
        <Icon.X size={12} />
      </button>
    </li>
  );
}

function reorderSubs(list: Subtask[], fromId: string, toId: string): Subtask[] | null {
  if (fromId === toId) return null;
  const ids = list.map(function (s) {
    return s.id;
  });
  const a = ids.indexOf(fromId);
  const b = ids.indexOf(toId);
  if (a < 0 || b < 0) return null;
  const next = list.slice();
  const [item] = next.splice(a, 1);
  next.splice(b, 0, item);
  return next;
}

function Chip(props: { on: boolean; children: React.ReactNode; onClick: () => void; part?: string }) {
  return (
    <button
      type="button"
      data-kedu={props.part ? "day-part" : undefined}
      data-part={props.part}
      aria-pressed={props.on}
      onClick={props.onClick}
      className={cn(
        "rounded-full border px-2 py-0.5 text-xs",
        props.on ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground hover:text-foreground"
      )}
    >
      {props.children}
    </button>
  );
}

const TAG_LIMIT = 8;
const TAG_LEN = 16;
const SUGGEST_LIMIT = 8;

/** Available tags for this task: exclude already-chosen, rank by active frequency, then filter by draft. */
function tagChoices(all: string[], chosen: string[], draft: string, freq: { name: string; count: number }[]): string[] {
  const taken: Record<string, true> = {};
  for (let i = 0; i < chosen.length; i++) taken[chosen[i]] = true;
  const rank: Record<string, number> = {};
  for (let i = 0; i < freq.length; i++) rank[freq[i].name] = freq[i].count;
  const q = draft.trim().toLowerCase();
  const pool: string[] = [];
  for (let i = 0; i < all.length; i++) {
    const name = all[i];
    if (taken[name]) continue;
    if (q && name.toLowerCase().indexOf(q) < 0) continue;
    pool.push(name);
  }
  pool.sort(function (a, b) {
    if (q) {
      const ea = a.toLowerCase() === q ? 0 : 1;
      const eb = b.toLowerCase() === q ? 0 : 1;
      if (ea !== eb) return ea - eb;
    }
    const da = rank[a] === undefined ? 0 : rank[a];
    const db = rank[b] === undefined ? 0 : rank[b];
    if (db !== da) return db - da;
    return a.localeCompare(b, "zh");
  });
  return pool.slice(0, SUGGEST_LIMIT);
}

function TagField(props: {
  value: string[];
  allTags: string[];
  freq: { name: string; count: number }[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = React.useState("");
  const [index, setIndex] = React.useState(0);
  const [focused, setFocused] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const full = props.value.length >= TAG_LIMIT;
  const typed = draft.trim();
  const choices = full ? [] : tagChoices(props.allTags, props.value, typed, props.freq);
  const lower = typed.toLowerCase();
  function hasName(list: string[]): boolean {
    for (let i = 0; i < list.length; i++) {
      if (list[i].toLowerCase() === lower) return true;
    }
    return false;
  }
  const canCreate =
    Boolean(typed) && typed.length <= TAG_LEN && !full && !hasName(props.value) && !hasName(props.allTags);
  // Empty draft: chips only. Typing: filtered chips + optional "create".
  type Row = { kind: "pick" | "create"; name: string };
  const rows: Row[] = [];
  if (!full) {
    for (let i = 0; i < choices.length; i++) rows.push({ kind: "pick", name: choices[i] });
    if (canCreate) rows.push({ kind: "create", name: typed });
  }

  React.useEffect(
    function () {
      setIndex(0);
    },
    [typed, props.value.join("\0"), props.allTags.join("\0")]
  );

  function add(name: string) {
    const next = name.trim();
    if (!next || next.length > TAG_LEN || props.value.indexOf(next) >= 0 || props.value.length >= TAG_LIMIT) return;
    props.onChange(props.value.concat([next]));
    setDraft("");
    setIndex(0);
    window.requestAnimationFrame(function () {
      if (inputRef.current) inputRef.current.focus();
    });
  }

  function remove(name: string) {
    props.onChange(
      props.value.filter(function (t) {
        return t !== name;
      })
    );
  }

  function commitDraft() {
    if (!typed) return;
    if (rows.length) {
      const row = rows[Math.min(index, rows.length - 1)];
      add(row.name);
      return;
    }
    add(typed);
  }

  return (
    <div data-kedu="tag-field" className="flex flex-col gap-2">
      {props.value.length ? (
        <div className="flex flex-wrap gap-1.5" aria-label="已选标签">
          {props.value.map(function (name) {
            return (
              <span
                key={name}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-xs text-foreground"
              >
                {"#" + name}
                <button
                  type="button"
                  aria-label={"移除 " + name}
                  onClick={function () {
                    remove(name);
                  }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Icon.X size={11} />
                </button>
              </span>
            );
          })}
        </div>
      ) : null}

      {!full ? (
        <input
          ref={inputRef}
          value={draft}
          autoComplete="off"
          spellCheck={false}
          aria-label="添加标签"
          aria-autocomplete="list"
          placeholder={props.value.length ? "再加一个，回车" : "输入标签，回车添加"}
          onFocus={function () {
            setFocused(true);
          }}
          onBlur={function () {
            setFocused(false);
          }}
          onChange={function (e) {
            setDraft(e.target.value);
          }}
          onKeyDown={function (e) {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Escape") {
              if (draft) {
                e.preventDefault();
                setDraft("");
              }
              return;
            }
            if (rows.length && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "ArrowRight")) {
              e.preventDefault();
              const dir = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
              setIndex(function (prev) {
                return (prev + dir + rows.length) % rows.length;
              });
              return;
            }
            if (e.key === "Backspace" && !draft && props.value.length) {
              remove(props.value[props.value.length - 1]);
              return;
            }
            if (e.key !== "Enter") return;
            e.preventDefault();
            commitDraft();
          }}
          className="h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      ) : (
        <p className="text-[11px] text-muted-foreground">最多 {TAG_LIMIT} 个标签</p>
      )}

      {rows.length ? (
        <div className="flex flex-wrap gap-1.5" role="listbox" aria-label={typed ? "匹配的标签" : "选用已有标签"}>
          {rows.map(function (row, i) {
            const on = focused && i === index;
            const label = row.kind === "create" ? "加上 #" + row.name : "#" + row.name;
            return (
              <button
                key={row.kind + ":" + row.name}
                type="button"
                role="option"
                aria-selected={on}
                onMouseDown={function (e) {
                  e.preventDefault();
                  add(row.name);
                }}
                onMouseEnter={function () {
                  setIndex(i);
                }}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-xs transition-colors",
                  on
                    ? "border-foreground bg-foreground text-background"
                    : row.kind === "create"
                      ? "border-dashed border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground"
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function TaskDetail() {
  const { call } = useApp();
  const { tasks, tags, stats, selectedId, openTask, actions, today } = useStore();
  const task = tasks.find(function (t) {
    return t.id === selectedId;
  });
  const [title, setTitle] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [draftSub, setDraftSub] = React.useState("");
  const subDragId = React.useRef<string | null>(null);
  const [subDragging, setSubDragging] = React.useState<string | null>(null);
  const [subOverId, setSubOverId] = React.useState<string | null>(null);
  const [urls, setUrls] = React.useState<Record<string, string>>({});
  const [confirmDel, setConfirmDel] = React.useState(false);
  const [timeOpen, setTimeOpen] = React.useState(false);
  const [lightboxId, setLightboxId] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const actionsRef = React.useRef(actions);
  actionsRef.current = actions;
  const callRef = React.useRef(call);
  callRef.current = call;

  const imageKey = task ? task.images.map(function (im) { return im.id; }).join(",") : "";

  React.useEffect(
    function () {
      setTitle(task ? task.title : "");
      setNotes(task ? task.notes : "");
      setDraftSub("");
      setConfirmDel(false);
      setTimeOpen(false);
      setLightboxId(null);
    },
    [task ? task.id : ""]
  );

  React.useEffect(
    function () {
      if (!task || !imageKey) {
        setUrls({});
        return;
      }
      const ids = imageKey.split(",");
      let alive = true;
      void callRef.current("imagesGet", { ids }).then(function (res) {
        if (!alive || !res || typeof res !== "object") return;
        setUrls(res as Record<string, string>);
      });
      return function () {
        alive = false;
      };
    },
    [task ? task.id : "", imageKey]
  );

  React.useEffect(
    function () {
      if (!task) return;
      const id = task.id;
      function onPaste(e: ClipboardEvent) {
        const files = imageFilesFrom(e.clipboardData);
        if (!files.length) return;
        e.preventDefault();
        void take(id, files);
      }
      window.addEventListener("paste", onPaste);
      return function () {
        window.removeEventListener("paste", onPaste);
      };
    },
    [task ? task.id : "", task ? task.images.length : 0]
  );

  async function take(taskId: string, files: File[]) {
    const current = tasks.find(function (t) {
      return t.id === taskId;
    });
    let room = 8 - (current ? current.images.length : 0);
    if (room <= 0) {
      toast.add({ title: "最多 8 张图" });
      return;
    }
    for (let i = 0; i < files.length && room > 0; i++) {
      const img = await shrinkImage(files[i]);
      if (!img) continue;
      await actionsRef.current.addImage(taskId, img.data, img.w, img.h);
      room -= 1;
    }
  }

  if (!task) return null;

  const current = task;
  const hasRange = Boolean(current.starts && current.due && current.starts !== current.due);

  function patch(p: Record<string, unknown>) {
    void actions.patch(current.id, p);
  }

  function commitTitle() {
    const next = title.trim();
    if (!next || next === current.title) {
      setTitle(current.title);
      return;
    }
    patch({ title: next });
  }

  function setSpan(starts: string | null, due: string | null) {
    if (starts && due && starts > due) {
      const swap = starts;
      starts = due;
      due = swap;
    }
    if (starts && due && starts === due) starts = null;
    patch({ starts, due });
  }

  function setStart(d: Date | undefined) {
    if (!d) {
      patch({ starts: null });
      return;
    }
    const key = dateKey(d);
    const end = current.due;
    if (!end || key === end) {
      setSpan(null, key);
      return;
    }
    setSpan(key, end);
  }

  function setEnd(d: Date | undefined) {
    if (!d) {
      setSpan(null, null);
      return;
    }
    const key = dateKey(d);
    const start = current.starts;
    if (!start || start === key) {
      setSpan(null, key);
      return;
    }
    setSpan(start, key);
  }

  const thisWeek = weekSpan(today, "this");
  const nextWeek = weekSpan(today, "next");
  const presets: { label: string; starts: string | null; due: string | null }[] = [
    { label: "今天", starts: null, due: today },
    { label: "明天", starts: null, due: shiftKey(today, 1) },
    { label: "这三天", starts: today, due: shiftKey(today, 2) },
    { label: "本周", starts: thisWeek.starts, due: thisWeek.due },
    { label: "下周", starts: nextWeek.starts, due: nextWeek.due },
    { label: "不排期", starts: null, due: null },
  ];

  function presetOn(q: { starts: string | null; due: string | null }): boolean {
    if (!q.due) return !current.due;
    if (!q.starts || q.starts === q.due) return current.due === q.due && !hasRange;
    return current.starts === q.starts && current.due === q.due;
  }

  const schedule = scheduleOf(current, today);
  const whenLabel =
    hasRange && current.starts && current.due
      ? fmtShort(current.starts) + " → " + fmtShort(current.due)
      : schedule
        ? schedule.label
        : "还没排进哪一天";
  const startValue = current.starts || current.due;

  function addSub() {
    const text = draftSub.trim();
    if (!text) return;
    const subs: Subtask[] = current.subtasks.concat([{ id: "", title: text, done: false, completedAt: null }]);
    patch({ subtasks: subs });
    setDraftSub("");
  }

  function subGripDown(subId: string, event: React.PointerEvent<HTMLSpanElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const startY = event.clientY;
    const snapshot = current.subtasks.slice();
    let active = false;
    const handle = event.currentTarget;
    try {
      handle.setPointerCapture(pointerId);
    } catch (e) {
      /* window listeners still follow the pointer */
    }
    function rowAt(x: number, y: number): string | null {
      const el = document.elementFromPoint(x, y);
      const row = el && el.closest ? el.closest("[data-kedu=sub-row]") : null;
      return row ? row.getAttribute("data-id") : null;
    }
    function onMove(ev: PointerEvent) {
      if (ev.pointerId !== pointerId) return;
      if (!active && Math.abs(ev.clientY - startY) < 5) return;
      if (!active) {
        active = true;
        subDragId.current = subId;
        setSubDragging(subId);
      }
      const id = rowAt(ev.clientX, ev.clientY);
      setSubOverId(function (prev) {
        return prev === id ? prev : id;
      });
    }
    function finish(ev: PointerEvent) {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (active) {
        const id = rowAt(ev.clientX, ev.clientY);
        const from = subDragId.current;
        if (from && id) {
          const next = reorderSubs(snapshot, from, id);
          if (next) patch({ subtasks: next });
        }
      }
      subDragId.current = null;
      setSubDragging(null);
      setSubOverId(null);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }

  return (
    <div data-kedu="detail" className="relative h-full overflow-auto px-5 pt-4 pb-5">
      <button
        type="button"
        aria-label="关闭"
        onClick={function () {
          openTask(null);
        }}
        className="absolute right-3 top-3 z-10 grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Icon.X size={16} />
      </button>
      <div className="pr-8">
          <ExpandEditor
            value={title}
            onChange={setTitle}
            onCommit={commitTitle}
            label="标题"
            collapsedRows={1}
            enterCommits
            wrapClassName="mt-1"
            textClassName="text-xl font-medium"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            {"创建于 " + relativeTime(current.createdAt)}
            {current.completedAt ? " · 完成于 " + relativeTime(current.completedAt) : ""}
            {current.doing && !current.done ? " · 进行中" : ""}
          </p>

          {!current.done ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              <button
                type="button"
                data-kedu="doing-chip"
                aria-pressed={Boolean(current.doing)}
                data-on={current.doing ? "1" : "0"}
                onClick={function () {
                  patch({ doing: !current.doing });
                }}
                className={cn(
                  "kedu-doing-chip rounded-full border px-3 py-1 text-xs transition-colors",
                  current.doing
                    ? ""
                    : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                )}
              >
                {current.doing ? "进行中" : "标为进行中"}
              </button>
            </div>
          ) : null}

          <label className="mt-4 block text-[11px] tracking-wide text-muted-foreground" htmlFor="kedu-notes">备注</label>
          <ExpandEditor
            id="kedu-notes"
            value={notes}
            onChange={setNotes}
            onCommit={function () {
              if (notes !== current.notes) patch({ notes });
            }}
            label="备注"
            placeholder="补充一句就够"
            collapsedRows={2}
            wrapClassName="mt-2"
            textClassName="kedu-edge py-0.5 pl-3 text-sm"
            collapsedClassName="border-l-2"
            editingClassName="border-l-2"
          />

          <section className="mt-5 border-t border-border pt-3">
            <p className="text-[11px] tracking-wide text-muted-foreground">安排</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {presets.map(function (q) {
                return (
                  <Chip key={q.label} on={presetOn(q)} onClick={function () { setSpan(q.starts, q.due); }}>
                    {q.label}
                  </Chip>
                );
              })}
            </div>
            <p className="mt-2 text-sm text-foreground">{whenLabel}</p>
            <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-end gap-2">
              <div>
                <p className="mb-1 text-[11px] text-muted-foreground">开始</p>
                <DatePicker
                  className="w-full"
                  placeholder="选择"
                  {...(startValue ? { value: parseKey(startValue) } : {})}
                  onChange={function (d) {
                    setStart(d);
                  }}
                />
              </div>
              <span className="pb-2 text-sm text-muted-foreground">→</span>
              <div>
                <p className="mb-1 text-[11px] text-muted-foreground">结束</p>
                <DatePicker
                  className="w-full"
                  placeholder="选择"
                  {...(current.due ? { value: parseKey(current.due) } : {})}
                  onChange={function (d) {
                    setEnd(d);
                  }}
                />
              </div>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5" role="group" aria-label="时间">
              {DAY_PARTS.map(function (part) {
                const on = matchedPart(current.startTime, current.endTime) === part.label;
                return (
                  <Chip
                    key={part.label}
                    part={part.label}
                    on={on}
                    onClick={function () {
                      setTimeOpen(false);
                      if (on) patch({ startTime: null, endTime: null });
                      else patch({ startTime: part.start, endTime: part.end });
                    }}
                  >
                    {part.label}
                  </Chip>
                );
              })}
              <Chip
                part="自定义"
                on={timeOpen || Boolean((current.startTime || current.endTime) && !matchedPart(current.startTime, current.endTime))}
                onClick={function () {
                  setTimeOpen(!timeOpen);
                }}
              >
                自定义
              </Chip>
            </div>
            {timeOpen ? (
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="time"
                  aria-label="开始时间"
                  value={current.startTime || ""}
                  onChange={function (e) {
                    patch({ startTime: e.target.value || null });
                  }}
                  className="kedu-edge h-8 rounded-md border bg-transparent px-2 text-sm"
                />
                <span className="text-xs text-muted-foreground">到</span>
                <input
                  type="time"
                  aria-label="结束时间"
                  value={current.endTime || ""}
                  onChange={function (e) {
                    patch({ endTime: e.target.value || null });
                  }}
                  className="kedu-edge h-8 rounded-md border bg-transparent px-2 text-sm"
                />
                {current.startTime || current.endTime ? (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={function () {
                      patch({ startTime: null, endTime: null });
                      setTimeOpen(false);
                    }}
                  >
                    清除
                  </button>
                ) : null}
              </div>
            ) : current.startTime || current.endTime ? (
              <Mono className="mt-1.5 block text-muted-foreground">{timeText(current.startTime, current.endTime)}</Mono>
            ) : null}
          </section>

          <section className="mt-5 border-t border-border pt-3">
            <p className="text-[11px] tracking-wide text-muted-foreground">优先级</p>
            <div className="mt-2 grid grid-cols-4 gap-1 rounded-lg bg-muted p-1" role="group" aria-label="优先级">
              {PRIOS.map(function (p) {
                const on = current.priority === p;
                return (
                  <button
                    key={p}
                    type="button"
                    aria-pressed={on}
                    onClick={function () {
                      patch({ priority: p });
                    }}
                    className={cn(
                      "rounded-md px-1 py-1.5 text-center text-xs",
                      on ? "bg-background text-foreground" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <span className="block">{PRIORITY_LABEL[p]}</span>
                    <span className="block text-[10px]">{PRIORITY_TITLE[p]}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="mt-5 border-t border-border pt-3">
            <p className="mb-2 text-[11px] tracking-wide text-muted-foreground">标签</p>
            <TagField
              value={current.tags}
              allTags={tags}
              freq={stats.tags}
              onChange={function (next) {
                patch({ tags: next.slice(0, TAG_LIMIT) });
              }}
            />
          </section>

          <section className="mt-5 border-t border-border pt-3">
            <p className="text-[11px] tracking-wide text-muted-foreground">
              子任务
              {current.subtasks.length ? <Mono className="ml-2">{current.subtasks.filter(function (s) { return s.done; }).length + "/" + current.subtasks.length}</Mono> : null}
            </p>
            <ul className="mt-1">
              {current.subtasks.map(function (s) {
                return (
                  <SubtaskLine
                    key={s.id}
                    sub={s}
                    dragging={subDragging === s.id}
                    drop={Boolean(subDragging && subOverId === s.id && subDragging !== s.id)}
                    onGripDown={function (e) {
                      subGripDown(s.id, e);
                    }}
                    onToggle={function () {
                      patch({
                        subtasks: current.subtasks.map(function (item) {
                          if (item.id !== s.id) return item;
                          const done = !item.done;
                          return {
                            id: item.id,
                            title: item.title,
                            done: done,
                            completedAt: done ? Date.now() : null,
                          };
                        }),
                      });
                    }}
                    onRename={function (title) {
                      patch({
                        subtasks: current.subtasks.map(function (item) {
                          return item.id === s.id
                            ? {
                                id: item.id,
                                title: title,
                                done: item.done,
                                completedAt: item.completedAt == null ? null : item.completedAt,
                              }
                            : item;
                        }),
                      });
                    }}
                    onRemove={function () {
                      patch({
                        subtasks: current.subtasks.filter(function (item) {
                          return item.id !== s.id;
                        }),
                      });
                    }}
                  />
                );
              })}
            </ul>
            <input
              value={draftSub}
              aria-label="新的子任务"
              placeholder="加一条子任务，回车"
              onChange={function (e) {
                setDraftSub(e.target.value);
              }}
              onKeyDown={function (e) {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addSub();
                }
              }}
              className="mt-2 h-8 w-full bg-transparent pl-[2.75rem] text-sm outline-none placeholder:text-muted-foreground"
            />
          </section>

          <section className="mt-5 border-t border-border pt-3">
            <div className="flex items-center justify-between">
              <p className="text-[11px] tracking-wide text-muted-foreground">图片</p>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={function () {
                  if (fileRef.current) fileRef.current.click();
                }}
              >
                添加
              </button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={function (e) {
                const list = e.target.files;
                const files: File[] = [];
                if (list) for (let i = 0; i < list.length; i++) files.push(list[i]);
                e.target.value = "";
                void take(current.id, files);
              }}
            />
            {current.images.length ? (
              <div className="mt-2 grid grid-cols-3 gap-2">
                {current.images.map(function (im) {
                  const src = urls[im.id];
                  return (
                    <div
                      key={im.id}
                      className="group relative overflow-hidden rounded-md border border-border bg-muted/40"
                    >
                      <button
                        type="button"
                        aria-label="预览图片"
                        disabled={!src}
                        onClick={function () {
                          if (src) setLightboxId(im.id);
                        }}
                        className="block w-full"
                      >
                        <span className="relative flex aspect-square w-full items-center justify-center p-1.5">
                          {src ? (
                            <img src={src} alt="" className="max-h-full max-w-full object-contain" />
                          ) : (
                            <span className="size-full rounded-sm bg-muted" />
                          )}
                          {src ? (
                            <span
                              aria-hidden
                              className="pointer-events-none absolute inset-0 flex items-center justify-center bg-foreground/0 opacity-0 transition-opacity group-hover:bg-foreground/25 group-hover:opacity-100"
                            >
                              <span className="grid size-8 place-items-center rounded-full bg-background/95 text-foreground shadow-sm">
                                <Icon.Expand size={15} strokeWidth={2} />
                              </span>
                            </span>
                          ) : null}
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label="移除图片"
                        onClick={function (e) {
                          e.stopPropagation();
                          void actions.removeImage(current.id, im.id);
                        }}
                        className="absolute right-1 top-1 z-10 grid size-5 place-items-center rounded-full bg-background text-foreground shadow-sm"
                      >
                        <Icon.X size={11} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">可以粘贴截图，最多 8 张。</p>
            )}
          </section>

          <div className="mt-6 flex items-center gap-2 border-t border-border pt-3">
            <Button variant="destructive" size="sm" onClick={function () { setConfirmDel(true); }}>
              删除这件事
            </Button>
            <span className="flex-1" />
            <CopyTaskButton task={current} />
          </div>
      </div>
      <ConfirmDialog
        open={confirmDel}
        onOpenChange={setConfirmDel}
        title="删除这件事？"
        description="可以马上撤销。"
        confirmLabel="删除"
        onConfirm={function () {
          setConfirmDel(false);
          void actions.remove(current.id);
        }}
      />
      <Dialog
        open={Boolean(lightboxId)}
        onOpenChange={function (open) {
          if (!open) setLightboxId(null);
        }}
      >
        <DialogContent width={720} className="gap-3 p-3 sm:max-w-3xl">
          <DialogHeader className="px-1 pt-1">
            <DialogTitle className="text-sm font-medium">图片预览</DialogTitle>
          </DialogHeader>
          <div className="flex max-h-[min(80vh,720px)] items-center justify-center overflow-auto rounded-md bg-muted/30 p-2">
            {lightboxId && urls[lightboxId] ? (
              <img
                src={urls[lightboxId]}
                alt=""
                className="max-h-[min(78vh,680px)] max-w-full object-contain"
              />
            ) : (
              <div className="h-40 w-full rounded-md bg-muted" />
            )}
          </div>
          {current.images.length > 1 ? (
            <div className="flex items-center justify-between gap-2 px-1 pb-1">
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={function () {
                  if (!lightboxId) return;
                  const ids = current.images.map(function (im) {
                    return im.id;
                  });
                  const i = ids.indexOf(lightboxId);
                  const prev = i <= 0 ? ids.length - 1 : i - 1;
                  setLightboxId(ids[prev]);
                }}
              >
                上一张
              </button>
              <Mono className="text-muted-foreground">
                {String(
                  current.images.findIndex(function (im) {
                    return im.id === lightboxId;
                  }) + 1
                ) +
                  " / " +
                  String(current.images.length)}
              </Mono>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={function () {
                  if (!lightboxId) return;
                  const ids = current.images.map(function (im) {
                    return im.id;
                  });
                  const i = ids.indexOf(lightboxId);
                  const next = i < 0 || i >= ids.length - 1 ? 0 : i + 1;
                  setLightboxId(ids[next]);
                }}
              >
                下一张
              </button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
