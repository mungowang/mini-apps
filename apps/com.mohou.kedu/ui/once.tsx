import * as React from "react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle, Icon, IlluEmpty, IlluSearch, cn } from "@mohou/ui";

import {
  completedKey,
  inOnceRange,
  onceDayHeading,
  onceRangeLabel,
  relativeTime,
} from "../shared/model";
import type { OnceRange, Task } from "../shared/types";
import { Mono, TaskCheck } from "./atoms";
import { useStore } from "./store";

/** Soft DOM cap when the window is「全部」. Expand is session-only. */
export const ONCE_SOFT_CAP = 100;

const PRESETS: { id: string; label: string; range: OnceRange | "custom" }[] = [
  { id: "1", label: "今天", range: { mode: "days", n: 1 } },
  { id: "7", label: "7 天", range: { mode: "days", n: 7 } },
  { id: "30", label: "30 天", range: { mode: "days", n: 30 } },
  { id: "all", label: "全部", range: { mode: "all" } },
  { id: "custom", label: "自定义", range: "custom" },
];

function isPresetDays(n: number): boolean {
  return n === 1 || n === 7 || n === 30;
}

function busiestLine(tasks: Task[], today: string): string | null {
  const map: Record<string, number> = {};
  for (let i = 0; i < tasks.length; i++) {
    const key = completedKey(tasks[i]);
    if (!key) continue;
    map[key] = (map[key] === undefined ? 0 : map[key]) + 1;
  }
  let best: string | null = null;
  let n = 0;
  const keys = Object.keys(map);
  for (let i = 0; i < keys.length; i++) {
    if (map[keys[i]] > n) {
      n = map[keys[i]];
      best = keys[i];
    }
  }
  if (!best || n < 2) return null;
  const label = onceDayHeading(best, today);
  return label + "留下的最多";
}

/** Segmented window under the tab row — only mounted while lens is 曾经. */
export function OnceRangeBar() {
  const { onceRange, setOnceRange } = useStore();
  const custom =
    onceRange.mode === "days" && !isPresetDays(onceRange.n)
      ? true
      : false;
  const [customOpen, setCustomOpen] = React.useState(custom);
  const [draft, setDraft] = React.useState(onceRange.mode === "days" ? onceRange.n : 14);

  React.useEffect(
    function () {
      if (onceRange.mode === "days" && !isPresetDays(onceRange.n)) {
        setCustomOpen(true);
        setDraft(onceRange.n);
      } else if (onceRange.mode === "all" || (onceRange.mode === "days" && isPresetDays(onceRange.n))) {
        // keep custom open only if user just clicked 自定义
      }
    },
    [onceRange]
  );

  function applyCustom(raw: number) {
    let n = Math.round(raw);
    if (!(n >= 2)) n = 2;
    if (n > 365) n = 365;
    setDraft(n);
    if (isPresetDays(n)) {
      setCustomOpen(false);
      setOnceRange({ mode: "days", n: n });
      return;
    }
    setOnceRange({ mode: "days", n: n });
  }

  return (
    <div data-kedu="once-range" className="mt-3 flex flex-wrap items-center gap-1.5 px-3">
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="曾经的时间范围">
        {PRESETS.map(function (p) {
          let on = false;
          if (p.range === "custom") on = customOpen;
          else if (p.range.mode === "all") on = !customOpen && onceRange.mode === "all";
          else on = !customOpen && onceRange.mode === "days" && onceRange.n === p.range.n;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={function () {
                if (p.range === "custom") {
                  setCustomOpen(true);
                  setDraft(onceRange.mode === "days" ? onceRange.n : 14);
                  return;
                }
                setCustomOpen(false);
                setOnceRange(p.range);
              }}
              className={cn(
                "h-7 rounded-full px-2.5 text-xs transition-colors",
                on ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      {customOpen ? (
        <div className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-border px-2 text-xs text-foreground">
          <span className="text-muted-foreground">近</span>
          <button
            type="button"
            aria-label="减少天数"
            className="grid size-5 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={function () {
              applyCustom(draft - 1);
            }}
          >
            −
          </button>
          <input
            value={String(draft)}
            aria-label="近几天"
            inputMode="numeric"
            onChange={function (e) {
              const v = e.target.value.replace(/[^0-9]/g, "");
              setDraft(v ? Number(v) : 0);
            }}
            onBlur={function () {
              applyCustom(draft);
            }}
            onKeyDown={function (e) {
              if (e.key === "Enter") {
                e.preventDefault();
                applyCustom(draft);
                (e.target as HTMLInputElement).blur();
              }
            }}
            className="w-9 bg-transparent text-center font-mono text-xs outline-none"
          />
          <button
            type="button"
            aria-label="增加天数"
            className="grid size-5 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={function () {
              applyCustom(draft + 1);
            }}
          >
            +
          </button>
          <span className="text-muted-foreground">天</span>
        </div>
      ) : null}
    </div>
  );
}

function OnceRow(props: { task: Task }) {
  const { openTask, actions, selectedId, selectMode, chosen, toggleSelect } = useStore();
  const t = props.task;
  const picked = selectMode && chosen.indexOf(t.id) >= 0;
  const selected = !selectMode && selectedId === t.id;

  function open() {
    if (selectMode) toggleSelect(t.id);
    else openTask(t.id);
  }

  return (
    <li
      data-kedu="row"
      data-id={t.id}
      data-chosen={picked ? "1" : "0"}
      onClick={open}
      className={cn(
        "relative cursor-pointer list-none border-b border-border",
        picked || selected ? "bg-muted" : ""
      )}
    >
      {selectMode ? (
        <span className="kedu-chosen-bar absolute inset-y-0 left-0 w-0.5 bg-foreground" data-on={picked ? "1" : "0"} />
      ) : null}
      <div className="flex items-start gap-2.5 px-3 py-2.5">
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
            done={true}
            onToggle={function () {
              void actions.toggle(t.id);
            }}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={open}
              className="min-w-0 flex-1 truncate text-left text-sm text-muted-foreground line-through"
            >
              {t.title}
            </button>
            {t.tags.length ? (
              <span className="max-w-24 shrink-0 truncate text-[11px] text-muted-foreground">
                {t.tags.slice(0, 2).map(function (name) { return "#" + name; }).join(" ")}
              </span>
            ) : null}
            <span className="flex-1" />
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {relativeTime(t.completedAt)}
            </span>
          </div>
        </div>
      </div>
    </li>
  );
}

export function OnceList(props: { onClearFilters?: () => void }) {
  const { tasks, today, onceRange, query, tagFilter, prioFilter, setOnceRange, setArchiveOpen } = useStore();
  const [expandAll, setExpandAll] = React.useState(false);

  React.useEffect(
    function () {
      setExpandAll(false);
    },
    [onceRange.mode, onceRange.mode === "days" ? onceRange.n : "all"]
  );

  const filtered = Boolean(query.trim() || tagFilter || prioFilter.length);

  function match(t: Task): boolean {
    if (tagFilter && t.tags.indexOf(tagFilter) < 0) return false;
    if (prioFilter.length && prioFilter.indexOf(t.priority) < 0) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (t.title + " " + t.notes + " " + t.tags.join(" ")).toLowerCase().indexOf(q) >= 0;
  }

  const full = tasks
    .filter(function (t) {
      return inOnceRange(t, today, onceRange) && match(t);
    })
    .sort(function (a, b) {
      return (b.completedAt || 0) - (a.completedAt || 0);
    });

  const anyDone = tasks.some(function (t) {
    return t.done;
  });
  const HARD_CAP = 500;
  const softCapped = onceRange.mode === "all" && full.length > ONCE_SOFT_CAP && !expandAll;
  let shown = full;
  if (softCapped) shown = full.slice(0, ONCE_SOFT_CAP);
  else if (full.length > HARD_CAP) shown = full.slice(0, HARD_CAP);
  const hardCapped = full.length > HARD_CAP && shown.length === HARD_CAP;

  const groups: { key: string; tasks: Task[] }[] = [];
  for (let i = 0; i < shown.length; i++) {
    const key = completedKey(shown[i]) || "none";
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.tasks.push(shown[i]);
    else groups.push({ key: key, tasks: [shown[i]] });
  }

  const busy = busiestLine(full, today);

  if (!full.length) {
    let title = "这段日子很安静";
    let hint = "做完的事会按日子落在这里。";
    if (filtered) {
      title = "没有符合的";
      hint = "清掉筛选，或换一个时间。";
    } else if (!anyDone) {
      title = "还没有做过的事";
      hint = "在今天勾掉一件，就会出现在这里。";
    }
    return (
      <div className="px-2 pb-10">
        <Empty className="border-0 py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">{filtered ? <IlluSearch /> : <IlluEmpty />}</EmptyMedia>
            <EmptyTitle>{title}</EmptyTitle>
            <EmptyDescription>{hint}</EmptyDescription>
          </EmptyHeader>
          {filtered && props.onClearFilters ? (
            <button type="button" onClick={props.onClearFilters} className="text-sm text-foreground underline-offset-2 hover:underline">
              清除筛选
            </button>
          ) : null}
          {!filtered && anyDone && onceRange.mode !== "all" ? (
            <button
              type="button"
              onClick={function () {
                setOnceRange({ mode: "all" });
              }}
              className="text-sm text-foreground underline-offset-2 hover:underline"
            >
              看看全部
            </button>
          ) : null}
        </Empty>
      </div>
    );
  }

  return (
    <div className="px-2 pb-10" data-kedu="once-list">
      <div className="px-3 pb-3 pt-3">
        <p className="text-sm text-foreground">
          {onceRangeLabel(onceRange)}
          {" · 做完 "}
          <Mono>{full.length}</Mono>
          {" 件"}
        </p>
        {busy ? <p className="mt-1 text-xs text-muted-foreground">{busy}</p> : null}
      </div>

      {softCapped ? (
        <p className="px-3 pb-2 text-xs text-muted-foreground">
          {"共 " + String(full.length) + " 件 · 显示最近 " + String(ONCE_SOFT_CAP) + " 件"}
          <button
            type="button"
            className="ml-2 text-foreground underline-offset-2 hover:underline"
            onClick={function () {
              setExpandAll(true);
            }}
          >
            显示全部
          </button>
        </p>
      ) : null}

      {hardCapped && !softCapped ? (
        <p className="px-3 pb-2 text-xs text-muted-foreground">
          {"共 " + String(full.length) + " 件 · 一次最多 " + String(HARD_CAP) + " 件"}
          <button
            type="button"
            className="ml-2 text-foreground underline-offset-2 hover:underline"
            onClick={function () {
              setArchiveOpen(true);
            }}
          >
            更早的在总览里搜
          </button>
        </p>
      ) : null}

      {groups.map(function (g) {
        return (
          <section key={g.key}>
            <div className="flex items-baseline gap-2 px-3 pb-1 pt-4">
              <span className="text-xs text-muted-foreground">
                {g.key === "none" ? "没有记下完成日" : onceDayHeading(g.key, today)}
              </span>
              <Mono className="text-muted-foreground">{g.tasks.length}</Mono>
            </div>
            <ul>
              {g.tasks.map(function (t) {
                return <OnceRow key={t.id} task={t} />;
              })}
            </ul>
          </section>
        );
      })}

      {hardCapped ? (
        <p className="px-3 pt-6 text-xs text-muted-foreground">
          一次最多看 {HARD_CAP} 件。
          <button
            type="button"
            className="ml-1 text-foreground underline-offset-2 hover:underline"
            onClick={function () {
              setArchiveOpen(true);
            }}
          >
            更早的在总览里搜
          </button>
        </p>
      ) : null}
    </div>
  );
}
