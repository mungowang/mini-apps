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
    setSort,
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
            aria-label="筛选和排序"
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
                      setSort(s.id);
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
