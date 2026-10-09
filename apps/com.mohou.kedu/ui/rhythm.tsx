import { Icon } from "@mohou/ui";

import { PRIORITY_LABEL, PRIORITY_TITLE } from "../shared/types";
import { Mono } from "./atoms";
import { useStore } from "./store";

export function Rhythm(props: { closable?: boolean }) {
  const { stats, setRhythmOpen, setTagFilter, setPrioFilter, setDayFilter, prioFilter, dayFilter, tags } = useStore();
  const max = stats.days.reduce(function (m, d) {
    return Math.max(m, d.count);
  }, 1);
  const active = Math.max(1, stats.active);

  return (
    <div data-kedu="rhythm" className="flex h-full flex-col overflow-auto px-5 pt-5 pb-8">
      <div className="flex items-start gap-3 pr-1">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-medium text-foreground">节奏</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">任务完成度统计</p>
        </div>
        {props.closable ? (
          <button
            type="button"
            aria-label="关闭"
            onClick={function () {
              setRhythmOpen(false);
            }}
            className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Icon.X size={16} />
          </button>
        ) : null}
      </div>

      <div className="mt-5 flex flex-col gap-6">
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg bg-muted px-3 py-2">
            <p className="text-xs text-muted-foreground">连续</p>
            <p className="mt-1 font-mono text-lg tabular-nums">{stats.streak}<span className="ml-1 text-xs text-muted-foreground">天</span></p>
          </div>
          <div className="rounded-lg bg-muted px-3 py-2">
            <p className="text-xs text-muted-foreground">近 7 日</p>
            <p className="mt-1 font-mono text-lg tabular-nums">{stats.weekDone}</p>
          </div>
          <div className="rounded-lg bg-muted px-3 py-2">
            <p className="text-xs text-muted-foreground">完成率</p>
            <p className="mt-1 font-mono text-lg tabular-nums">{stats.rate}<span className="ml-0.5 text-xs text-muted-foreground">%</span></p>
          </div>
        </div>

        <div>
          <p className="mb-2 text-xs text-muted-foreground">近 14 天完成</p>
          <div className="flex items-end gap-1">
            {stats.days.map(function (d, i) {
              const h = Math.max(d.count === 0 ? 2 : 6, Math.round((d.count / max) * 64));
              const isToday = i === stats.days.length - 1;
              const selected = dayFilter === d.key;
              return (
                <button
                  key={d.key}
                  type="button"
                  data-kedu="day"
                  data-day={d.key}
                  aria-pressed={selected}
                  aria-label={d.key + " 完成 " + String(d.count)}
                  onClick={function () {
                    setDayFilter(selected ? null : d.key);
                    if (props.closable) setRhythmOpen(false);
                  }}
                  className="flex min-w-0 flex-1 flex-col items-center gap-1 rounded-sm hover:bg-muted"
                >
                  <span className="flex h-16 items-end">
                    <span
                      style={{
                        width: 6,
                        height: h,
                        borderRadius: 2,
                        backgroundColor: selected || isToday ? "var(--foreground)" : "color-mix(in oklab, var(--foreground) 45%, transparent)",
                      }}
                    />
                  </span>
                  <Mono className={selected || isToday ? "text-foreground" : "text-muted-foreground"}>{Number(d.day)}</Mono>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">未完成的优先级</p>
          {stats.byPriority.map(function (row) {
            const on = prioFilter.length === 1 && prioFilter[0] === row.priority;
            return (
              <button
                key={row.priority}
                type="button"
                data-kedu="prio"
                data-prio={row.priority}
                aria-pressed={on}
                onClick={function () {
                  setPrioFilter(on ? [] : [row.priority]);
                  if (props.closable) setRhythmOpen(false);
                }}
                className={"flex w-full items-center gap-2 rounded-md px-1 py-1 text-left " + (on ? "bg-muted" : "hover:bg-muted")}
              >
                <span className="w-14 shrink-0 text-xs">{PRIORITY_LABEL[row.priority] + " " + PRIORITY_TITLE[row.priority]}</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-1.5 rounded-full bg-foreground"
                    style={{ width: Math.round((row.count / active) * 100) + "%" }}
                  />
                </span>
                <Mono className="w-6 text-right text-muted-foreground">{row.count}</Mono>
              </button>
            );
          })}
        </div>

        {tags.length ? (
          <div>
            <p className="mb-2 text-xs text-muted-foreground">按标签看清单</p>
            <div className="flex flex-wrap gap-1.5">
              {stats.tags.map(function (tag) {
                return (
                  <button
                    key={tag.name}
                    type="button"
                    onClick={function () {
                      setTagFilter(tag.name);
                      if (props.closable) setRhythmOpen(false);
                    }}
                    className="rounded-full border border-border px-2 py-0.5 text-xs text-foreground hover:border-foreground"
                  >
                    {"#" + tag.name}
                    <span className="ml-1 text-muted-foreground">{tag.count}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
