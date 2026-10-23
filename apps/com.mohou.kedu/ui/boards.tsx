import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@mohou/ui";

import { Mono } from "./atoms";
import { useStore } from "./store";
import type { Board } from "../shared/types";

const EASE = [0.22, 1, 0.36, 1] as const;
/** Below this frame width the pills fold into one chip + menu. */
export const BOARDS_COMPACT_AT = 640;

/** 板块切换：宽面板是顶部居中的分段 pills，窄面板收成 chip + 下拉。 */
export function BoardsCenter(props: { narrow: boolean }) {
  const { boards, allTasks, boardId, setBoard, actions } = useStore();
  const [adding, setAdding] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editName, setEditName] = React.useState("");
  const [menuOpen, setMenuOpen] = React.useState(false);

  const active: Record<string, number> = {};
  for (let i = 0; i < allTasks.length; i++) {
    const t = allTasks[i];
    if (t.done) continue;
    const key = t.boardId || "default";
    active[key] = (active[key] === undefined ? 0 : active[key]) + 1;
  }

  async function commitAdd() {
    const name = draft.trim();
    setAdding(false);
    setDraft("");
    if (!name) return;
    const id = await actions.addBoard(name);
    if (id) setBoard(id);
  }

  function startEdit(b: Board) {
    setEditingId(b.id);
    setEditName(b.name);
  }

  async function commitRename() {
    const id = editingId;
    const name = editName.trim();
    setEditingId(null);
    if (!id || !name) return;
    await actions.renameBoard(id, name);
  }

  async function remove(id: string) {
    const ok = await actions.removeBoard(id);
    if (ok && boardId === id) setBoard("default");
  }

  React.useEffect(
    function () {
      if (!menuOpen) return;
      function close() {
        setMenuOpen(false);
      }
      window.addEventListener("click", close);
      return function () {
        window.removeEventListener("click", close);
      };
    },
    [menuOpen]
  );

  function count(b: Board | undefined): string {
    if (!b) return "";
    const n = active[b.id];
    return n && n > 0 ? String(n) : "";
  }

  function pillInner(b: Board, editing: boolean) {
    if (editing) return null;
    return (
      <>
        <span className="relative">{b.name}</span>
        {count(b) ? <Mono className="relative text-[10.5px] text-muted-foreground">{count(b)}</Mono> : null}
      </>
    );
  }

  const wide = (
    <div
      role="group"
      aria-label="板块"
      data-kedu="boards"
      className="flex max-w-[46%] items-center gap-0.5 overflow-x-auto rounded-full border border-border bg-card p-1 shadow-[0_1px_3px_color-mix(in_oklab,var(--foreground)_8%,transparent)]"
    >
      {boards.map(function (b) {
        const on = b.id === boardId;
        const editing = editingId === b.id;
        return (
          <div key={b.id} className="group/pill relative flex shrink-0 items-center">
            {editing ? (
              <input
                autoFocus
                value={editName}
                onChange={function (e) { setEditName(e.target.value); }}
                onKeyDown={function (e) {
                  if (e.key === "Enter") void commitRename();
                  if (e.key === "Escape") setEditingId(null);
                }}
                onBlur={function () { void commitRename(); }}
                aria-label="板块名"
                className="w-24 rounded-full bg-background px-2.5 py-1 text-xs outline-none ring-1 ring-foreground/30"
              />
            ) : (
              <button
                type="button"
                data-kedu="board"
                data-board={b.id}
                aria-pressed={on}
                onClick={function () { setBoard(b.id); }}
                className={cn(
                  "relative flex items-baseline gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs transition-colors",
                  on ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {on ? (
                  <motion.span
                    layoutId="kedu-board-pill"
                    className="absolute inset-0 rounded-full bg-muted"
                    transition={{ duration: 0.34, ease: EASE }}
                  />
                ) : null}
                {pillInner(b, editing)}
              </button>
            )}
            {!editing && !b.fixed ? (
              <button
                type="button"
                aria-label="改板块名"
                title="改板块名"
                onClick={function (e) {
                  e.stopPropagation();
                  startEdit(b);
                }}
                className="hidden shrink-0 rounded-full px-1 py-0.5 text-[10px] text-muted-foreground hover:text-foreground group-hover/pill:block"
              >
                ✎
              </button>
            ) : null}
            {editing ? (
              <button
                type="button"
                aria-label="删除板块"
                title={count(b) ? "板块里还有任务，先移走" : "删除板块"}
                onClick={function () {
                  setEditingId(null);
                  void remove(b.id);
                }}
                className="ml-0.5 shrink-0 rounded-full px-1 py-0.5 text-[10px] text-muted-foreground hover:text-destructive"
              >
                ✕
              </button>
            ) : null}
          </div>
        );
      })}
      {adding ? (
        <input
          autoFocus
          value={draft}
          placeholder="板块名…"
          onChange={function (e) { setDraft(e.target.value); }}
          onKeyDown={function (e) {
            if (e.key === "Enter") void commitAdd();
            if (e.key === "Escape") {
              setAdding(false);
              setDraft("");
            }
          }}
          onBlur={function () { void commitAdd(); }}
          aria-label="新板块名"
          className="w-24 shrink-0 rounded-full bg-background px-2.5 py-1 text-xs outline-none ring-1 ring-foreground/30"
        />
      ) : (
        <button
          type="button"
          data-kedu="board-add"
          aria-label="新建板块"
          title="新建板块"
          onClick={function () { setAdding(true); }}
          className="shrink-0 rounded-full px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
        >
          ＋
        </button>
      )}
    </div>
  );

  const narrowMenu = (
    <AnimatePresence>
      {menuOpen ? (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.16, ease: "easeOut" }}
          onClick={function (e) { e.stopPropagation(); }}
          className="absolute left-1/2 top-[calc(100%+6px)] z-30 min-w-44 -translate-x-1/2 rounded-xl border border-border bg-card p-1 shadow-lg"
          role="menu"
          aria-label="板块"
        >
          {boards.map(function (b) {
            const on = b.id === boardId;
            return (
              <div key={b.id} className="group/mi flex items-center">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  onClick={function () {
                    setBoard(b.id);
                    setMenuOpen(false);
                  }}
                  className={cn(
                    "flex min-w-0 flex-1 items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs",
                    on ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <span className="truncate">{b.name}</span>
                  {count(b) ? <Mono className="text-[10.5px] text-muted-foreground">{count(b)}</Mono> : null}
                </button>
                {!b.fixed ? (
                  <button
                    type="button"
                    aria-label="改板块名"
                    onClick={function () {
                      setEditingId(b.id);
                      setEditName(b.name);
                      setMenuOpen(false);
                    }}
                    className="hidden shrink-0 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground group-hover/mi:block"
                  >
                    ✎
                  </button>
                ) : null}
              </div>
            );
          })}
          <button
            type="button"
            role="menuitem"
            onClick={function () {
              setAdding(true);
              setMenuOpen(false);
            }}
            className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
          >
            ＋ 新建板块
          </button>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );

  const currentName = (function () {
    for (let i = 0; i < boards.length; i++) if (boards[i].id === boardId) return boards[i].name;
    return "默认";
  })();

  return (
    <div className="absolute left-1/2 top-3 z-20 -translate-x-1/2">
      {props.narrow ? (
        <div className="relative">
          <button
            type="button"
            data-kedu="boards"
            aria-label="切换板块"
            aria-expanded={menuOpen}
            onClick={function (e) {
              e.stopPropagation();
              setMenuOpen(!menuOpen);
            }}
            className="flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs hover:border-foreground/40"
          >
            {currentName}
            {count(boards.find(function (b) { return b.id === boardId; }) as Board) ? (
              <Mono className="text-[10.5px] text-muted-foreground">{count(boards.find(function (b) { return b.id === boardId; }) as Board)}</Mono>
            ) : null}
            <span className="text-[9px] text-muted-foreground">▾</span>
          </button>
          {narrowMenu}
        </div>
      ) : (
        wide
      )}
      {/* 窄面板里点「新建板块」后回到 pills 形态编辑 */}
      {props.narrow && adding ? (
        <div className="absolute left-1/2 top-8 -translate-x-1/2">
          <input
            autoFocus
            value={draft}
            placeholder="板块名…"
            onChange={function (e) { setDraft(e.target.value); }}
            onKeyDown={function (e) {
              if (e.key === "Enter") void commitAdd();
              if (e.key === "Escape") {
                setAdding(false);
                setDraft("");
              }
            }}
            onBlur={function () { void commitAdd(); }}
            aria-label="新板块名"
            className="w-28 rounded-full border border-border bg-card px-2.5 py-1 text-xs outline-none ring-1 ring-foreground/30"
          />
        </div>
      ) : null}
    </div>
  );
}
