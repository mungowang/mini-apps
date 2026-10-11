import * as React from "react";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Kbd, Textarea, toast } from "@mohou/ui";

import { formatTaskLine, parseQuickAdd, fmtShort } from "../shared/model";
import type { Parsed, ViewId } from "../shared/model";
import { useStore } from "./store";

type Item = { id: string; label: string; hint?: string; run: () => void };

/** The meta tail of a preview row: tags, priority, schedule, in the DSL spelling. */
function lineMeta(p: Parsed): string {
  const bits: string[] = [];
  for (let i = 0; i < p.tags.length; i++) bits.push("#" + p.tags[i]);
  if (p.priority !== 3) bits.push("!" + p.priority);
  if (p.starts && p.due && p.starts !== p.due) bits.push(fmtShort(p.starts) + "~" + fmtShort(p.due));
  else if (p.due) bits.push(fmtShort(p.due));
  if (p.startTime) bits.push(p.startTime + (p.endTime ? "-" + p.endTime : ""));
  return bits.join(" ");
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.appendChild(helper);
    helper.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(helper);
    return ok;
  }
}

/** Paste lines of the quick-add DSL, preview the parsed items, import in one go. */
function ImportDialog(props: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { actions, today } = useStore();
  const [raw, setRaw] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(
    function () {
      if (!props.open) {
        setRaw("");
        setBusy(false);
      }
    },
    [props.open]
  );

  const lines = React.useMemo(
    function () {
      return raw
        .split("\n")
        .map(function (l) {
          return l.trim();
        })
        .filter(Boolean);
    },
    [raw]
  );
  const good = React.useMemo(
    function () {
      return lines.filter(function (l) {
        return parseQuickAdd(l, today).title;
      });
    },
    [lines, today]
  );
  const skipped = lines.length - good.length;

  async function doImport() {
    if (!good.length || busy) return;
    setBusy(true);
    let n = 0;
    for (let i = 0; i < good.length; i++) {
      const id = await actions.add(good[i]);
      if (id) n += 1;
    }
    setBusy(false);
    props.onOpenChange(false);
    toast.add({ title: "已导入 " + String(n) + " 件", description: "在收集和安排里找到它们" });
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent width={440}>
        <DialogHeader>
          <DialogTitle>导入清单</DialogTitle>
          <DialogDescription>一行一件事：标题 #标签 !优先 @日期 @时间。</DialogDescription>
        </DialogHeader>
        <Textarea
          autoFocus
          aria-label="粘贴清单"
          placeholder={"买牛奶 #生活 !2 @明天\n写周报 @周五 @16:00-17:00"}
          value={raw}
          rows={6}
          onChange={function (e) {
            setRaw(e.target.value);
          }}
          className="mt-3 w-full text-sm"
        />
        {good.length ? (
          <div className="mt-3 max-h-44 overflow-auto rounded-md border border-border" aria-label="可导入预览">
            {good.map(function (line, i) {
              const p = parseQuickAdd(line, today);
              return (
                <div key={i} className="flex items-center gap-2 border-b border-border px-2.5 py-1.5 text-sm last:border-b-0">
                  <span className="min-w-0 flex-1 truncate text-foreground">{p.title}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{lineMeta(p)}</span>
                </div>
              );
            })}
          </div>
        ) : null}
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {good.length
              ? skipped
                ? "有 " + String(good.length) + " 件可导入，另有 " + String(skipped) + " 行会跳过"
                : "有 " + String(good.length) + " 件可导入"
              : "粘贴后一行一件事"}
          </p>
          <Button size="sm" disabled={!good.length || busy} onClick={function () { void doImport(); }}>
            {busy ? "导入中…" : good.length ? "导入 " + String(good.length) + " 件" : "导入"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function Commands(props: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onFocusAdd: () => void;
  onFocusSearch: () => void;
  onClearDone: () => void;
  onReset: () => void;
}) {
  const { setLens, setSelectMode, setRhythmOpen, openTask, tasks } = useStore();
  const [query, setQuery] = React.useState("");
  const [index, setIndex] = React.useState(0);
  const [importOpen, setImportOpen] = React.useState(false);

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

  function copyUndone() {
    const undone = tasks.filter(function (t) {
      return !t.done;
    });
    if (!undone.length) {
      toast.add({ title: "没有未完成的事" });
      props.onOpenChange(false);
      return;
    }
    const text = undone
      .map(function (t) {
        return formatTaskLine(t);
      })
      .join("\n");
    void copyText(text).then(function (ok) {
      if (ok) toast.add({ title: "已复制 " + String(undone.length) + " 件", description: "一行一件，可整段粘贴导入" });
      else toast.add({ title: "复制没有成功", description: "浏览器挡住了剪贴板" });
    });
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
    { id: "copy", label: "复制未完成的清单", run: copyUndone },
    {
      id: "import",
      label: "导入清单",
      run: function () {
        props.onOpenChange(false);
        setImportOpen(true);
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
    <>
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
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </>
  );
}
