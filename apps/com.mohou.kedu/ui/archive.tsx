import * as React from "react";
import { motion } from "motion/react";
import { Icon, cn } from "@mohou/ui";

import { dateKey, dayHeading, fmtShort, inView, scheduleOf, shiftKey, weekSpan } from "../shared/model";
import type { Task } from "../shared/types";
import { DueText, Mono } from "./atoms";
import { TaskDetail } from "./detail";
import { useStore } from "./store";

const EASE = [0.16, 1, 0.3, 1] as const;

function doneKey(task: Task): string | null {
  if (!task.done || task.completedAt === null) return null;
  return dateKey(new Date(task.completedAt));
}

function inSpan(key: string, start: string, end: string): boolean {
  return key >= start && key <= end;
}

function overlaps(task: Task, start: string, end: string): boolean {
  const a = task.starts || task.due;
  const b = task.due || task.starts;
  if (!a || !b) return false;
  return a <= end && b >= start;
}

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

export function Archive(props: { detailSide: boolean }) {
  const { tasks, today, selectedId, openTask, setArchiveOpen } = useStore();
  const reduce = useReducedMotion();
  const [query, setQuery] = React.useState("");
  const [tag, setTag] = React.useState<string | null>(null);
  const [weekStart, setWeekStart] = React.useState<string | null>(null);
  const searchRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(function () {
    const frame = window.requestAnimationFrame(function () {
      if (searchRef.current) searchRef.current.focus();
    });
    return function () {
      window.cancelAnimationFrame(frame);
    };
  }, []);

  const q = query.trim().toLowerCase();
  const monday = weekSpan(today, "this").starts;

  const open = tasks.filter(function (t) {
    return !t.done;
  });
  const finished = tasks.filter(function (t) {
    return t.done;
  });

  const weeks: { start: string; end: string; count: number }[] = [];
  for (let i = 7; i >= 0; i--) {
    const start = shiftKey(monday, -7 * i);
    const end = shiftKey(start, 6);
    let count = 0;
    for (let j = 0; j < finished.length; j++) {
      const key = doneKey(finished[j]);
      if (key && inSpan(key, start, end)) count += 1;
    }
    weeks.push({ start: start, end: end, count: count });
  }
  let weekMax = 1;
  for (let i = 0; i < weeks.length; i++) weekMax = Math.max(weekMax, weeks[i].count);

  const tagCounts: { name: string; count: number }[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const names = tasks[i].tags;
    for (let j = 0; j < names.length; j++) {
      let found = false;
      for (let k = 0; k < tagCounts.length; k++) {
        if (tagCounts[k].name === names[j]) {
          tagCounts[k].count += 1;
          found = true;
        }
      }
      if (!found) tagCounts.push({ name: names[j], count: 1 });
    }
  }

  function matches(task: Task): boolean {
    if (tag && task.tags.indexOf(tag) < 0) return false;
    if (!q) return true;
    const blob = (task.title + " " + task.notes + " " + task.tags.join(" ")).toLowerCase();
    return blob.indexOf(q) >= 0;
  }

  function inWeek(task: Task): boolean {
    if (!weekStart) return true;
    const end = shiftKey(weekStart, 6);
    if (task.done) {
      const key = doneKey(task);
      return key !== null && inSpan(key, weekStart, end);
    }
    return overlaps(task, weekStart, end);
  }

  const shownDone = finished.filter(function (t) {
    return matches(t) && inWeek(t);
  });
  shownDone.sort(function (a, b) {
    const av = a.completedAt === null ? -1 : a.completedAt;
    const bv = b.completedAt === null ? -1 : b.completedAt;
    return bv - av;
  });

  const bands = (
    [
      { id: "today", title: "今天" },
      { id: "next", title: "之后" },
      { id: "inbox", title: "收集" },
    ] as const
  )
    .map(function (band) {
      const list = open.filter(function (t) {
        if (!matches(t) || !inWeek(t)) return false;
        return inView(t, band.id, today);
      });
      list.sort(function (a, b) {
        return a.order - b.order;
      });
      return { id: band.id, title: band.title, tasks: list };
    })
    .filter(function (band) {
      return band.tasks.length > 0;
    });

  const groups: { key: string; tasks: Task[] }[] = [];
  for (let i = 0; i < shownDone.length; i++) {
    const key = doneKey(shownDone[i]) || "none";
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.tasks.push(shownDone[i]);
    else groups.push({ key: key, tasks: [shownDone[i]] });
  }

  const weekLabel = weekStart ? fmtShort(weekStart) + "–" + fmtShort(shiftKey(weekStart, 6)) : "";

  function groupTitle(key: string): string {
    if (key === "none") return "没有记下完成日";
    const head = dayHeading(key);
    if (key.slice(0, 4) !== today.slice(0, 4)) return key.slice(0, 4) + "年 · " + head;
    return head;
  }

  return (
    <motion.div
      data-kedu="archive"
      initial={reduce ? false : { opacity: 0, y: 56 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? { opacity: 1, y: 0, transition: { duration: 0 } } : { opacity: 0, y: 36 }}
      transition={reduce ? { duration: 0 } : { duration: 0.58, ease: EASE }}
      className="absolute inset-0 z-50 flex bg-background"
    >
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-[40rem] px-6 pb-16 pt-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-[1.75rem] font-medium leading-none">总览</h2>
              <p className="mt-2 text-sm text-muted-foreground">全部任务。进行中在上面，做过的按日子留在下面</p>
            </div>
            <button
              type="button"
              aria-label="关闭总览"
              onClick={function () {
                setArchiveOpen(false);
              }}
              className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Icon.X size={16} />
            </button>
          </div>

          <div className="kedu-edge mt-6 flex items-center gap-3 rounded-2xl border px-4">
            <Icon.Search size={16} className="shrink-0 text-muted-foreground" />
            <input
              ref={searchRef}
              data-kedu="archive-search"
              value={query}
              aria-label="搜索全部任务"
              placeholder="标题、备注或标签"
              onChange={function (e) {
                setQuery(e.target.value);
              }}
              onKeyDown={function (e) {
                if (e.key !== "Escape") return;
                e.preventDefault();
                e.stopPropagation();
                if (query) setQuery("");
                else setArchiveOpen(false);
              }}
              className="h-12 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
            />
          </div>

          <div className="mt-6 grid grid-cols-3 gap-6">
            <Stat label="进行中" value={open.length} />
            <Stat label="已完成" value={finished.length} />
            <Stat label="一共" value={tasks.length} />
          </div>

          <div className="mt-6">
            <p className="text-[11px] tracking-wide text-muted-foreground">近 8 周完成</p>
            <div className="mt-2 flex items-end gap-1.5">
              {weeks.map(function (w, i) {
                const on = weekStart === w.start;
                const h = w.count === 0 ? 3 : Math.max(8, Math.round((w.count / weekMax) * 28));
                const current = i === weeks.length - 1;
                return (
                  <button
                    key={w.start}
                    type="button"
                    data-kedu="archive-week"
                    data-start={w.start}
                    aria-pressed={on}
                    aria-label={fmtShort(w.start) + " 至 " + fmtShort(w.end) + " 完成 " + String(w.count)}
                    onClick={function () {
                      setWeekStart(on ? null : w.start);
                    }}
                    className="flex min-w-0 flex-1 flex-col items-center gap-1 rounded-sm py-1 hover:bg-muted"
                  >
                    <span className="flex h-7 items-end">
                      <span
                        style={{
                          width: 8,
                          height: h,
                          borderRadius: 2,
                          backgroundColor: on || current ? "var(--foreground)" : "color-mix(in oklab, var(--foreground) 40%, transparent)",
                        }}
                      />
                    </span>
                    <Mono className={on || current ? "text-foreground" : "text-muted-foreground"}>{Number(w.start.slice(8))}</Mono>
                  </button>
                );
              })}
            </div>
          </div>

          {tagCounts.length ? (
            <div className="mt-5 flex flex-wrap gap-1.5">
              {tagCounts.map(function (item) {
                const on = tag === item.name;
                return (
                  <button
                    key={item.name}
                    type="button"
                    aria-pressed={on}
                    onClick={function () {
                      setTag(on ? null : item.name);
                    }}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-xs",
                      on ? "border-foreground bg-foreground text-background" : "kedu-edge text-foreground"
                    )}
                  >
                    {"#" + item.name}
                    <span className={on ? "ml-1" : "ml-1 text-muted-foreground"}>{item.count}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {weekStart || tag ? (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {weekStart ? (
                <button
                  type="button"
                  onClick={function () {
                    setWeekStart(null);
                  }}
                  className="rounded-full bg-muted px-2 py-0.5 text-xs"
                >
                  {weekLabel + " ×"}
                </button>
              ) : null}
              {tag ? (
                <button
                  type="button"
                  onClick={function () {
                    setTag(null);
                  }}
                  className="rounded-full bg-muted px-2 py-0.5 text-xs"
                >
                  {"#" + tag + " ×"}
                </button>
              ) : null}
            </div>
          ) : null}

          {bands.length ? (
            <div className="mt-6">
              {bands.map(function (band) {
                return (
                  <section key={band.id}>
                    <div className="sticky top-0 flex items-baseline gap-2 bg-background pb-1 pt-4">
                      <span className="text-xs text-muted-foreground">{band.title}</span>
                      <Mono className="text-muted-foreground">{band.tasks.length}</Mono>
                    </div>
                    <ul>
                      {band.tasks.map(function (t) {
                        return <ArchiveRow key={t.id} task={t} query={q} />;
                      })}
                    </ul>
                  </section>
                );
              })}
            </div>
          ) : null}

          {groups.length ? (
            <div className={bands.length ? "mt-8" : "mt-6"}>
              <div className="flex items-baseline gap-2 border-t border-border pt-5">
                <span className="text-xs text-muted-foreground">已完成</span>
                <Mono className="text-muted-foreground">{shownDone.length}</Mono>
              </div>
              {groups.map(function (group) {
                return (
                  <section key={group.key}>
                    <div className="sticky top-0 flex items-baseline gap-2 bg-background pb-1 pt-4">
                      <span className="text-xs text-muted-foreground">{groupTitle(group.key)}</span>
                      <Mono className="text-muted-foreground">{group.tasks.length}</Mono>
                    </div>
                    <ul>
                      {group.tasks.map(function (t) {
                        return <ArchiveRow key={t.id} task={t} query={q} />;
                      })}
                    </ul>
                  </section>
                );
              })}
            </div>
          ) : bands.length && !q && !weekStart && !tag ? (
            <p className="mt-8 border-t border-border pt-5 text-sm text-muted-foreground">还没有完成过</p>
          ) : !bands.length && (q || weekStart || tag) ? (
            <p className="mt-10 text-sm text-muted-foreground">没有找到</p>
          ) : !bands.length ? (
            <p className="mt-10 text-sm text-muted-foreground">清单是空的</p>
          ) : null}
        </div>
      </div>

      {selectedId && props.detailSide ? (
        <div className="h-full w-[400px] shrink-0 border-l border-border">
          <TaskDetail />
        </div>
      ) : null}
      {selectedId && !props.detailSide ? (
        <div className="absolute inset-0 z-10 bg-background">
          <TaskDetail />
        </div>
      ) : null}
    </motion.div>
  );
}

function Stat(props: { label: string; value: number }) {
  return (
    <div>
      <p className="text-[11px] tracking-wide text-muted-foreground">{props.label}</p>
      <p className="mt-1 text-[1.75rem] font-medium tabular-nums leading-none">{props.value}</p>
    </div>
  );
}

function ArchiveRow(props: { task: Task; query: string }) {
  const { today, openTask } = useStore();
  const t = props.task;
  const notesHit = Boolean(props.query) && t.notes.toLowerCase().indexOf(props.query) >= 0 && t.title.toLowerCase().indexOf(props.query) < 0;
  return (
    <li className="list-none border-b border-border">
      <button
        type="button"
        data-kedu="archive-row"
        data-id={t.id}
        onClick={function () {
          openTask(t.id);
        }}
        className="flex w-full items-baseline gap-3 rounded-md px-1 py-2.5 text-left hover:bg-muted"
      >
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-sm", t.done ? "text-muted-foreground line-through" : "")}>{t.title}</span>
          {notesHit ? <span className="mt-0.5 block truncate text-xs text-muted-foreground">{t.notes}</span> : null}
        </span>
        {t.done ? (
          t.tags.length ? <span className="shrink-0 text-xs text-muted-foreground">{t.tags.map(function (name) { return "#" + name; }).join(" ")}</span> : null
        ) : (
          <DueText meta={scheduleOf(t, today)} />
        )}
      </button>
    </li>
  );
}
