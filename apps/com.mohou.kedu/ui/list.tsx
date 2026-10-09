import * as React from "react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle, Icon, IlluEmpty, IlluSearch, cn } from "@mohou/ui";

import type { GroupId } from "../shared/model";
import { GROUP_TITLE, completedOn, dayHeading, groupOf, inView, overdueTier, scheduleOf, shiftKey, sortTasks, weekendKey } from "../shared/model";
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

function nextPriority(p: Priority): Priority {
  return ((p % 4) + 1) as Priority;
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

  return (
    <li
      data-kedu={props.quiet ? "preview-row" : "row"}
      data-id={t.id}
      data-chosen={picked ? "1" : "0"}
      onClick={open}
      className={cn("relative cursor-pointer list-none border-b border-border", faded ? "opacity-40" : "", props.dragging ? "opacity-50" : "")}
      style={{ backgroundColor: picked || selected ? "var(--muted)" : TINT[tier] || undefined }}
    >
      {selectMode ? (
        <span className="kedu-chosen-bar absolute inset-y-0 left-0 w-0.5 bg-foreground" data-on={picked ? "1" : "0"} />
      ) : null}
      {props.drop ? <span className="absolute inset-x-0 top-0 h-px bg-foreground" /> : null}
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        {props.draggable ? (
          <span
            aria-label="拖动排序"
            onPointerDown={props.onGripDown}
            onClick={function (e) {
              e.stopPropagation();
            }}
            className="kedu-grip mt-0.5 cursor-grab text-muted-foreground active:cursor-grabbing"
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
            className="kedu-pick mt-0.5"
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

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={open}
              className={cn(
                "min-w-0 truncate text-left text-sm",
                t.done ? "text-muted-foreground line-through" : "text-foreground"
              )}
            >
              {t.title}
            </button>
            {t.tags.length ? (
              <span className="max-w-24 shrink-0 truncate text-[11px] text-muted-foreground">
                {t.tags.slice(0, 2).map(function (name) { return "#" + name; }).join(" ")}
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
                <Icon.ChevronRight size={10} strokeWidth={2.4} className={openSubs ? "rotate-90" : ""} />
                <SubtaskTicks done={subDone} total={t.subtasks.length} />
                <span className="tabular-nums">{subDone + "/" + t.subtasks.length}</span>
              </button>
            ) : null}
            <span className="flex-1" />
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
            ) : (
              <DueText meta={t.done ? null : meta} />
            )}
          </div>

          {props.face === "inbox" && !props.quiet && !t.done && !selectMode ? (
            <div className="mt-1.5 flex gap-1.5">
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

          {openSubs ? (
            <ul className="mt-1.5 flex flex-col gap-1 pl-0.5">
              {t.subtasks.map(function (s) {
                return (
                  <li key={s.id} className="flex items-center gap-2">
                    <TaskCheck
                      done={s.done}
                      onToggle={function () {
                        void actions.patch(t.id, {
                          subtasks: t.subtasks.map(function (item) {
                            return item.id === s.id ? { id: item.id, title: item.title, done: !item.done } : item;
                          }),
                        });
                      }}
                    />
                    <span className={cn("text-xs", s.done ? "text-muted-foreground line-through" : "text-foreground")}>{s.title}</span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
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
    </li>
  );
}

function emptyCopy(lens: ViewId, filtered: boolean): { title: string; hint: string } {
  if (filtered) return { title: "没有符合的事", hint: "清掉筛选，或者换一个词。" };
  if (lens === "today") return { title: "今天没有要做的", hint: "写一条就能加进来。用 @明天 会排到之后。" };
  if (lens === "next") return { title: "后面还是空的", hint: "用 @周五 或 @下周一 把事情排进来。" };
  return { title: "收集是空的", hint: "没写日期的事会落在这里。点今天、明天或周末就排走。" };
}

export function TaskList(props: { onClearFilters?: () => void; lens?: ViewId; quiet?: boolean }) {
  const store = useStore();
  const lens = props.lens ?? store.lens;
  const quiet = Boolean(props.quiet);
  const { tasks, sort, today, query, tagFilter, prioFilter, selectMode, graceIds, actions } = store;
  const dayFilter = quiet ? null : store.dayFilter;
  const [doneOpen, setDoneOpen] = React.useState(false);
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
  const showEmpty = nonEmpty.length === 0 && doneToday.length === 0 && olderDone.length === 0;

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
    <div className="px-2 pb-10">
      {nonEmpty.map(function (id) {
        const rows = buckets[id];
        const showHead = lens === "next" || nonEmpty.length > 1 || id === "overdue";
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
            <Icon.ChevronRight size={12} className={doneOpen ? "rotate-90" : ""} />
            今天完成
            <Mono>{doneToday.length}</Mono>
          </button>
          {doneOpen ? (
            <ul>
              {doneToday.map(function (t) {
                return renderRow(t, [], false);
              })}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
