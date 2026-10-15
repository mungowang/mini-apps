import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Button,
  ConfirmDialog,
  Icon,
  Kbd,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  Toaster,
  toast,
  useApp,
  cn,
} from "@mohou/ui";

import { computeStats, dayHeading, homeView, inOnceRange, inView, onToday, shiftKey, todayKey } from "./shared/model";
import type { OnceRange, Pack, Priority, SortId, Task, ViewId } from "./shared/types";
import { Mono, TickBar } from "./ui/atoms";
import { Capture } from "./ui/capture";
import { Commands } from "./ui/commands";
import { FilterButton } from "./ui/filter";
import { Archive } from "./ui/archive";
import { GRACE_MS, TaskList } from "./ui/list";
import { OnceList, OnceRangeBar } from "./ui/once";
import { ContextRail } from "./ui/rail";
import { StoreCtx } from "./ui/store";
import type { Actions, Store } from "./ui/store";

const WIDE_AT = 960;
const DESK_AT = 1280;
const SINGLE_MAX = 720;
const LAYOUT_KEY = "kedu-layout";
const SORT_KEY = "kedu-sort";
/** ResizablePanelGroup layouts (panel id → %). desk = preview+main+rail, wide = main+rail. */
const SPLIT_KEY = "kedu-split-layout";

type SplitKind = "desk" | "wide";
type SplitLayout = Record<string, number>;

function defaultSplitLayout(kind: SplitKind): SplitLayout {
  if (kind === "desk") return { preview: 26, main: 48, rail: 26 };
  return { main: 64, rail: 36 };
}

function clampSplitLayout(kind: SplitKind, raw: SplitLayout): SplitLayout {
  const base = defaultSplitLayout(kind);
  const next: SplitLayout = {};
  const ids = Object.keys(base);
  let sum = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const n = typeof raw[id] === "number" && isFinite(raw[id]) ? raw[id] : base[id];
    const v = Math.min(70, Math.max(12, n));
    next[id] = v;
    sum += v;
  }
  if (sum <= 0) return base;
  // Renormalize so ids sum to 100 — Resizable expects a full layout.
  for (let i = 0; i < ids.length; i++) next[ids[i]] = (next[ids[i]] / sum) * 100;
  return next;
}

function readSplitLayout(kind: SplitKind): SplitLayout {
  try {
    const raw = window.localStorage.getItem(SPLIT_KEY);
    if (!raw) return defaultSplitLayout(kind);
    const parsed = JSON.parse(raw) as { desk?: SplitLayout; wide?: SplitLayout };
    const got = parsed && parsed[kind];
    if (got && typeof got === "object") return clampSplitLayout(kind, got);
  } catch (e) {
    /* fall through */
  }
  return defaultSplitLayout(kind);
}

function writeSplitLayout(kind: SplitKind, layout: SplitLayout) {
  try {
    let all: { desk?: SplitLayout; wide?: SplitLayout } = {};
    try {
      const raw = window.localStorage.getItem(SPLIT_KEY);
      if (raw) all = JSON.parse(raw) as { desk?: SplitLayout; wide?: SplitLayout };
    } catch (e) {
      all = {};
    }
    all[kind] = clampSplitLayout(kind, layout);
    window.localStorage.setItem(SPLIT_KEY, JSON.stringify(all));
  } catch (e) {
    /* still applied for this visit */
  }
}

/** Wide/desk: official Resizable splitters. Narrow: main only (+ optional overlay rail). */
function StageShell(props: {
  useSplit: boolean;
  showPreview: boolean;
  dockRail: boolean;
  splitKind: SplitKind;
  splitLayout: SplitLayout;
  onSplitChanged: (layout: SplitLayout, meta: { isUserInteraction?: boolean; requestedLayout?: SplitLayout }) => void;
  preview: React.ReactNode;
  rail: React.ReactNode;
  overlayRail: React.ReactNode;
  children: React.ReactNode;
}) {
  const groupRef = React.useRef<{ setLayout: (layout: SplitLayout) => void } | null>(null);

  // Apply the saved layout when desk ↔ wide flips — do NOT remount the group (that
  // tore down the whole main tree and felt like a 2–3s hang).
  React.useLayoutEffect(
    function () {
      if (!props.useSplit) return;
      const g = groupRef.current;
      if (g && typeof g.setLayout === "function") {
        try {
          g.setLayout(props.splitLayout);
        } catch (e) {
          /* first paint may race panel mount */
        }
      }
    },
    [props.useSplit, props.splitKind, props.showPreview, props.dockRail]
  );

  if (!props.useSplit) {
    return (
      <>
        {props.children}
        {props.overlayRail}
      </>
    );
  }

  // Numbers = px in react-resizable-panels v4; use "N" strings for percentages.
  // No Fragments — Group expects Panel/Separator as direct children.
  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="h-full min-h-0 w-full"
      defaultLayout={props.splitLayout}
      groupRef={groupRef as any}
      onLayoutChanged={props.onSplitChanged as any}
    >
      {props.showPreview ? (
        <ResizablePanel id="preview" minSize="16" maxSize="42" className="min-h-0">
          {props.preview}
        </ResizablePanel>
      ) : null}
      {props.showPreview ? <ResizableHandle withHandle /> : null}
      <ResizablePanel id="main" minSize="28" className="min-h-0">
        {props.children}
      </ResizablePanel>
      {props.dockRail ? <ResizableHandle withHandle /> : null}
      {props.dockRail ? (
        <ResizablePanel id="rail" minSize="16" maxSize="42" className="min-h-0">
          {props.rail}
        </ResizablePanel>
      ) : null}
    </ResizablePanelGroup>
  );
}
/** 1 = jump to 收集 + open detail after adding an unscheduled task. Default on. */
const FOLLOW_INBOX_KEY = "kedu-follow-inbox";
const ONCE_RANGE_KEY = "kedu-once-range";

type LayoutMode = "narrow" | "wide" | "desk";

function readPinned(): LayoutMode | null {
  try {
    const value = window.localStorage.getItem(LAYOUT_KEY);
    if (value === "narrow" || value === "wide" || value === "desk") return value;
  } catch (e) {
    return null;
  }
  return null;
}

/** The sort the owner last chose. A stale or foreign value falls back to manual. */
function readSort(): SortId {
  try {
    const value = window.localStorage.getItem(SORT_KEY);
    if (value === "manual" || value === "due" || value === "priority" || value === "created") return value;
  } catch (e) {
    /* storage can be closed; this visit still sorts */
  }
  return "manual";
}

/** Missing key means on — the product default is to finish collecting in one motion. */
function readFollowInbox(): boolean {
  try {
    const value = window.localStorage.getItem(FOLLOW_INBOX_KEY);
    if (value === "0" || value === "false") return false;
    if (value === "1" || value === "true") return true;
  } catch (e) {
    /* storage can be closed; this visit still follows */
  }
  return true;
}

/** Default 近 7 天. Stale JSON falls back cleanly. */
function readOnceRange(): OnceRange {
  try {
    const raw = window.localStorage.getItem(ONCE_RANGE_KEY);
    if (!raw) return { mode: "days", n: 7 };
    const parsed = JSON.parse(raw) as { mode?: string; n?: number };
    if (parsed && parsed.mode === "all") return { mode: "all" };
    if (parsed && parsed.mode === "days" && typeof parsed.n === "number") {
      let n = Math.round(parsed.n);
      if (n < 1) n = 1;
      if (n > 365) n = 365;
      return { mode: "days", n: n };
    }
  } catch (e) {
    /* storage can be closed or corrupt */
  }
  return { mode: "days", n: 7 };
}

function fitLayout(width: number): LayoutMode {
  if (width >= DESK_AT) return "desk";
  if (width >= WIDE_AT) return "wide";
  return "narrow";
}

function resolveLayout(pin: LayoutMode | null, width: number): LayoutMode {
  const fit = fitLayout(width);
  if (!pin) return fit;
  if (pin === "narrow") return "narrow";
  if (width < WIDE_AT) return "narrow";
  if (pin === "desk" && width < DESK_AT) return "wide";
  return pin;
}

function LayoutGlyph(props: { cols: 1 | 2 | 3 }) {
  const cuts: number[] = [];
  for (let i = 1; i < props.cols; i++) cuts.push(i);
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="block">
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      {cuts.map(function (i) {
        const x = 2 + (12 * i) / props.cols;
        return <path key={i} d={"M" + x + " 2.5v11"} stroke="currentColor" strokeWidth="1.4" />;
      })}
    </svg>
  );
}

function readWidth(): number {
  return typeof window === "undefined" ? 0 : window.innerWidth;
}

const LENSES: { id: ViewId; label: string; key: string }[] = [
  { id: "today", label: "今天", key: "1" },
  { id: "next", label: "之后", key: "2" },
  { id: "inbox", label: "收集", key: "3" },
  { id: "once", label: "曾经", key: "4" },
];

function isPack(value: unknown): value is Pack {
  return Boolean(value) && typeof value === "object" && Array.isArray((value as Pack).tasks);
}

export default function Ui() {
  const { call } = useApp();
  const callRef = React.useRef(call);
  callRef.current = call;

  const [tasks, setTasks] = React.useState<Task[]>([]);
  const [tags, setTags] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [lens, setLens] = React.useState<ViewId>("today");
  const [sort, setSort] = React.useState<SortId>(readSort);
  const [followInbox, setFollowInboxState] = React.useState<boolean>(readFollowInbox);
  const [onceRange, setOnceRangeState] = React.useState<OnceRange>(readOnceRange);
  const [query, setQuery] = React.useState("");
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [tagFilter, setTagFilter] = React.useState<string | null>(null);
  const [prioFilter, setPrioFilter] = React.useState<Priority[]>([]);
  const [dayFilter, setDayFilter] = React.useState<string | null>(null);
  const [hoverTag, setHoverTag] = React.useState<string | null>(null);
  const [hoverPrio, setHoverPrio] = React.useState<Priority | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [selectMode, setSelectModeState] = React.useState(false);
  const [chosen, setChosen] = React.useState<string[]>([]);
  const [graceIds, setGraceIds] = React.useState<string[]>([]);
  const graceTimers = React.useRef<Record<string, number>>({});

  function clearGraceTimer(id: string) {
    const handle = graceTimers.current[id];
    if (!handle) return;
    window.clearTimeout(handle);
    delete graceTimers.current[id];
  }

  function armGrace(ids: string[]) {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      clearGraceTimer(id);
      graceTimers.current[id] = window.setTimeout(function () {
        delete graceTimers.current[id];
        setGraceIds(function (prev) {
          return prev.filter(function (x) {
            return x !== id;
          });
        });
      }, GRACE_MS);
    }
    setGraceIds(function (prev) {
      const next = prev.slice();
      for (let i = 0; i < ids.length; i++) if (next.indexOf(ids[i]) < 0) next.push(ids[i]);
      return next;
    });
  }

  function dropGrace(ids: string[]) {
    for (let i = 0; i < ids.length; i++) clearGraceTimer(ids[i]);
    setGraceIds(function (prev) {
      return prev.filter(function (x) {
        return ids.indexOf(x) < 0;
      });
    });
  }

  React.useEffect(function () {
    const timers = graceTimers.current;
    return function () {
      const keys = Object.keys(timers);
      for (let i = 0; i < keys.length; i++) window.clearTimeout(timers[keys[i]]);
    };
  }, []);
  const [undo, setUndo] = React.useState<Task | null>(null);
  const [rhythmOpen, setRhythmOpen] = React.useState(false);
  const [archiveOpen, setArchiveOpenState] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [confirmClear, setConfirmClear] = React.useState(false);
  const [confirmReset, setConfirmReset] = React.useState(false);
  const [confirmBulk, setConfirmBulk] = React.useState(false);
  const [today, setToday] = React.useState(todayKey());

  const addRef = React.useRef<HTMLTextAreaElement | null>(null);
  const searchRef = React.useRef<HTMLInputElement | null>(null);
  const scroller = React.useRef<HTMLDivElement | null>(null);
  const frameRef = React.useRef<HTMLDivElement | null>(null);
  const [frameWidth, setFrameWidth] = React.useState(readWidth);
  const [settled, setSettled] = React.useState(false);
  const [reduceMotion, setReduceMotion] = React.useState(false);
  const [pinned, setPinned] = React.useState<LayoutMode | null>(readPinned);
  const [deskSplit, setDeskSplit] = React.useState<SplitLayout>(function () {
    return readSplitLayout("desk");
  });
  const [wideSplit, setWideSplit] = React.useState<SplitLayout>(function () {
    return readSplitLayout("wide");
  });
  const settledRef = React.useRef(false);
  const selectedRef = React.useRef<string | null>(null);
  const rhythmRef = React.useRef(false);
  settledRef.current = settled;
  selectedRef.current = selectedId;
  rhythmRef.current = rhythmOpen;
  const layout = resolveLayout(pinned, frameWidth);
  const layoutRef = React.useRef(layout);
  const lensRef = React.useRef(lens);
  const todayRef = React.useRef(today);
  const onceRangeRef = React.useRef(onceRange);
  layoutRef.current = layout;
  lensRef.current = lens;
  todayRef.current = today;
  onceRangeRef.current = onceRange;
  const centered = layout === "narrow" && frameWidth > SINGLE_MAX;

  function chooseLayout(next: LayoutMode) {
    setPinned(next);
    try {
      window.localStorage.setItem(LAYOUT_KEY, next);
    } catch (e) {
      /* the choice still applies for this visit */
    }
  }

  const chooseSort = React.useCallback(function (next: SortId) {
    setSort(next);
    try {
      window.localStorage.setItem(SORT_KEY, next);
    } catch (e) {
      /* the choice still applies for this visit */
    }
  }, []);

  const setFollowInbox = React.useCallback(function (next: boolean) {
    setFollowInboxState(next);
    try {
      window.localStorage.setItem(FOLLOW_INBOX_KEY, next ? "1" : "0");
    } catch (e) {
      /* the choice still applies for this visit */
    }
  }, []);

  const setOnceRange = React.useCallback(function (next: OnceRange) {
    setOnceRangeState(next);
    try {
      window.localStorage.setItem(ONCE_RANGE_KEY, JSON.stringify(next));
    } catch (e) {
      /* the choice still applies for this visit */
    }
  }, []);

  const apply = React.useCallback(function (pack: Pack) {
    setTasks(pack.tasks);
    setTags(pack.tags);
  }, []);

  const run = React.useCallback(
    async function (method: string, args?: Record<string, unknown>) {
      try {
        const res = await callRef.current(method, args || {});
        if (isPack(res)) apply(res);
        return res;
      } catch (e) {
        const msg = String((e as { message?: string } | null)?.message || e);
        toast.add({ title: "没有完成", description: msg });
        return null;
      }
    },
    [apply]
  );

  React.useEffect(function () {
    let alive = true;
    void (async function () {
      try {
        const res = await callRef.current("list", {});
        if (alive && isPack(res)) apply(res);
      } catch (e) {
        if (alive) setLoadError(String((e as { message?: string } | null)?.message || e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return function () {
      alive = false;
    };
  }, [apply]);

  React.useEffect(function () {
    const timer = window.setInterval(function () {
      const key = todayKey();
      setToday(function (prev) {
        return prev === key ? prev : key;
      });
    }, 60000);
    return function () {
      window.clearInterval(timer);
    };
  }, []);

  React.useEffect(
    function () {
      if (!undo) return;
      const timer = window.setTimeout(function () {
        setUndo(null);
      }, 7000);
      return function () {
        window.clearTimeout(timer);
      };
    },
    [undo]
  );

  React.useEffect(
    function () {
      if (scroller.current) scroller.current.scrollTop = 0;
    },
    [lens]
  );

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

  React.useEffect(function () {
    function clear() {
      setHoverTag(null);
      setHoverPrio(null);
    }
    window.addEventListener("blur", clear);
    return function () {
      window.removeEventListener("blur", clear);
    };
  }, []);

  React.useEffect(
    function () {
      const el = frameRef.current;
      if (!el) return;
      function measure() {
        const next = el ? el.clientWidth : 0;
        setFrameWidth(function (prev) {
          return prev === next ? prev : next;
        });
      }
      measure();
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      const id = window.requestAnimationFrame(function () {
        setSettled(true);
      });
      return function () {
        ro.disconnect();
        window.cancelAnimationFrame(id);
      };
    },
    [loading, loadError]
  );

  const setSelectMode = React.useCallback(function (v: boolean) {
    setSelectModeState(v);
    if (!v) setChosen([]);
  }, []);

  const toggleSelect = React.useCallback(function (id: string) {
    setChosen(function (prev) {
      return prev.indexOf(id) >= 0
        ? prev.filter(function (x) {
            return x !== id;
          })
        : prev.concat([id]);
    });
  }, []);

  /**
   * A dated task left 收集. Keep the detail open, and move the main list only when the
   * destination would otherwise be invisible.
   *
   * desk + 收集 + 之后: the side column is already 之后 — stay on 收集 so the queue continues.
   * desk + 收集 + 今天: 今天 is not on screen — switch the main lens.
   * narrow / wide: one list column — always switch to the destination tab.
   */
  const revealLeftInbox = React.useCallback(function (id: string, dest: "today" | "next") {
    setSelectMode(false);
    setSelectedId(id);
    setRhythmOpen(false);
    if (lensRef.current !== "inbox") return;
    if (layoutRef.current === "desk" && dest === "next") return;
    setLens(dest);
  }, []);

  const actions: Actions = React.useMemo(
    function () {
      return {
        add: async function (raw: string, extra) {
          const before: Record<string, boolean> = {};
          for (let i = 0; i < tasks.length; i++) before[tasks[i].id] = true;
          const payload: Record<string, unknown> = { title: raw };
          if (extra && typeof extra.notes === "string" && extra.notes.trim()) payload.notes = extra.notes.trim();
          if (extra && Array.isArray(extra.subtasks) && extra.subtasks.length) payload.subtasks = extra.subtasks;
          const res = await run("add", payload);
          if (!isPack(res)) return null;
          const fresh = res.tasks.find(function (t) {
            return !before[t.id];
          });
          return fresh ? fresh.id : null;
        },
        toggle: async function (id: string) {
          let before: Task | null = null;
          for (let i = 0; i < tasks.length; i++) if (tasks[i].id === id) before = tasks[i];
          const wasDone = Boolean(before && before.done);
          const res = await run("toggle", { id });
          if (!res) return;
          if (wasDone) {
            dropGrace([id]);
            if (before && lensRef.current === "once") {
              const dest = homeView(before, todayRef.current);
              setSelectMode(false);
              setLens(dest);
              setSelectedId(id);
              setRhythmOpen(false);
            }
            return;
          }
          armGrace([id]);
        },
        patch: async function (id: string, patch: Record<string, unknown>) {
          let before: Task | null = null;
          for (let i = 0; i < tasks.length; i++) if (tasks[i].id === id) before = tasks[i];
          const res = await run("update", { id, patch });
          if (!res || !before) return;
          // Date is what leaves 收集. Tags/priority alone stay put.
          if (before.due || !("due" in patch) || !patch.due || typeof patch.due !== "string") return;
          const next = {
            starts: ("starts" in patch ? (patch.starts as string | null) : before.starts) ?? null,
            due: patch.due,
          };
          const dest: "today" | "next" = onToday(next, todayRef.current) ? "today" : "next";
          revealLeftInbox(id, dest);
        },
        remove: async function (id: string) {
          let snapshot: Task | null = null;
          for (let i = 0; i < tasks.length; i++) if (tasks[i].id === id) snapshot = tasks[i];
          const res = await run("remove", { id });
          if (res && snapshot) {
            setUndo(snapshot);
            setSelectedId(function (prev) {
              return prev === id ? null : prev;
            });
          }
        },
        undoRemove: async function () {
          if (!undo) return;
          await run("restore", { task: undo });
          setUndo(null);
        },
        reorder: async function (ids: string[]) {
          await run("reorder", { ids });
        },
        bulkSchedule: async function (ids: string[], due: string | null) {
          if (!ids.length) return;
          const fromInbox = lensRef.current === "inbox";
          await run("bulk", { ids, action: "schedule", patch: { due: due, starts: null } });
          setChosen([]);
          if (!fromInbox || !due) return;
          const dest: "today" | "next" = onToday({ starts: null, due: due }, todayRef.current) ? "today" : "next";
          revealLeftInbox(ids[0], dest);
        },
        bulk: async function (ids: string[], action: "done" | "active" | "remove") {
          const fromOnce = lensRef.current === "once";
          let sample: Task | null = null;
          if (fromOnce && action === "active" && ids.length) {
            for (let i = 0; i < tasks.length; i++) {
              if (tasks[i].id === ids[0]) {
                sample = tasks[i];
                break;
              }
            }
          }
          const res = await run("bulk", { ids, action });
          setChosen([]);
          if (!res) return;
          if (action === "remove") {
            setSelectedId(function (prev) {
              return prev && ids.indexOf(prev) >= 0 ? null : prev;
            });
          }
          if (action === "active") {
            dropGrace(ids);
            if (fromOnce && sample) {
              const dest = homeView(sample, todayRef.current);
              setSelectMode(false);
              setLens(dest);
              setSelectedId(ids[0]);
              setRhythmOpen(false);
            }
            return;
          }
          if (action === "done") armGrace(ids);
        },
        clearDone: async function () {
          const res = await run("clearDone", {});
          if (!res) return;
          setSelectedId(function (prev) {
            if (!prev) return prev;
            const hit = tasks.find(function (t) {
              return t.id === prev;
            });
            return hit && hit.done ? null : prev;
          });
        },
        addImage: async function (taskId: string, data: string, w: number, h: number) {
          await run("imageAdd", { taskId, data, w, h });
        },
        removeImage: async function (taskId: string, id: string) {
          await run("imageRemove", { taskId, id });
        },
        reset: async function () {
          const res = await run("reset", {});
          if (!res) return;
          setSelectedId(null);
          setChosen([]);
          setLens("today");
        },
      };
    },
    [run, tasks, undo, revealLeftInbox]
  );

  const stats = React.useMemo(
    function () {
      return computeStats(tasks, today);
    },
    [tasks, today]
  );

  const counts = React.useMemo(
    function () {
      const map: Record<string, number> = { today: 0, next: 0, inbox: 0, once: 0 };
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        if (inView(t, "today", today)) map.today += 1;
        else if (inView(t, "next", today)) map.next += 1;
        else if (inView(t, "inbox", today)) map.inbox += 1;
        if (inOnceRange(t, today, onceRange)) map.once += 1;
      }
      return map;
    },
    [tasks, today, onceRange]
  );

  React.useEffect(
    function () {
      function onKey(e: KeyboardEvent) {
        const el = e.target as HTMLElement | null;
        const typing = Boolean(el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable));
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
          e.preventDefault();
          setPaletteOpen(function (v) {
            return !v;
          });
          return;
        }
        if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === "/") {
          e.preventDefault();
          if (archiveOpen) {
            const field = document.querySelector("[data-kedu=archive-search]") as HTMLInputElement | null;
            if (field) field.focus();
            return;
          }
          setSearchOpen(true);
          window.requestAnimationFrame(function () {
            if (searchRef.current) searchRef.current.focus();
          });
        } else if (e.key === "n" || e.key === "N") {
          e.preventDefault();
          if (addRef.current) addRef.current.focus();
        } else if (e.key === "Escape") {
          if (archiveOpen) {
            if (selectedId) {
              setSelectedId(null);
              return;
            }
            setArchiveOpenState(false);
            return;
          }
          if (searchOpen || query) {
            setSearchOpen(false);
            setQuery("");
            return;
          }
          if (rhythmOpen && layout === "narrow") {
            setRhythmOpen(false);
            return;
          }
          if (selectedId) {
            setSelectedId(null);
            return;
          }
          if (selectMode) setSelectMode(false);
        } else if (e.key === "1") setLens("today");
        else if (e.key === "2") setLens("next");
        else if (e.key === "3") setLens("inbox");
        else if (e.key === "4") {
          setLens("once");
          setDayFilter(null);
        } else if ((e.key === "d" || e.key === "D") && selectedId) {
          e.preventDefault();
          let hit: Task | null = null;
          for (let i = 0; i < tasks.length; i++) if (tasks[i].id === selectedId) hit = tasks[i];
          if (hit && !hit.done) void actions.patch(selectedId, { doing: !hit.doing });
        }
      }
      window.addEventListener("keydown", onKey);
      return function () {
        window.removeEventListener("keydown", onKey);
      };
    },
    [searchOpen, query, rhythmOpen, selectedId, selectMode, setSelectMode, layout, archiveOpen, tasks, actions]
  );

  const store: Store = React.useMemo(
    function () {
      return {
        tasks,
        tags,
        stats,
        today,
        lens,
        setLens,
        sort,
        chooseSort,
        followInbox,
        setFollowInbox,
        onceRange,
        setOnceRange,
        query,
        setQuery,
        searchOpen,
        setSearchOpen,
        tagFilter,
        setTagFilter,
        prioFilter,
        setPrioFilter,
        dayFilter,
        setDayFilter,
        hoverTag,
        setHoverTag,
        hoverPrio,
        setHoverPrio,
        selectedId,
        openTask: function (id: string | null) {
          setSelectedId(id);
          if (id) setRhythmOpen(false);
        },
        selectMode,
        setSelectMode,
        chosen,
        toggleSelect,
        clearSelection: function () {
          setChosen([]);
        },
        graceIds,
        rhythmOpen,
        setRhythmOpen: function (v: boolean) {
          setRhythmOpen(v);
          if (v) setSelectedId(null);
        },
        archiveOpen,
        setArchiveOpen: function (v: boolean) {
          setArchiveOpenState(v);
          if (!v) setSelectedId(null);
        },
        actions,
      };
    },
    [
      tasks,
      tags,
      stats,
      today,
      lens,
      sort,
      chooseSort,
      followInbox,
      setFollowInbox,
      onceRange,
      setOnceRange,
      query,
      searchOpen,
      tagFilter,
      prioFilter,
      dayFilter,
      hoverTag,
      hoverPrio,
      selectedId,
      selectMode,
      setSelectMode,
      chosen,
      toggleSelect,
      graceIds,
      rhythmOpen,
      archiveOpen,
      actions,
    ]
  );

  const load = stats.dueToday + stats.doneToday;
  const ratio = load === 0 ? 0 : stats.doneToday / load;
  const cleared = load > 0 && stats.dueToday === 0;
  const hasFilters = Boolean(query.trim() || tagFilter || prioFilter.length || dayFilter);
  let chosenActive = 0;
  let chosenDone = 0;
  for (let i = 0; i < chosen.length; i++) {
    for (let j = 0; j < tasks.length; j++) {
      if (tasks[j].id !== chosen[i]) continue;
      if (tasks[j].done) chosenDone += 1;
      else chosenActive += 1;
    }
  }

  function clearFilters() {
    setQuery("");
    setTagFilter(null);
    setPrioFilter([]);
    setDayFilter(null);
  }

  function scheduleChosen(due: string | null, title: string) {
    const n = chosen.length;
    void actions.bulkSchedule(chosen, due).then(function () {
      toast.add({ title: title, description: String(n) + " 件" });
    });
  }

  if (loading) {
    return (
      <div className="flex h-full items-center px-6 text-sm text-muted-foreground" data-kedu="app">
        正在打开今天…
      </div>
    );
  }

  if (loadError && tasks.length === 0) {
    return (
      <div className="flex h-full flex-col items-start justify-center gap-3 px-6" data-kedu="app">
        <p className="text-sm text-foreground">清单没有打开</p>
        <p className="text-xs text-muted-foreground">{loadError}</p>
        <Button
          size="sm"
          onClick={function () {
            window.location.reload();
          }}
        >
          重试
        </Button>
      </div>
    );
  }

  const desk = layout === "desk";
  /** Desk keeps a side list beside the page. It holds 之后, or 今天 while 之后 is the page. */
  // 曾经 is a look-back: desk side keeps 今天 so the live work surface stays visible.
  const sideLens: ViewId = lens === "once" || (desk && lens === "next") ? "today" : "next";
  const sideLabel = LENSES.find(function (item) { return item.id === sideLens; })?.label ?? "";
  const overlay = layout === "narrow" && Boolean(selectedId || rhythmOpen);
  // Instant — no holdPreview / collapseRail delay (those remounted panes and shoved narrow content right).
  const showPreview = layout === "desk";
  const dockRail = layout !== "narrow";
  const useSplit = layout !== "narrow";
  const splitKind: SplitKind = showPreview ? "desk" : "wide";
  const splitLayout = splitKind === "desk" ? deskSplit : wideSplit;

  // Approximate main width for select-bar column count (panel flex owns the real size).
  const columnW = useSplit
    ? Math.max(320, Math.round((frameWidth * (splitLayout.main || 50)) / 100))
    : Math.min(frameWidth, SINGLE_MAX);
  const selectCols = columnW >= 720 ? 4 : 2;

  function onSplitChanged(next: SplitLayout, meta: { isUserInteraction?: boolean; requestedLayout?: SplitLayout }) {
    if (!meta || !meta.isUserInteraction) return;
    const saved = clampSplitLayout(splitKind, meta.requestedLayout || next);
    if (splitKind === "desk") setDeskSplit(saved);
    else setWideSplit(saved);
    writeSplitLayout(splitKind, saved);
  }

  return (
    <StoreCtx.Provider value={store}>
      <Toaster position="bottom-right" timeout={3600} limit={3} />
      {overlay ? (
        <button
          type="button"
          data-kedu="scrim"
          aria-label="关闭侧栏"
          className="kedu-scrim"
          onClick={function () {
            setSelectedId(null);
            setRhythmOpen(false);
          }}
        />
      ) : null}
      <div
        ref={frameRef}
        data-kedu="app"
        data-layout={layout}
        data-split={useSplit ? "1" : "0"}
        data-preview={showPreview ? "1" : "0"}
        data-center={centered ? "1" : "0"}
        data-settle={settled ? "1" : "0"}
        className="kedu-stage relative flex h-full min-h-0 overflow-hidden bg-background text-foreground"
      >
        <StageShell
          useSplit={useSplit}
          showPreview={showPreview}
          dockRail={dockRail}
          splitKind={splitKind}
          splitLayout={splitLayout}
          onSplitChanged={onSplitChanged}
          preview={
            <section className="flex h-full min-h-0 w-full flex-col border-r border-border" data-kedu="preview">
              <div className="flex shrink-0 items-center gap-2 px-4 pb-3 pt-4">
                <h2 className="text-sm font-medium">{sideLabel}</h2>
                {counts[sideLens] ? <Mono className="text-muted-foreground">{counts[sideLens]}</Mono> : null}
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                <TaskList lens={sideLens} quiet />
              </div>
            </section>
          }
          rail={
            <aside className="flex h-full min-h-0 w-full flex-col" data-kedu="rail">
              <ContextRail closable={false} />
            </aside>
          }
          overlayRail={
            overlay ? (
              <aside className="flex h-full min-h-0 flex-col" data-kedu="rail" data-overlay="1">
                <ContextRail closable={true} />
              </aside>
            ) : null
          }
        >
        <div className="kedu-main relative flex h-full min-h-0 min-w-0 flex-col">
        <header className="shrink-0">
          <div className="flex items-center gap-3 px-4 pt-4">
            <h1 className="min-w-0 truncate text-base font-medium">{dayHeading(today)}</h1>
            <div role="group" aria-label="布局" data-kedu="layout" className="flex shrink-0 items-center">
              {([
                { id: "narrow" as LayoutMode, label: "单列", need: 0 },
                { id: "wide" as LayoutMode, label: "双列", need: WIDE_AT },
                { id: "desk" as LayoutMode, label: "三列", need: DESK_AT },
              ]).map(function (mode) {
                const on = layout === mode.id;
                const disabled = frameWidth < mode.need;
                return (
                  <button
                    key={mode.id}
                    type="button"
                    data-kedu="layout-mode"
                    data-layout-mode={mode.id}
                    aria-pressed={on}
                    aria-label={mode.label}
                    title={disabled ? "面板再宽一些才能用" + mode.label : mode.label}
                    disabled={disabled}
                    onClick={function () {
                      chooseLayout(mode.id);
                    }}
                    className={cn(
                      "relative grid size-6 place-items-center rounded-md transition-colors duration-300",
                      on ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                      disabled ? "opacity-30" : ""
                    )}
                  >
                    {on ? (
                      <motion.span
                        layoutId="kedu-layout-pill"
                        className="absolute inset-0 rounded-md bg-muted"
                        transition={reduceMotion ? { duration: 0 } : { duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
                      />
                    ) : null}
                    <span className="relative">
                      <LayoutGlyph cols={mode.id === "narrow" ? 1 : mode.id === "wide" ? 2 : 3} />
                    </span>
                  </button>
                );
              })}
            </div>
            <span className="flex-1" />
            {stats.overdue > 0 ? (
              <button
                type="button"
                onClick={function () {
                  setLens("today");
                }}
                className="font-mono text-[11px] text-destructive"
              >
                {"逾期 " + String(stats.overdue)}
              </button>
            ) : null}
            <button
              type="button"
              data-kedu="tick"
              aria-label={cleared ? "今天已清空，查看节奏" : "查看节奏"}
              title={stats.streak ? "连续 " + String(stats.streak) + " 天" : "查看节奏"}
              onClick={function () {
                setSelectedId(null);
                setRhythmOpen(layout === "narrow");
              }}
              className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-muted"
            >
              <TickBar ratio={ratio} celebrate={cleared} />
              <Mono className="text-muted-foreground">{load > 0 ? String(stats.doneToday) + "/" + String(load) : "—"}</Mono>
            </button>
          </div>

          <div className="mt-3 flex items-end gap-1 px-3">
            <div className="flex min-w-0 flex-1 items-end" role="tablist" aria-label="清单">
              {LENSES.map(function (item) {
                const on = lens === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    data-kedu="lens"
                    data-lens={item.id}
                    aria-selected={on}
                    onClick={function () {
                      setLens(item.id);
                      if (item.id === "once") setDayFilter(null);
                    }}
                    className={cn(
                      "relative flex items-baseline gap-1.5 px-2 pb-2 pt-1 text-sm",
                      on ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {item.label}
                    {counts[item.id] ? <Mono className="text-muted-foreground">{counts[item.id]}</Mono> : null}
                    {on ? <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-foreground" /> : null}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              data-kedu="select"
              aria-pressed={selectMode}
              aria-label={selectMode ? "退出多选" : "多选"}
              title={selectMode ? "退出多选" : "多选"}
              onClick={function () {
                setSelectMode(!selectMode);
              }}
              className={cn(
                "grid size-8 place-items-center rounded-md hover:bg-muted hover:text-foreground",
                selectMode ? "bg-muted text-foreground" : "text-muted-foreground"
              )}
            >
              <Icon.ListChecks size={15} strokeWidth={2} />
            </button>
            <button
              type="button"
              aria-label={searchOpen || query ? "收起搜索" : "搜索"}
              aria-pressed={searchOpen || Boolean(query)}
              onClick={function () {
                if (searchOpen || query) {
                  setSearchOpen(false);
                  setQuery("");
                  return;
                }
                setSearchOpen(true);
                window.requestAnimationFrame(function () {
                  if (searchRef.current) searchRef.current.focus();
                });
              }}
              className={cn(
                "grid size-8 place-items-center rounded-md hover:bg-muted hover:text-foreground",
                searchOpen || query ? "bg-muted text-foreground" : "text-muted-foreground"
              )}
            >
              <Icon.Search size={15} strokeWidth={2} />
            </button>
            <FilterButton />
            <button
              type="button"
              aria-label="命令"
              onClick={function () {
                setPaletteOpen(true);
              }}
              className="grid h-8 place-items-center rounded-md px-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Kbd>⌘K</Kbd>
            </button>
          </div>

          {lens === "once" ? <OnceRangeBar /> : null}

          <AnimatePresence initial={false}>
            {searchOpen || query ? (
              <motion.div
                key="kedu-search"
                initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={reduceMotion ? { height: "auto", opacity: 1, transition: { duration: 0 } } : { height: 0, opacity: 0 }}
                transition={reduceMotion ? { duration: 0 } : { duration: 0.34, ease: [0.16, 1, 0.3, 1] }}
                className="overflow-hidden"
              >
                <div className="flex items-center gap-2 px-4 py-2">
                  <Icon.Search size={13} className="shrink-0 text-muted-foreground" />
                  <input
                    ref={searchRef}
                    data-kedu="search"
                    value={query}
                    aria-label="搜索"
                    placeholder="标题、备注或标签"
                    onChange={function (e) {
                      setQuery(e.target.value);
                    }}
                    onKeyDown={function (e) {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setSearchOpen(false);
                        setQuery("");
                        e.currentTarget.blur();
                      }
                    }}
                    className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  />
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>

          {hasFilters ? (
            <div className="flex flex-wrap items-center gap-1.5 px-4 pt-3 pb-3">
              {prioFilter.map(function (p) {
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={function () {
                      setPrioFilter(
                        prioFilter.filter(function (x) {
                          return x !== p;
                        })
                      );
                    }}
                    className="rounded-full bg-muted px-2 py-0.5 text-xs"
                  >
                    {"P" + String(p) + " ×"}
                  </button>
                );
              })}
              {dayFilter ? (
                <button
                  type="button"
                  onClick={function () {
                    setDayFilter(null);
                  }}
                  className="rounded-full bg-muted px-2 py-0.5 text-xs"
                >
                  {dayHeading(dayFilter).split(" · ")[0] + " ×"}
                </button>
              ) : null}
              {tagFilter ? (
                <button
                  type="button"
                  onClick={function () {
                    setTagFilter(null);
                  }}
                  className="rounded-full bg-muted px-2 py-0.5 text-xs"
                >
                  {"#" + tagFilter + " ×"}
                </button>
              ) : null}
              {query.trim() ? (
                <button
                  type="button"
                  onClick={function () {
                    setQuery("");
                  }}
                  className="rounded-full bg-muted px-2 py-0.5 text-xs"
                >
                  {"“" + query.trim() + "” ×"}
                </button>
              ) : null}
              <button type="button" onClick={clearFilters} className="text-xs text-muted-foreground hover:text-foreground">
                清除
              </button>
            </div>
          ) : null}
          <div className="h-px bg-border" />
        </header>

        <div ref={scroller} className={"min-h-0 flex-1 overflow-auto" + (!selectMode ? " pb-32" : "")}>
          {lens === "once" ? (
            <OnceList onClearFilters={clearFilters} />
          ) : (
            <TaskList lens={desk ? lens : undefined} onClearFilters={clearFilters} />
          )}
        </div>

        {selectMode ? (
          <div data-kedu="select-bar" className="shrink-0 px-8 pb-6 pt-3">
            <motion.div
              className="kedu-select-dock px-6 pb-6 pt-6"
              initial={reduceMotion ? false : { y: 18, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={reduceMotion ? { duration: 0 } : { duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className="flex items-end justify-between gap-4">
                <div className="min-w-0">
                  <p data-kedu="select-count" className="text-[1.75rem] font-medium leading-none">
                    {chosen.length ? "已选 " + String(chosen.length) : "还没选"}
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {lens === "once"
                      ? chosen.length
                        ? "恢复回清单，或删除"
                        : "点一行就选上"
                      : chosen.length
                        ? "一起完成、改期，或放回收集"
                        : "点一行就选上"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-4 pb-0.5">
                  <button
                    type="button"
                    disabled={!chosen.length}
                    onClick={function () { setConfirmBulk(true); }}
                    className="text-sm text-destructive disabled:opacity-30"
                  >
                    删除
                  </button>
                  <button
                    type="button"
                    onClick={function () { setSelectMode(false); }}
                    className="text-sm text-muted-foreground hover:text-foreground"
                  >
                    取消
                  </button>
                </div>
              </div>
              {lens === "once" ? (
                <div className="mt-6 grid grid-cols-1 gap-3">
                  <button
                    type="button"
                    disabled={!chosen.length}
                    onClick={function () { void actions.bulk(chosen, "active"); }}
                    className="flex h-16 items-center justify-center gap-2 rounded-2xl bg-foreground px-3 text-base text-background disabled:opacity-30"
                  >
                    <Icon.RotateCcw size={18} strokeWidth={2} />
                    恢复
                  </button>
                </div>
              ) : (
                <>
                  <div className={"mt-6 grid gap-3 " + (selectCols === 4 ? "grid-cols-4" : "grid-cols-2")}>
                    <button
                      type="button"
                      disabled={!chosenActive}
                      onClick={function () { void actions.bulk(chosen, "done"); }}
                      className="flex h-16 items-center justify-center gap-2 rounded-2xl bg-foreground px-3 text-base text-background disabled:opacity-30"
                    >
                      <Icon.Check size={18} strokeWidth={2} />
                      标为完成
                    </button>
                    {chosenDone ? (
                      <button
                        type="button"
                        onClick={function () { void actions.bulk(chosen, "active"); }}
                        className="flex h-16 items-center justify-center gap-2 rounded-2xl border kedu-edge px-3 text-base text-foreground"
                      >
                        <Icon.RotateCcw size={18} strokeWidth={2} />
                        恢复
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={!chosen.length}
                        onClick={function () { scheduleChosen(today, "已改到今天"); }}
                        className="flex h-16 items-center justify-center gap-2 rounded-2xl border kedu-edge px-3 text-base text-foreground disabled:opacity-30"
                      >
                        <Icon.Sun size={18} strokeWidth={2} />
                        改到今天
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={!chosen.length}
                      onClick={function () { scheduleChosen(shiftKey(today, 1), "已改到明天"); }}
                      className="flex h-16 items-center justify-center gap-2 rounded-2xl border kedu-edge px-3 text-base text-foreground disabled:opacity-30"
                    >
                      <Icon.Sunrise size={18} strokeWidth={2} />
                      改到明天
                    </button>
                    <button
                      type="button"
                      disabled={!chosen.length}
                      onClick={function () { scheduleChosen(null, "已放回收集"); }}
                      className="flex h-16 items-center justify-center gap-2 rounded-2xl border kedu-edge px-3 text-base text-foreground disabled:opacity-30"
                    >
                      <Icon.Inbox size={18} strokeWidth={2} />
                      放回收集
                    </button>
                  </div>
                  {chosenDone ? (
                    <button
                      type="button"
                      disabled={!chosen.length}
                      onClick={function () { scheduleChosen(today, "已改到今天"); }}
                      className="mt-3 flex h-16 w-full items-center justify-center gap-2 rounded-2xl border kedu-edge px-3 text-base text-foreground disabled:opacity-30"
                    >
                      <Icon.Sun size={18} strokeWidth={2} />
                      改到今天
                    </button>
                  ) : null}
                </>
              )}
            </motion.div>
          </div>
        ) : null}

        {undo ? (
          <div className="flex shrink-0 items-center gap-3 border-t border-border px-4 py-2">
            <span className="min-w-0 flex-1 truncate text-sm">{"已删除「" + undo.title + "」"}</span>
            <Button size="sm" variant="outline" onClick={function () { void actions.undoRemove(); }}>
              撤销
            </Button>
          </div>
        ) : null}
        {!selectMode ? <Capture inputRef={addRef} dock /> : null}
        </div>
        </StageShell>

        <AnimatePresence>
          {archiveOpen ? <Archive key="archive" detailSide={frameWidth >= WIDE_AT} /> : null}
        </AnimatePresence>
      </div>

      <Commands
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onFocusAdd={function () {
          setPaletteOpen(false);
          window.requestAnimationFrame(function () {
            if (addRef.current) addRef.current.focus();
          });
        }}
        onFocusSearch={function () {
          setPaletteOpen(false);
          setSearchOpen(true);
          window.requestAnimationFrame(function () {
            if (searchRef.current) searchRef.current.focus();
          });
        }}
        onClearDone={function () {
          setPaletteOpen(false);
          setConfirmClear(true);
        }}
        onReset={function () {
          setPaletteOpen(false);
          setConfirmReset(true);
        }}
      />
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="清空已完成？"
        description="完成的记录会从这台机器上删掉。"
        confirmLabel="清空"
        onConfirm={function () {
          setConfirmClear(false);
          void actions.clearDone();
        }}
      />
      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="恢复示例？"
        description="当前清单会被示例替换。"
        confirmLabel="恢复"
        onConfirm={function () {
          setConfirmReset(false);
          void actions.reset();
        }}
      />
      <ConfirmDialog
        open={confirmBulk}
        onOpenChange={setConfirmBulk}
        title={"删除 " + String(chosen.length) + " 件？"}
        description="批量删除不能撤销。"
        confirmLabel="删除"
        onConfirm={function () {
          setConfirmBulk(false);
          void actions.bulk(chosen, "remove");
        }}
      />
    </StoreCtx.Provider>
  );
}
