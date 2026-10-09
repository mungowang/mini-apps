import * as React from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Kbd } from "@mohou/ui";

import type { ViewId } from "../shared/types";
import { useStore } from "./store";

type Item = { id: string; label: string; hint?: string; run: () => void };

export function Commands(props: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onFocusAdd: () => void;
  onFocusSearch: () => void;
  onClearDone: () => void;
  onReset: () => void;
}) {
  const { setLens, setSelectMode, setRhythmOpen, openTask } = useStore();
  const [query, setQuery] = React.useState("");
  const [index, setIndex] = React.useState(0);

  React.useEffect(
    function () {
      if (!props.open) return;
      setQuery("");
      setIndex(0);
    },
    [props.open]
  );

  function go(lens: ViewId) {
    setLens(lens);
    openTask(null);
    props.onOpenChange(false);
  }

  const items: Item[] = [
    { id: "today", label: "看今天", hint: "1", run: function () { go("today"); } },
    { id: "next", label: "看之后", hint: "2", run: function () { go("next"); } },
    { id: "inbox", label: "看收集", hint: "3", run: function () { go("inbox"); } },
    { id: "add", label: "写下一条", hint: "N", run: props.onFocusAdd },
    { id: "search", label: "搜索", hint: "/", run: props.onFocusSearch },
    {
      id: "select",
      label: "多选几件",
      run: function () {
        setSelectMode(true);
        props.onOpenChange(false);
      },
    },
    {
      id: "rhythm",
      label: "查看节奏",
      run: function () {
        openTask(null);
        setRhythmOpen(true);
        props.onOpenChange(false);
      },
    },
    { id: "clear", label: "清空已完成", run: props.onClearDone },
    { id: "reset", label: "恢复示例", run: props.onReset },
  ];

  const q = query.trim().toLowerCase();
  const shown = items.filter(function (item) {
    return !q || item.label.toLowerCase().indexOf(q) >= 0;
  });
  const current = shown.length ? Math.min(index, shown.length - 1) : 0;

  function runCurrent() {
    const item = shown[current];
    if (item) item.run();
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent width={420} data-kedu="commands">
        <DialogHeader>
          <DialogTitle>命令</DialogTitle>
          <DialogDescription>跳转、搜索，以及不常用的整理。</DialogDescription>
        </DialogHeader>
        <input
          autoFocus
          value={query}
          aria-label="筛选命令"
          placeholder="找一个命令"
          onChange={function (e) {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={function (e) {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (!shown.length) return;
              const dir = e.key === "ArrowDown" ? 1 : -1;
              setIndex(function (prev) {
                return (Math.min(prev, shown.length - 1) + dir + shown.length) % shown.length;
              });
            } else if (e.key === "Enter") {
              e.preventDefault();
              runCurrent();
            }
          }}
          className="mt-3 h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus:border-foreground"
        />
        <div className="mt-2 flex max-h-72 flex-col overflow-auto" role="listbox">
          {shown.map(function (item, i) {
            const on = i === current;
            return (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={on}
                onMouseEnter={function () {
                  setIndex(i);
                }}
                onClick={item.run}
                className={"flex items-center justify-between rounded-md px-2 py-2 text-left text-sm " + (on ? "bg-muted" : "")}
              >
                <span>{item.label}</span>
                {item.hint ? <Kbd>{item.hint}</Kbd> : null}
              </button>
            );
          })}
          {shown.length === 0 ? <p className="px-2 py-3 text-sm text-muted-foreground">没有这条命令</p> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
