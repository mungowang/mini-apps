import * as React from "react";
import { Icon, Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@mohou/ui";

import type { Priority, SortId } from "../shared/types";
import { PRIORITY_LABEL, PRIORITY_TITLE } from "../shared/types";
import { useStore } from "./store";

const SORTS: { id: SortId; label: string }[] = [
  { id: "manual", label: "手动" },
  { id: "due", label: "截止" },
  { id: "priority", label: "优先" },
  { id: "created", label: "最新" },
];

const PRIOS: Priority[] = [1, 2, 3, 4];

export function FilterButton() {
  const {
    tags,
    sort,
    chooseSort,
    followInbox,
    setFollowInbox,
    lens,
    tagFilter,
    setTagFilter,
    prioFilter,
    setPrioFilter,
    setHoverTag,
    setHoverPrio,
    query,
    setQuery,
  } = useStore();
  const [open, setOpen] = React.useState(false);
  const active = Boolean(query.trim() || tagFilter || prioFilter.length);

  function closeHover() {
    setHoverTag(null);
    setHoverPrio(null);
  }

  return (
    <Popover
      open={open}
      onOpenChange={function (next) {
        setOpen(next);
        if (!next) closeHover();
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="筛选、排序与习惯"
            title="筛选、排序与习惯"
            className="relative grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          />
        }
      >
        <Icon.SlidersHorizontal size={15} strokeWidth={2} />
        {active ? (
          <span
            className="absolute right-1.5 top-1.5 size-1.5 rounded-full"
            style={{ backgroundColor: "var(--foreground)" }}
          />
        ) : null}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <PopoverTitle className="px-1 text-sm">缩小范围</PopoverTitle>
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="优先级">
            {PRIOS.map(function (p) {
              const on = prioFilter.indexOf(p) >= 0;
              return (
                <button
                  key={p}
                  type="button"
                  data-prio={p}
                  aria-pressed={on}
                  title={"悬停可预览，点击只看 " + PRIORITY_LABEL[p]}
                  onMouseEnter={function () {
                    setHoverPrio(p);
                  }}
                  onMouseLeave={function () {
                    setHoverPrio(null);
                  }}
                  onClick={function () {
                    setPrioFilter(
                      on
                        ? prioFilter.filter(function (x) {
                            return x !== p;
                          })
                        : prioFilter.concat([p])
                    );
                  }}
                  className={
                    "rounded-full border px-2 py-0.5 text-xs " +
                    (on ? "border-foreground bg-foreground text-background" : "border-border text-foreground")
                  }
                >
                  {PRIORITY_LABEL[p] + " " + PRIORITY_TITLE[p]}
                </button>
              );
            })}
          </div>

          {tags.length ? (
            <div className="flex max-h-28 flex-wrap gap-1.5 overflow-auto" role="group" aria-label="标签">
              {tags.map(function (name) {
                const on = tagFilter === name;
                return (
                  <button
                    key={name}
                    type="button"
                    data-tag={name}
                    aria-pressed={on}
                    onMouseEnter={function () {
                      setHoverTag(name);
                    }}
                    onMouseLeave={function () {
                      setHoverTag(null);
                    }}
                    onClick={function () {
                      setTagFilter(on ? null : name);
                    }}
                    className={
                      "rounded-full border px-2 py-0.5 text-xs " +
                      (on ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")
                    }
                  >
                    {"#" + name}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">还没有标签。写的时候加上 #工作 就会出现在这里。</p>
          )}

          {lens === "once" ? (
            <p className="text-xs text-muted-foreground">曾经按完成时间排列，不支持改序。</p>
          ) : (
            <div>
              <p className="mb-1.5 text-xs text-muted-foreground">排列</p>
              <div className="flex gap-1" role="group" aria-label="排序">
                {SORTS.map(function (s) {
                  const on = sort === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      aria-pressed={on}
                      onClick={function () {
                        chooseSort(s.id);
                      }}
                      className={
                        "rounded-md px-2 py-1 text-xs " + (on ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted")
                      }
                    >
                      {s.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="border-t border-border pt-3">
            <p className="mb-1.5 text-xs text-muted-foreground">习惯</p>
            <button
              type="button"
              role="switch"
              aria-checked={followInbox}
              onClick={function () {
                setFollowInbox(!followInbox);
              }}
              className="flex w-full items-center gap-3 rounded-lg px-1 py-1.5 text-left hover:bg-muted/60"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-xs text-foreground">创建后打开收集</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                  未排期的事写完，跳到收集并打开详情，方便接着标标签、排日期
                </span>
              </span>
              <span
                aria-hidden="true"
                className={
                  "relative h-5 w-9 shrink-0 rounded-full transition-colors " +
                  (followInbox ? "bg-foreground" : "bg-muted")
                }
              >
                <span
                  className={
                    "absolute top-0.5 size-4 rounded-full bg-background shadow transition-transform " +
                    (followInbox ? "translate-x-4" : "translate-x-0.5")
                  }
                />
              </span>
            </button>
          </div>

          {active ? (
            <button
              type="button"
              onClick={function () {
                setQuery("");
                setTagFilter(null);
                setPrioFilter([]);
                closeHover();
              }}
              className="self-start text-xs text-muted-foreground hover:text-foreground"
            >
              清除筛选
            </button>
          ) : (
            <p className="text-xs text-muted-foreground">悬停一枚优先级或标签，列表会先淡出不会留下的行。</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
