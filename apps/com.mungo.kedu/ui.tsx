import * as React from "react";
import { motion } from "motion/react";
import { Button, ConfirmDialog, Icon, Kbd, Toaster, toast, useApp, cn } from "@mohou/ui";

import { computeStats, dayHeading, inView, todayKey } from "./shared/model";
import type { Pack, Priority, SortId, Task, ViewId } from "./shared/types";
import { Mono, TickBar } from "./ui/atoms";
import { Capture } from "./ui/capture";
import { Commands } from "./ui/commands";
import { FilterButton } from "./ui/filter";
import { TaskList } from "./ui/list";
import { ContextRail } from "./ui/rail";
import { StoreCtx } from "./ui/store";
import type { Actions, Store } from "./ui/store";

const GRACE_MS = 5000;
const WIDE_AT = 960;
const DESK_AT = 1280;
const SINGLE_MAX = 720;
const SLIDE_MS = 580;
const LAYOUT_KEY = "kedu-layout";

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

function beside(lens: ViewId): ViewId {
  return lens === "today" ? "next" : "today";
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
  const [sort, setSort] = React.useState<SortId>("manual");
  const [query, setQuery] = React.useState("");
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [tagFilter, setTagFilter] = React.useState<string | null>(null);
  const [prioFilter, setPrioFilter] = React.useState<Priority[]>([]);
  const [hoverTag, setHoverTag] = React.useState<string | null>(null);
  const [hoverPrio, setHoverPrio] = React.useState<Priority | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [selectMode, setSelectModeState] = React.useState(false);
  const [chosen, setChosen] = React.useState<string[]>([]);
  const [graceIds, setGraceIds] = React.useState<string[]>([]);
  const [undo, setUndo] = React.useState<Task | null>(null);
  const [rhythmOpen, setRhythmOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [confirmClear, setConfirmClear] = React.useState(false);
  const [confirmReset, setConfirmReset] = React.useState(false);
  const [confirmBulk, setConfirmBulk] = React.useState(false);
  const [today, setToday] = React.useState(todayKey());

  const addRef = React.useRef<HTMLInputElement | null>(null);
  const searchRef = React.useRef<HTMLInputElement | null>(null);
  const scroller = React.useRef<HTMLDivElement | null>(null);
  const frameRef = React.useRef<HTMLDivElement | null>(null);
  const [frameWidth, setFrameWidth] = React.useState(readWidth);
  const [settled, setSettled] = React.useState(false);
  const [reduceMotion, setReduceMotion] = React.useState(false);
  const [pinned, setPinned] = React.useState<LayoutMode | null>(readPinned);
  const [holdPreview, setHoldPreview] = React.useState(function () {
    return resolveLayout(readPinned(), readWidth()) === "desk";
  });
  const [collapseRail, setCollapseRail] = React.useState(false);
  const settledRef = React.useRef(false);
  const selectedRef = React.useRef<string | null>(null);
  const rhythmRef = React.useRef(false);
  settledRef.current = settled;
  selectedRef.current = selectedId;
  rhythmRef.current = rhythmOpen;
  const layout = resolveLayout(pinned, frameWidth);
  const centered = layout === "narrow" && frameWidth > SINGLE_MAX;

  function chooseLayout(next: LayoutMode) {
    setPinned(next);
    try {
      window.localStorage.setItem(LAYOUT_KEY, next);
    } catch (e) {
      /* the choice still applies for this visit */
    }
  }

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

  React.useEffect(
    function () {
      if (layout === "desk") {
        setHoldPreview(true);
        return;
      }
      if (!settledRef.current) {
        setHoldPreview(false);
        return;
      }
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const timer = window.setTimeout(function () {
        setHoldPreview(false);
      }, reduce ? 0 : SLIDE_MS);
      return function () {
        window.clearTimeout(timer);
      };
    },
    [layout]
  );

  React.useEffect(
    function () {
      if (layout !== "narrow") {
        setCollapseRail(false);
        return;
      }
      if (!settledRef.current || selectedRef.current || rhythmRef.current) {
        setCollapseRail(false);
        return;
      }
      setCollapseRail(true);
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const timer = window.setTimeout(function () {
        setCollapseRail(false);
      }, reduce ? 0 : SLIDE_MS);
      return function () {
        window.clearTimeout(timer);
      };
    },
    [layout]
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

  const actions: Actions = React.useMemo(
    function () {
      return {
        add: async function (raw: string) {
          const before: Record<string, boolean> = {};
          for (let i = 0; i < tasks.length; i++) before[tasks[i].id] = true;
          const res = await run("add", { title: raw });
          if (!isPack(res)) return null;
          const fresh = res.tasks.find(function (t) {
            return !before[t.id];
          });
          return fresh ? fresh.id : null;
        },
        toggle: async function (id: string) {
          let wasDone = false;
          for (let i = 0; i < tasks.length; i++) if (tasks[i].id === id) wasDone = tasks[i].done;
          const res = await run("toggle", { id });
          if (!res) return;
          if (wasDone) {
            setGraceIds(function (prev) {
              return prev.filter(function (x) {
                return x !== id;
              });
            });
            return;
          }
          setGraceIds(function (prev) {
            return prev.indexOf(id) >= 0 ? prev : prev.concat([id]);
          });
          window.setTimeout(function () {
            setGraceIds(function (prev) {
              return prev.filter(function (x) {
                return x !== id;
              });
            });
          }, GRACE_MS);
        },
        patch: async function (id: string, patch: Record<string, unknown>) {
          await run("update", { id, patch });
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
        bulk: async function (ids: string[], action: "done" | "active" | "remove") {
          const res = await run("bulk", { ids, action });
          setChosen([]);
          if (!res) return;
          if (action === "remove") {
            setSelectedId(function (prev) {
              return prev && ids.indexOf(prev) >= 0 ? null : prev;
            });
          }
          if (action === "active") {
            setGraceIds(function (prev) {
              return prev.filter(function (x) {
                return ids.indexOf(x) < 0;
              });
            });
            return;
          }
          if (action === "done") {
            setGraceIds(function (prev) {
              return prev.concat(
                ids.filter(function (x) {
                  return prev.indexOf(x) < 0;
                })
              );
            });
            window.setTimeout(function () {
              setGraceIds(function (prev) {
                return prev.filter(function (x) {
                  return ids.indexOf(x) < 0;
                });
              });
            }, GRACE_MS);
          }
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
    [run, tasks, undo]
  );

  const stats = React.useMemo(
    function () {
      return computeStats(tasks, today);
    },
    [tasks, today]
  );

  const counts = React.useMemo(
    function () {
      const map: Record<string, number> = { today: 0, next: 0, inbox: 0 };
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        if (inView(t, "today", today)) map.today += 1;
        else if (inView(t, "next", today)) map.next += 1;
        else if (inView(t, "inbox", today)) map.inbox += 1;
      }
      return map;
    },
    [tasks, today]
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
          setSearchOpen(true);
          window.requestAnimationFrame(function () {
            if (searchRef.current) searchRef.current.focus();
          });
        } else if (e.key === "n" || e.key === "N") {
          e.preventDefault();
          if (addRef.current) addRef.current.focus();
        } else if (e.key === "Escape") {
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
      }
      window.addEventListener("keydown", onKey);
      return function () {
        window.removeEventListener("keydown", onKey);
      };
    },
    [searchOpen, query, rhythmOpen, selectedId, selectMode, setSelectMode, layout]
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
        setSort,
        query,
        setQuery,
        searchOpen,
        setSearchOpen,
        tagFilter,
        setTagFilter,
        prioFilter,
        setPrioFilter,
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
      query,
      searchOpen,
      tagFilter,
      prioFilter,
      hoverTag,
      hoverPrio,
      selectedId,
      selectMode,
      setSelectMode,
      chosen,
      toggleSelect,
      graceIds,
      rhythmOpen,
      actions,
    ]
  );

  const load = stats.dueToday + stats.doneToday;
  const ratio = load === 0 ? 0 : stats.doneToday / load;
  const cleared = load > 0 && stats.dueToday === 0;
  const hasFilters = Boolean(query.trim() || tagFilter || prioFilter.length);
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

  const companion = beside(lens);
  const companionLabel = companion === "next" ? "之后" : "今天";
  const overlay = layout === "narrow" && Boolean(selectedId || rhythmOpen);
  const showPreview = layout === "desk" || holdPreview;
  const showRail = layout !== "narrow" || overlay || collapseRail;

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
        data-center={centered ? "1" : "0"}
        data-settle={settled ? "1" : "0"}
        className="kedu-stage flex h-full min-h-0 overflow-hidden bg-background text-foreground"
      >
        <div className="kedu-main flex min-h-0 min-w-0 flex-col">
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

          <Capture inputRef={addRef} />

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

          {searchOpen || query ? (
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
          ) : null}

          {hasFilters ? (
            <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2">
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

        <div ref={scroller} className="min-h-0 flex-1 overflow-auto">
          <TaskList onClearFilters={clearFilters} />
        </div>

        {selectMode ? (
          <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2">
            <span className="min-w-0 flex-1 text-sm">已选 {chosen.length}</span>
            {chosenActive ? (
              <Button size="sm" variant="outline" onClick={function () { void actions.bulk(chosen, "done"); }}>
                完成
              </Button>
            ) : null}
            {chosenDone ? (
              <Button size="sm" variant="outline" onClick={function () { void actions.bulk(chosen, "active"); }}>
                恢复
              </Button>
            ) : null}
            <Button size="sm" variant="destructive" disabled={!chosen.length} onClick={function () { setConfirmBulk(true); }}>
              删除
            </Button>
            <Button size="sm" variant="ghost" onClick={function () { setSelectMode(false); }}>
              取消
            </Button>
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
        </div>

        <section className="kedu-preview flex justify-end" data-kedu="preview" aria-hidden={layout === "desk" ? undefined : true}>
          {showPreview ? (
            <div className="flex h-full min-w-[360px] w-full flex-col border-l border-border">
              <div className="flex shrink-0 items-center gap-2 px-4 pb-3 pt-4">
                <h2 className="text-sm font-medium">{companionLabel}</h2>
                {counts[companion] ? <Mono className="text-muted-foreground">{counts[companion]}</Mono> : null}
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={function () {
                    setLens(companion);
                  }}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  换过来
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                <TaskList lens={companion} quiet />
              </div>
            </div>
          ) : null}
        </section>

        <aside className="kedu-rail" data-kedu="rail" data-overlay={overlay ? "1" : "0"}>
          {showRail ? <ContextRail closable={overlay} /> : null}
        </aside>
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
