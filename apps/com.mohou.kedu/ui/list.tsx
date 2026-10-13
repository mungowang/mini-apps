import * as React from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle, Icon, IlluEmpty, IlluSearch, cn } from "@mohou/ui";

import type { GroupId } from "../shared/model";
import { GROUP_TITLE, completedOn, dayHeading, groupOf, inView, overdueTier, relativeTime, scheduleOf, shiftKey, sortTasks, weekendKey } from "../shared/model";
import type { Priority, Task, ViewId } from "../shared/types";
import { DueText, Mono, PriorityMark, SubtaskTicks, TaskCheck } from "./atoms";
import { useStore } from "./store";

const TINT = [
  "",
  "color-mix(in oklab, var(--destructive) 8%, transparent)",
  "color-mix(in oklab, var(--destructive) 14%, transparent)",
  "color-mix(in oklab, var(--destructive) 22%, transparent)",
];

export const GRACE_MS = 5000;

const SUB_EASE = [0.22, 1, 0.36, 1] as const;

function nextPriority(p: Priority): Priority {
  return ((p % 4) + 1) as Priority;
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

/** The row title. A clipped title peeks its hidden text to the right on hover. */
function RowTitle(props: { task: Task; onOpen: () => void }) {
  const t = props.task;
  const ref = React.useRef<HTMLButtonElement | null>(null);
  const [clipped, setClipped] = React.useState(false);

  React.useLayoutEffect(
    function () {
      const el = ref.current;
      if (!el) return;
      const check = function () {
        setClipped(el.scrollWidth > el.clientWidth + 1);
      };
      check();
      const ro = new ResizeObserver(check);
      ro.observe(el);
      return function () {
        ro.disconnect();
      };
    },
    [t.title, clipped]
  );

  const tone = t.done ? "text-muted-foreground line-through" : "text-foreground";

  return (
    <span className="relative min-w-0">
      <button ref={ref} type="button" onClick={props.onOpen} className={cn("block w-full truncate text-left text-sm", tone)}>
        {t.title}
      </button>
      {clipped ? (
        <span aria-hidden className={cn("kedu-title-peek text-sm", tone)}>
          {t.title}
        </span>
      ) : null}
    </span>
  );
}

function Row(props: {
  task: Task;
  face: ViewId;
  quiet: boolean;
  draggable: boolean;
  dragging: boolean;
  drop: boolean;
  inGrace: boolean;
  onGripDown: (e: React.PointerEvent<HTMLSpanElement>) => void;
}) {
  const { openTask, actions, selectedId, selectMode, chosen, toggleSelect, hoverTag, hoverPrio, today } = useStore();
  const t = props.task;
  const meta = scheduleOf(t, today);
  const [openSubs, setOpenSubs] = React.useState(false);
  const reduceMotion = useReducedMotion();
  let subDone = 0;
  for (let i = 0; i < t.subtasks.length; i++) if (t.subtasks[i].done) subDone += 1;
  const tier = t.done ? 0 : overdueTier(meta, t.priority);
  const faded = Boolean((hoverTag && t.tags.indexOf(hoverTag) < 0) || (hoverPrio !== null && t.priority !== hoverPrio));
  const picked = selectMode && chosen.indexOf(t.id) >= 0;
  const selected = !selectMode && selectedId === t.id;

  function open() {
    if (selectMode) toggleSelect(t.id);
    else openTask(t.id);
  }

  const quick = [
    { label: "今天", due: today },
    { label: "明天", due: shiftKey(today, 1) },
    { label: "周末", due: weekendKey(today) },
  ];

  const rowBg = picked || selected ? "var(--muted)" : TINT[tier] || undefined;
  const rowStyle = { backgroundColor: rowBg } as React.CSSProperties;
  if (rowBg) (rowStyle as Record<string, string>)["--kedu-row-bg"] = rowBg;

  return (
    <motion.li
      layout={!props.quiet && !reduceMotion}
      layoutId={props.quiet ? undefined : "kedu-task-" + t.id}
      transition={reduceMotion ? { duration: 0 } : { layout: { duration: 0.38, ease: SUB_EASE } }}
      data-kedu={props.quiet ? "preview-row" : "row"}
      data-id={t.id}
      data-chosen={picked ? "1" : "0"}
      onClick={open}
      className={cn("relative cursor-pointer list-none border-b border-border", faded ? "opacity-40" : "", props.dragging ? "opacity-50" : "")}
      style={rowStyle}
    >
      {selectMode ? (
        <span className="kedu-chosen-bar absolute inset-y-0 left-0 w-0.5 bg-foreground" data-on={picked ? "1" : "0"} />
      ) : null}
      {props.drop ? <span className="absolute inset-x-0 top-0 h-px bg-foreground" /> : null}
      {/*
        Title line is its own items-center row so check/priority stay level with the title.
        Expanded subtasks hang below with lead padding — they never stretch the icon column.
      */}
      <div className="px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          {props.draggable ? (
            <span
              aria-label="拖动排序"
              onPointerDown={props.onGripDown}
              onClick={function (e) {
                e.stopPropagation();
              }}
              className="kedu-grip grid size-4 shrink-0 place-items-center cursor-grab text-muted-foreground active:cursor-grabbing"
            >
              <Icon.GripVertical size={14} strokeWidth={2} />
            </span>
          ) : null}

          {selectMode ? (
            <button
              type="button"
              role="checkbox"
              data-kedu="pick"
              data-on={picked ? "1" : "0"}
              aria-checked={picked}
              aria-label={"选择 " + t.title}
              onClick={function (e) {
                e.stopPropagation();
                toggleSelect(t.id);
              }}
              className="kedu-pick"
            >
              <Icon.Check size={12} strokeWidth={2.6} />
            </button>
          ) : (
            <TaskCheck
              done={t.done}
              onToggle={function () {
                void actions.toggle(t.id);
              }}
            />
          )}

          <PriorityMark
            priority={t.priority}
            onCycle={
              t.done
                ? undefined
                : function () {
                    void actions.patch(t.id, { priority: nextPriority(t.priority) });
                  }
            }
          />

          <div className="kedu-title-wrap flex min-w-0 flex-1 items-center gap-2">
            <RowTitle task={t} onOpen={open} />
            {t.tags.length ? (
              <span
                className="max-w-[min(42%,14rem)] min-w-0 shrink truncate text-[11px] text-muted-foreground"
                title={t.tags.map(function (name) { return "#" + name; }).join(" ")}
              >
                {t.tags.slice(0, 3).map(function (name) { return "#" + name; }).join(" ")}
                {t.tags.length > 3 ? " +" + String(t.tags.length - 3) : ""}
              </span>
            ) : null}
            {t.subtasks.length ? (
              <button
                type="button"
                aria-expanded={openSubs}
                aria-label={openSubs ? "收起子任务" : "展开子任务"}
                onClick={function (e) {
                  e.stopPropagation();
                  setOpenSubs(!openSubs);
                }}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-1.5 py-0.5 font-mono text-[11px]",
                  openSubs ? "border-foreground bg-foreground text-background" : "border-border text-foreground"
                )}
              >
                <motion.span
                  className="inline-flex"
                  animate={{ rotate: openSubs ? 90 : 0 }}
                  transition={reduceMotion ? { duration: 0 } : { duration: 0.22, ease: SUB_EASE }}
                >
                  <Icon.ChevronRight size={10} strokeWidth={2.4} />
                </motion.span>
                <SubtaskTicks done={subDone} total={t.subtasks.length} invert={openSubs} />
                <span className="tabular-nums">{subDone + "/" + t.subtasks.length}</span>
              </button>
            ) : null}
            <span className="flex-1" />
            {!props.quiet && !t.done && !selectMode && !props.inGrace ? (
              <button
                type="button"
                data-kedu="doing-toggle"
                aria-pressed={Boolean(t.doing)}
                aria-label={t.doing ? "退出进行中" : "标为进行中"}
                title={t.doing ? "退出进行中" : "标为进行中"}
                onClick={function (e) {
                  e.stopPropagation();
                  void actions.patch(t.id, { doing: !t.doing });
                }}
                className={cn(
                  "kedu-doing-toggle grid size-7 shrink-0 place-items-center rounded-md",
                  t.doing ? "" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
                data-on={t.doing ? "1" : "0"}
              >
                {t.doing ? (
                  <Icon.Pause size={12} className="block" fill="currentColor" strokeWidth={0} />
                ) : (
                  <Icon.Play size={12} className="block" fill="currentColor" strokeWidth={0} />
                )}
              </button>
            ) : null}
            {props.inGrace ? (
              <button
                type="button"
                onClick={function (e) {
                  e.stopPropagation();
                  void actions.toggle(t.id);
                }}
                className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
              >
                撤销
              </button>
            ) : t.done ? (
              t.completedAt ? (
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
                  {relativeTime(t.completedAt)}
                </span>
              ) : null
            ) : (
              <DueText meta={meta} />
            )}
          </div>
        </div>

        {props.face === "inbox" && !props.quiet && !t.done && !selectMode ? (
          <div className={cn("mt-1.5 flex gap-1.5", props.draggable ? "pl-[4.875rem]" : "pl-[3.25rem]")}>
            {quick.map(function (q) {
              return (
                <button
                  key={q.label}
                  type="button"
                  onClick={function (e) {
                    e.stopPropagation();
                    void actions.patch(t.id, { due: q.due, starts: null });
                  }}
                  className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-foreground hover:text-foreground"
                >
                  {q.label}
                </button>
              );
            })}
          </div>
        ) : null}

        <AnimatePresence initial={false}>
          {openSubs ? (
            <motion.div
              key="subs"
              initial={reduceMotion ? false : { height: 0, opacity: 0 }}
              animate={{
                height: "auto",
                opacity: 1,
                transition: reduceMotion
                  ? { duration: 0 }
                  : {
                      height: { duration: 0.32, ease: SUB_EASE },
                      opacity: { duration: 0.18, ease: "easeOut" },
                    },
              }}
              exit={{
                height: 0,
                opacity: 0,
                transition: reduceMotion
                  ? { duration: 0 }
                  : {
                      height: { duration: 0.34, ease: SUB_EASE },
                      opacity: { duration: 0.14, ease: "easeIn" },
                    },
              }}
              className="overflow-hidden"
            >
              <ul className={cn("flex flex-col gap-1 pt-1.5", props.draggable ? "pl-[4.875rem]" : "pl-[3.25rem]")}>
                {t.subtasks.map(function (s, i) {
                  return (
                    <motion.li
                      key={s.id}
                      initial={reduceMotion ? false : { opacity: 0, y: -3 }}
                      animate={{
                        opacity: 1,
                        y: 0,
                        transition: reduceMotion
                          ? { duration: 0 }
                          : { duration: 0.2, delay: Math.min(i, 6) * 0.028, ease: SUB_EASE },
                      }}
                      className="flex items-center gap-2"
                    >
                      <TaskCheck
                        done={s.done}
                        onToggle={function () {
                          void actions.patch(t.id, {
                            subtasks: t.subtasks.map(function (item) {
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
                      />
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate text-xs",
                          s.done ? "text-muted-foreground line-through" : "text-foreground"
                        )}
                      >
                        {s.title}
                      </span>
                      {s.done ? (
                        <span className="shrink-0 pl-2 text-[11px] tabular-nums text-muted-foreground/75">
                          {s.completedAt ? relativeTime(s.completedAt) : "完成"}
                        </span>
                      ) : null}
                    </motion.li>
                  );
                })}
              </ul>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
      {props.inGrace ? (
        <span className="absolute inset-x-0 bottom-0 h-px" style={{ backgroundColor: "color-mix(in oklab, var(--foreground) 20%, transparent)" }}>
          <span
            key={t.completedAt || 0}
            className="kedu-grace block h-px w-full bg-foreground"
            style={{ animationDuration: GRACE_MS + "ms" }}
          />
        </span>
      ) : null}
    </motion.li>
  );
}

function emptyCopy(lens: ViewId, filtered: boolean): { title: string; hint: string } {
  if (filtered) return { title: "没有符合的事", hint: "清掉筛选，或者换一个词。" };
  if (lens === "today") return { title: "今天没有要做的", hint: "写一条就能加进来。用 @明天 会排到之后。" };
  if (lens === "next") return { title: "后面还是空的", hint: "用 @周五 或 @下周一 把事情排进来。" };
  return { title: "收集是空的", hint: "没写日期的事会落在这里。点今天、明天或周末就排走。" };
}

function doingSinceLabel(doingAt: number | null): string {
  if (doingAt == null) return "进行中";
  const mins = Math.max(1, Math.round((Date.now() - doingAt) / 60000));
  if (mins < 60) return "已进行 " + String(mins) + " 分钟";
  return "已进行 " + String(Math.round(mins / 60)) + " 小时";
}

function DoingRow(props: { task: Task; selected: boolean; reduceMotion: boolean }) {
  const { actions, openTask, today } = useStore();
  const t = props.task;
  const [openSubs, setOpenSubs] = React.useState(false);
  const meta = scheduleOf(t, today);
  let subDone = 0;
  for (let i = 0; i < t.subtasks.length; i++) if (t.subtasks[i].done) subDone += 1;

  return (
    <motion.li
      layout
      /* No shared layoutId with main-list rows — cross-list FLIP was dragging the whole section. */
      initial={props.reduceMotion ? false : { opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={props.reduceMotion ? undefined : { opacity: 0, y: -2 }}
      transition={
        props.reduceMotion
          ? { duration: 0 }
          : { layout: { duration: 0.28, ease: SUB_EASE }, opacity: { duration: 0.18 } }
      }
      data-kedu="doing-row"
      data-on={props.selected ? "1" : "0"}
      className="kedu-doing-row relative cursor-pointer list-none"
      onClick={function () {
        openTask(t.id);
      }}
    >
      <div className="px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <TaskCheck
            done={false}
            onToggle={function () {
              void actions.toggle(t.id);
            }}
          />
          <PriorityMark priority={t.priority} />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="min-w-0 truncate text-sm font-medium text-foreground">{t.title}</span>
            {t.tags.length ? (
              <span className="max-w-[min(42%,14rem)] shrink truncate text-[11px] text-muted-foreground">
                {t.tags
                  .slice(0, 3)
                  .map(function (name) {
                    return "#" + name;
                  })
                  .join(" ")}
              </span>
            ) : null}
            {t.subtasks.length ? (
              <button
                type="button"
                aria-expanded={openSubs}
                aria-label={openSubs ? "收起子任务" : "展开子任务"}
                onClick={function (e) {
                  e.stopPropagation();
                  setOpenSubs(!openSubs);
                }}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-1.5 py-0.5 font-mono text-[11px]",
                  openSubs ? "border-foreground bg-foreground text-background" : "border-border text-foreground"
                )}
              >
                <motion.span
                  className="inline-flex"
                  animate={{ rotate: openSubs ? 90 : 0 }}
                  transition={props.reduceMotion ? { duration: 0 } : { duration: 0.22, ease: SUB_EASE }}
                >
                  <Icon.ChevronRight size={10} strokeWidth={2.4} />
                </motion.span>
                <SubtaskTicks done={subDone} total={t.subtasks.length} invert={openSubs} />
                <span className="tabular-nums">{subDone + "/" + t.subtasks.length}</span>
              </button>
            ) : null}
            <span className="flex-1" />
            <button
              type="button"
              aria-label="暂停进行中"
              title="暂停进行中"
              onClick={function (e) {
                e.stopPropagation();
                void actions.patch(t.id, { doing: false });
              }}
              className="kedu-doing-toggle grid size-7 shrink-0 place-items-center rounded-md"
              data-on="1"
            >
              <Icon.Pause size={12} className="block" fill="currentColor" strokeWidth={0} />
            </button>
            <span className="flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-muted-foreground">
              <span>{doingSinceLabel(t.doingAt)}</span>
              {meta ? (
                <>
                  <span aria-hidden="true">·</span>
                  <DueText meta={meta} />
                </>
              ) : null}
            </span>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {openSubs ? (
            <motion.div
              key="subs"
              initial={props.reduceMotion ? false : { height: 0, opacity: 0 }}
              animate={{
                height: "auto",
                opacity: 1,
                transition: props.reduceMotion
                  ? { duration: 0 }
                  : {
                      height: { duration: 0.32, ease: SUB_EASE },
                      opacity: { duration: 0.18, ease: "easeOut" },
                    },
              }}
              exit={{
                height: 0,
                opacity: 0,
                transition: props.reduceMotion
                  ? { duration: 0 }
                  : {
                      height: { duration: 0.34, ease: SUB_EASE },
                      opacity: { duration: 0.14, ease: "easeIn" },
                    },
              }}
              className="overflow-hidden"
            >
              <ul className="flex flex-col gap-1 pt-1.5 pl-[3.25rem]">
                {t.subtasks.map(function (s, i) {
                  return (
                    <motion.li
                      key={s.id}
                      initial={props.reduceMotion ? false : { opacity: 0, y: -3 }}
                      animate={{
                        opacity: 1,
                        y: 0,
                        transition: props.reduceMotion
                          ? { duration: 0 }
                          : { duration: 0.2, delay: Math.min(i, 6) * 0.028, ease: SUB_EASE },
                      }}
                      className="flex items-center gap-2"
                    >
                      <TaskCheck
                        done={s.done}
                        onToggle={function () {
                          void actions.patch(t.id, {
                            subtasks: t.subtasks.map(function (item) {
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
                      />
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate text-xs",
                          s.done ? "text-muted-foreground line-through" : "text-foreground"
                        )}
                      >
                        {s.title}
                      </span>
                      {s.done ? (
                        <span className="shrink-0 pl-2 text-[11px] tabular-nums text-muted-foreground/75">
                          {s.completedAt ? relativeTime(s.completedAt) : "完成"}
                        </span>
                      ) : null}
                    </motion.li>
                  );
                })}
              </ul>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </motion.li>
  );
}

/** Global 正在做 tray — exclusive of the main list; survives lens switches. */
function DoingStage(props: { match: (t: Task) => boolean }) {
  const { tasks, selectedId, selectMode } = useStore();
  const list = tasks
    .filter(function (t) {
      return t.doing && !t.done && props.match(t);
    })
    .sort(function (a, b) {
      return (b.doingAt || 0) - (a.doingAt || 0);
    });
  if (!list.length || selectMode) return null;

  const reduceMotion = useReducedMotion();

  return (
    <motion.section
      className="kedu-doing-stage"
      data-kedu="doing-stage"
      aria-label="进行中"
      initial={reduceMotion ? false : { opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduceMotion ? undefined : { opacity: 0, y: -2, height: 0, marginTop: 0, marginBottom: 0 }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.28, ease: SUB_EASE }}
    >
      <div className="flex items-baseline gap-2 px-3 pb-1 pt-4">
        <span className="text-xs text-muted-foreground">进行中</span>
        <Mono className="text-muted-foreground">{list.length}</Mono>
      </div>
      <ul>
        <AnimatePresence initial={false} mode="popLayout">
          {list.map(function (t) {
            return (
              <DoingRow key={t.id} task={t} selected={selectedId === t.id} reduceMotion={Boolean(reduceMotion)} />
            );
          })}
        </AnimatePresence>
      </ul>
    </motion.section>
  );
}

export function TaskList(props: { onClearFilters?: () => void; lens?: ViewId; quiet?: boolean }) {
  const store = useStore();
  const lens = props.lens ?? store.lens;
  const quiet = Boolean(props.quiet);
  const { tasks, sort, today, query, tagFilter, prioFilter, selectMode, graceIds, actions } = store;
  const dayFilter = quiet ? null : store.dayFilter;
  const [doneOpen, setDoneOpen] = React.useState(false);
  const reduceMotion = useReducedMotion();
  const dragId = React.useRef<string | null>(null);
  const [dragging, setDragging] = React.useState<string | null>(null);
  const [overId, setOverId] = React.useState<string | null>(null);

  const filtered = Boolean(query.trim() || tagFilter || prioFilter.length || dayFilter);

  function coversDay(t: Task, day: string): boolean {
    if (completedOn(t, day)) return true;
    if (t.starts && t.due) return t.starts <= day && day <= t.due;
    return t.due === day;
  }
  const canDrag = !quiet && sort === "manual" && !selectMode && !filtered;

  function match(t: Task): boolean {
    if (tagFilter && t.tags.indexOf(tagFilter) < 0) return false;
    if (prioFilter.length && prioFilter.indexOf(t.priority) < 0) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (t.title + " " + t.notes + " " + t.tags.join(" ")).toLowerCase().indexOf(q) >= 0;
  }

  const active = sortTasks(
    tasks.filter(function (t) {
      // Doing tasks live on the 正在做 stage (main list only), not duplicated below.
      if (!quiet && t.doing && !t.done && graceIds.indexOf(t.id) < 0) return false;
      return (inView(t, lens, today) || graceIds.indexOf(t.id) >= 0) && match(t);
    }),
    sort
  );

  function bucketOf(t: Task): GroupId {
    if (graceIds.indexOf(t.id) >= 0 && t.done) return groupOf(Object.assign({}, t, { done: false }), today);
    return groupOf(t, today);
  }

  const heads: GroupId[] = lens === "today" ? ["overdue", "today"] : lens === "next" ? ["tomorrow", "week", "later"] : ["none"];
  const buckets: Record<string, Task[]> = {};
  for (let i = 0; i < heads.length; i++) buckets[heads[i]] = [];
  for (let i = 0; i < active.length; i++) {
    const g = bucketOf(active[i]);
    if (!buckets[g]) buckets[g] = [];
    buckets[g].push(active[i]);
  }
  const nonEmpty = heads.filter(function (id) {
    return buckets[id] && buckets[id].length > 0;
  });

  const doneToday = tasks.filter(function (t) {
    return lens === "today" && completedOn(t, today) && graceIds.indexOf(t.id) < 0 && match(t);
  });
  // Older completions stay out of the day. A filter or search can still find them.
  const olderDone = filtered
    ? tasks.filter(function (t) {
        if (!t.done || graceIds.indexOf(t.id) >= 0 || !match(t)) return false;
        return !(lens === "today" && completedOn(t, today));
      })
    : [];

  const copy = emptyCopy(lens, filtered);
  const showClear = lens === "today" && !filtered && nonEmpty.length === 0 && doneToday.length > 0 && olderDone.length === 0;
  const doingCount = quiet
    ? 0
    : tasks.filter(function (t) {
        return t.doing && !t.done && match(t);
      }).length;
  const showEmpty = nonEmpty.length === 0 && doneToday.length === 0 && olderDone.length === 0 && doingCount === 0;
  const onlyDoing = nonEmpty.length === 0 && doneToday.length === 0 && olderDone.length === 0 && doingCount > 0;

  function move(groupIds: string[], targetId: string) {
    const from = dragId.current;
    if (!from || from === targetId) return;
    const ids = groupIds.slice();
    const a = ids.indexOf(from);
    const b = ids.indexOf(targetId);
    if (a < 0 || b < 0) return;
    ids.splice(a, 1);
    ids.splice(b, 0, from);
    void actions.reorder(ids);
  }

  function gripDown(taskId: string, groupIds: string[], event: React.PointerEvent<HTMLSpanElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const startY = event.clientY;
    let active = false;
    const handle = event.currentTarget;
    try {
      handle.setPointerCapture(pointerId);
    } catch (e) {
      /* the window listeners still follow the pointer */
    }
    function rowAt(x: number, y: number): string | null {
      const el = document.elementFromPoint(x, y);
      const row = el && el.closest ? el.closest("[data-kedu=row]") : null;
      return row ? row.getAttribute("data-id") : null;
    }
    function onMove(ev: PointerEvent) {
      if (ev.pointerId !== pointerId) return;
      if (!active && Math.abs(ev.clientY - startY) < 5) return;
      if (!active) {
        active = true;
        dragId.current = taskId;
        setDragging(taskId);
      }
      const id = rowAt(ev.clientX, ev.clientY);
      setOverId(function (prev) {
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
        if (id) move(groupIds, id);
      }
      dragId.current = null;
      setDragging(null);
      setOverId(null);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }

  function renderRow(t: Task, groupIds: string[], allowDrag: boolean) {
    return (
      <Row
        key={t.id}
        task={t}
        face={lens}
        quiet={quiet}
        draggable={allowDrag}
        dragging={dragging === t.id}
        drop={overId === t.id && dragging !== t.id}
        inGrace={graceIds.indexOf(t.id) >= 0}
        onGripDown={function (e) {
          if (!allowDrag) return;
          gripDown(t.id, groupIds, e);
        }}
      />
    );
  }

  if (dayFilter) {
    const rows = sortTasks(
      tasks.filter(function (t) {
        return coversDay(t, dayFilter) && match(t);
      }),
      sort
    );
    const ids = rows.map(function (t) {
      return t.id;
    });
    return (
      <div className="px-2 pb-10" data-kedu="day-list">
        <section>
          <div className="flex items-baseline gap-2 px-3 pb-1 pt-4">
            <span className="text-xs text-muted-foreground">{dayHeading(dayFilter)}</span>
            <Mono className="text-muted-foreground">{rows.length}</Mono>
          </div>
          {rows.length ? (
            <ul>{rows.map(function (t) { return renderRow(t, ids, false); })}</ul>
          ) : (
            <p className="px-3 py-8 text-sm text-muted-foreground">这一天没有任务</p>
          )}
        </section>
      </div>
    );
  }

  return (
    <LayoutGroup id="kedu-tasks">
    <div className="px-2 pb-10">
      <AnimatePresence initial={false}>
        {!quiet && lens !== "once" ? <DoingStage key="doing-stage" match={match} /> : null}
      </AnimatePresence>
      {nonEmpty.map(function (id) {
        const rows = buckets[id];
        // When 进行中 is on screen it is its own section — always label 逾期/今天 so
        // leftover rows cannot look like they belong under 进行中.
        const showHead =
          doingCount > 0 || lens === "next" || nonEmpty.length > 1 || id === "overdue";
        const ids = rows.map(function (t) {
          return t.id;
        });
        return (
          <section key={id}>
            {showHead ? (
              <div className="flex items-baseline gap-2 px-3 pb-1 pt-4">
                <span className="text-xs text-muted-foreground">{GROUP_TITLE[id]}</span>
                <Mono className="text-muted-foreground">{rows.length}</Mono>
              </div>
            ) : null}
            <ul>{rows.map(function (t) { return renderRow(t, ids, canDrag); })}</ul>
          </section>
        );
      })}

      {showClear ? <p className="px-3 py-8 text-sm text-muted-foreground">今天的都做完了。</p> : null}

      {showEmpty ? (
        quiet ? (
          <p className="px-3 py-8 text-sm text-muted-foreground">{filtered ? "没有符合的事" : copy.title}</p>
        ) : (
          <Empty className="border-0 py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">{filtered ? <IlluSearch /> : <IlluEmpty />}</EmptyMedia>
              <EmptyTitle>{copy.title}</EmptyTitle>
              <EmptyDescription>{copy.hint}</EmptyDescription>
            </EmptyHeader>
            {filtered && props.onClearFilters ? (
              <button type="button" onClick={props.onClearFilters} className="text-sm text-foreground underline-offset-2 hover:underline">
                清除筛选
              </button>
            ) : null}
          </Empty>
        )
      ) : null}

      {onlyDoing ? (
        <p className="px-3 py-6 text-sm text-muted-foreground">其余都在上面的进行中列表里。</p>
      ) : null}

      {olderDone.length ? (
        <section className="mt-2">
          <div className="flex items-baseline gap-2 px-3 pb-1 pt-4">
            <span className="text-xs text-muted-foreground">已完成</span>
            <Mono className="text-muted-foreground">{olderDone.length}</Mono>
          </div>
          <ul>
            {olderDone.map(function (t) {
              return renderRow(t, [], false);
            })}
          </ul>
        </section>
      ) : null}

      {doneToday.length ? (
        <section className="mt-2">
          <button
            type="button"
            aria-expanded={doneOpen}
            onClick={function () {
              setDoneOpen(!doneOpen);
            }}
            className="flex w-full items-center gap-2 px-3 py-3 text-xs text-muted-foreground hover:text-foreground"
          >
            <motion.span
              className="inline-flex"
              animate={{ rotate: doneOpen ? 90 : 0 }}
              transition={reduceMotion ? { duration: 0 } : { duration: 0.22, ease: SUB_EASE }}
            >
              <Icon.ChevronRight size={12} />
            </motion.span>
            今天完成
            <Mono>{doneToday.length}</Mono>
          </button>
          <AnimatePresence initial={false}>
            {doneOpen ? (
              <motion.div
                key="done-today"
                initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                animate={{
                  height: "auto",
                  opacity: 1,
                  transition: reduceMotion
                    ? { duration: 0 }
                    : {
                        height: { duration: 0.32, ease: SUB_EASE },
                        opacity: { duration: 0.18, ease: "easeOut" },
                      },
                }}
                exit={{
                  height: 0,
                  opacity: 0,
                  transition: reduceMotion
                    ? { duration: 0 }
                    : {
                        height: { duration: 0.34, ease: SUB_EASE },
                        opacity: { duration: 0.14, ease: "easeIn" },
                      },
                }}
                className="overflow-hidden"
              >
                <ul>
                  {doneToday.map(function (t) {
                    return renderRow(t, [], false);
                  })}
                </ul>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </section>
      ) : null}
    </div>
    </LayoutGroup>
  );
}
