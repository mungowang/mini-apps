import * as React from "react";
import { Button, ConfirmDialog, DatePicker, Icon, TagInput, toast, useApp, cn } from "@mohou/ui";

import { dateKey, fmtShort, parseKey, relativeTime, shiftKey } from "../shared/model";
import type { Priority, Subtask } from "../shared/types";
import { PRIORITY_LABEL, PRIORITY_TITLE } from "../shared/types";
import { Mono, TaskCheck } from "./atoms";
import { imageFilesFrom, shrinkImage } from "./image-utils";
import { useStore } from "./store";

const PRIOS: Priority[] = [1, 2, 3, 4];

function SubtaskLine(props: {
  sub: Subtask;
  onToggle: () => void;
  onRename: (title: string) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = React.useState(props.sub.title);
  React.useEffect(
    function () {
      setDraft(props.sub.title);
    },
    [props.sub.title]
  );
  function commit() {
    const next = draft.trim();
    if (!next || next === props.sub.title) {
      setDraft(props.sub.title);
      return;
    }
    props.onRename(next);
  }
  return (
    <li className="group flex items-center gap-2 border-b border-border py-1.5">
      <TaskCheck done={props.sub.done} onToggle={props.onToggle} />
      <input
        value={draft}
        aria-label="子任务"
        onChange={function (e) {
          setDraft(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={function (e) {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(props.sub.title);
            e.currentTarget.blur();
          }
        }}
        className={cn(
          "min-w-0 flex-1 bg-transparent text-sm outline-none",
          props.sub.done ? "text-muted-foreground line-through" : "text-foreground"
        )}
      />
      <button
        type="button"
        aria-label="删除子任务"
        onClick={props.onRemove}
        className="text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
      >
        <Icon.X size={12} />
      </button>
    </li>
  );
}

function Chip(props: { on: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={props.on}
      onClick={props.onClick}
      className={cn(
        "rounded-full border px-2 py-0.5 text-xs",
        props.on ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground hover:text-foreground"
      )}
    >
      {props.children}
    </button>
  );
}

export function TaskDetail() {
  const { call } = useApp();
  const { tasks, selectedId, openTask, actions, today } = useStore();
  const task = tasks.find(function (t) {
    return t.id === selectedId;
  });
  const [title, setTitle] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [draftSub, setDraftSub] = React.useState("");
  const [urls, setUrls] = React.useState<Record<string, string>>({});
  const [confirmDel, setConfirmDel] = React.useState(false);
  const [rangeOn, setRangeOn] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const actionsRef = React.useRef(actions);
  actionsRef.current = actions;
  const callRef = React.useRef(call);
  callRef.current = call;

  const imageKey = task ? task.images.map(function (im) { return im.id; }).join(",") : "";

  React.useEffect(
    function () {
      setTitle(task ? task.title : "");
      setNotes(task ? task.notes : "");
      setDraftSub("");
      setConfirmDel(false);
      setRangeOn(Boolean(task && task.starts && task.due && task.starts !== task.due));
    },
    [task ? task.id : ""]
  );

  React.useEffect(
    function () {
      if (!task || !imageKey) {
        setUrls({});
        return;
      }
      const ids = imageKey.split(",");
      let alive = true;
      void callRef.current("imagesGet", { ids }).then(function (res) {
        if (!alive || !res || typeof res !== "object") return;
        setUrls(res as Record<string, string>);
      });
      return function () {
        alive = false;
      };
    },
    [task ? task.id : "", imageKey]
  );

  React.useEffect(
    function () {
      if (!task) return;
      const id = task.id;
      function onPaste(e: ClipboardEvent) {
        const files = imageFilesFrom(e.clipboardData);
        if (!files.length) return;
        e.preventDefault();
        void take(id, files);
      }
      window.addEventListener("paste", onPaste);
      return function () {
        window.removeEventListener("paste", onPaste);
      };
    },
    [task ? task.id : "", task ? task.images.length : 0]
  );

  async function take(taskId: string, files: File[]) {
    const current = tasks.find(function (t) {
      return t.id === taskId;
    });
    let room = 8 - (current ? current.images.length : 0);
    if (room <= 0) {
      toast.add({ title: "最多 8 张图" });
      return;
    }
    for (let i = 0; i < files.length && room > 0; i++) {
      const img = await shrinkImage(files[i]);
      if (!img) continue;
      await actionsRef.current.addImage(taskId, img.data, img.w, img.h);
      room -= 1;
    }
  }

  if (!task) return null;

  const current = task;
  const hasRange = Boolean(current.starts && current.due && current.starts !== current.due);

  function patch(p: Record<string, unknown>) {
    void actions.patch(current.id, p);
  }

  function commitTitle() {
    const next = title.trim();
    if (!next || next === current.title) {
      setTitle(current.title);
      return;
    }
    patch({ title: next });
  }

  function setDue(due: string | null) {
    patch({ due, starts: null });
    setRangeOn(false);
  }

  function addSub() {
    const text = draftSub.trim();
    if (!text) return;
    const subs: Subtask[] = current.subtasks.concat([{ id: "", title: text, done: false }]);
    patch({ subtasks: subs });
    setDraftSub("");
  }

  const quick = [
    { label: "今天", due: today },
    { label: "明天", due: shiftKey(today, 1) },
    { label: "下周", due: shiftKey(today, 7) },
  ];

  return (
    <div data-kedu="detail" className="relative h-full overflow-auto px-5 pt-4 pb-8">
      <button
        type="button"
        aria-label="关闭"
        onClick={function () {
          openTask(null);
        }}
        className="absolute right-3 top-3 z-10 grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Icon.X size={16} />
      </button>
      <div className="pr-8">
          <input
            value={title}
            aria-label="标题"
            onChange={function (e) {
              setTitle(e.target.value);
            }}
            onBlur={commitTitle}
            onKeyDown={function (e) {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            className="mt-1 w-full bg-transparent text-base text-foreground outline-none"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            {"创建于 " + relativeTime(current.createdAt)}
            {current.completedAt ? " · 完成于 " + relativeTime(current.completedAt) : ""}
          </p>

          <label className="mt-4 block text-xs text-muted-foreground" htmlFor="kedu-notes">备注</label>
          <textarea
            id="kedu-notes"
            value={notes}
            rows={4}
            placeholder="补充一句就够"
            onChange={function (e) {
              setNotes(e.target.value);
            }}
            onBlur={function () {
              if (notes !== current.notes) patch({ notes });
            }}
            className="mt-1 w-full resize-none rounded-md border border-input bg-transparent px-2 py-1.5 text-sm outline-none focus:border-foreground"
          />

          <div className="mt-4">
            <p className="text-xs text-muted-foreground">哪一天</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {quick.map(function (q) {
                return (
                  <Chip key={q.label} on={current.due === q.due && !hasRange} onClick={function () { setDue(q.due); }}>
                    {q.label}
                  </Chip>
                );
              })}
              <Chip on={!current.due} onClick={function () { setDue(null); }}>
                不排期
              </Chip>
            </div>
            <div className="mt-2">
              <DatePicker
                {...(current.due ? { value: parseKey(current.due) } : {})}
                onChange={function (d) {
                  if (!d) setDue(null);
                  else patch({ due: dateKey(d) });
                }}
              />
            </div>
            {hasRange && current.starts ? (
              <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                {"从 " + fmtShort(current.starts) + " 开始"}
                <button type="button" className="hover:text-foreground" onClick={function () { patch({ starts: null }); setRangeOn(false); }}>
                  取消跨天
                </button>
              </p>
            ) : null}
            {!hasRange && current.due ? (
              <button
                type="button"
                className="mt-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={function () {
                  setRangeOn(!rangeOn);
                }}
              >
                {rangeOn ? "收起开始日" : "从另一天开始"}
              </button>
            ) : null}
            {rangeOn && !hasRange && current.due ? (
              <div className="mt-2">
                <DatePicker
                  {...(current.starts ? { value: parseKey(current.starts) } : {})}
                  onChange={function (d) {
                    if (!d) patch({ starts: null });
                    else patch({ starts: dateKey(d) });
                  }}
                />
              </div>
            ) : null}
          </div>

          <div className="mt-4">
            <p className="text-xs text-muted-foreground">时间</p>
            <div className="mt-1.5 flex items-center gap-2">
              <input
                type="time"
                aria-label="开始时间"
                value={current.startTime || ""}
                onChange={function (e) {
                  patch({ startTime: e.target.value || null });
                }}
                className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
              />
              <span className="text-xs text-muted-foreground">到</span>
              <input
                type="time"
                aria-label="结束时间"
                value={current.endTime || ""}
                onChange={function (e) {
                  patch({ endTime: e.target.value || null });
                }}
                className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
              />
              {current.startTime || current.endTime ? (
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={function () {
                    patch({ startTime: null, endTime: null });
                  }}
                >
                  清除
                </button>
              ) : null}
            </div>
          </div>

          <div className="mt-4">
            <p className="text-xs text-muted-foreground">优先级</p>
            <div className="mt-1.5 flex gap-1.5">
              {PRIOS.map(function (p) {
                return (
                  <Chip key={p} on={current.priority === p} onClick={function () { patch({ priority: p }); }}>
                    {PRIORITY_LABEL[p] + " " + PRIORITY_TITLE[p]}
                  </Chip>
                );
              })}
            </div>
          </div>

          <div className="mt-4">
            <p className="mb-1.5 text-xs text-muted-foreground">标签</p>
            <TagInput
              value={current.tags}
              placeholder="输入后回车"
              onChange={function (next) {
                patch({ tags: next.slice(0, 8) });
              }}
            />
          </div>

          <div className="mt-4">
            <p className="text-xs text-muted-foreground">
              子任务
              {current.subtasks.length ? <Mono className="ml-2">{current.subtasks.filter(function (s) { return s.done; }).length + "/" + current.subtasks.length}</Mono> : null}
            </p>
            <ul className="mt-1">
              {current.subtasks.map(function (s) {
                return (
                  <SubtaskLine
                    key={s.id}
                    sub={s}
                    onToggle={function () {
                      patch({
                        subtasks: current.subtasks.map(function (item) {
                          return item.id === s.id ? { id: item.id, title: item.title, done: !item.done } : item;
                        }),
                      });
                    }}
                    onRename={function (title) {
                      patch({
                        subtasks: current.subtasks.map(function (item) {
                          return item.id === s.id ? { id: item.id, title: title, done: item.done } : item;
                        }),
                      });
                    }}
                    onRemove={function () {
                      patch({
                        subtasks: current.subtasks.filter(function (item) {
                          return item.id !== s.id;
                        }),
                      });
                    }}
                  />
                );
              })}
            </ul>
            <input
              value={draftSub}
              aria-label="新的子任务"
              placeholder="加一条子任务，回车"
              onChange={function (e) {
                setDraftSub(e.target.value);
              }}
              onKeyDown={function (e) {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addSub();
                }
              }}
              className="mt-1 h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          <div className="mt-4">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">图片</p>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={function () {
                  if (fileRef.current) fileRef.current.click();
                }}
              >
                添加
              </button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={function (e) {
                const list = e.target.files;
                const files: File[] = [];
                if (list) for (let i = 0; i < list.length; i++) files.push(list[i]);
                e.target.value = "";
                void take(current.id, files);
              }}
            />
            {current.images.length ? (
              <div className="mt-2 grid grid-cols-3 gap-2">
                {current.images.map(function (im) {
                  const src = urls[im.id];
                  return (
                    <div key={im.id} className="relative overflow-hidden rounded-md border border-border">
                      {src ? <img src={src} alt="" className="aspect-square w-full object-cover" /> : <div className="aspect-square bg-muted" />}
                      <button
                        type="button"
                        aria-label="移除图片"
                        onClick={function () {
                          void actions.removeImage(current.id, im.id);
                        }}
                        className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-background text-foreground"
                      >
                        <Icon.X size={11} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">可以粘贴截图，最多 8 张。</p>
            )}
          </div>

          <div className="mt-6">
            <Button variant="destructive" size="sm" onClick={function () { setConfirmDel(true); }}>
              删除这件事
            </Button>
          </div>
      </div>
      <ConfirmDialog
        open={confirmDel}
        onOpenChange={setConfirmDel}
        title="删除这件事？"
        description="可以马上撤销。"
        confirmLabel="删除"
        onConfirm={function () {
          setConfirmDel(false);
          void actions.remove(current.id);
        }}
      />
    </div>
  );
}
