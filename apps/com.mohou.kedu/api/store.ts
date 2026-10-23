import type { Priority, Subtask, Task, TaskImage } from "../shared/types"
import type { Board } from "../shared/types"

/** What ctx.storage and the tx inside transaction() both offer. */
export type Storage = {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>
  run(sql: string, params?: unknown[]): Promise<unknown>
  transaction<T>(work: (tx: Storage) => Promise<T>): Promise<T>
}

const TASK_COLS =
  "id, title, notes, done, priority, starts, due, start_time, end_time, sort_order, created_at, completed_at, doing, doing_at, board_id"

function bool(v: unknown): boolean {
  return v === 1 || v === true
}

function text(v: unknown): string | null {
  return typeof v === "string" ? v : null
}

function int(v: unknown): number | null {
  return typeof v === "number" ? v : null
}

function priority(v: unknown): Priority {
  return v === 1 || v === 2 || v === 3 || v === 4 ? (v as Priority) : 3
}

type Row = Record<string, unknown>

function assemble(rows: Row[], tags: Row[], subs: Row[], imgs: Row[]): Task[] {
  return rows.map(function (r) {
    const id = String(r.id)
    const done = bool(r.done)
    const doing = bool(r.doing) && !done
    return {
      id: id,
      title: String(r.title ?? ""),
      notes: typeof r.notes === "string" ? r.notes : "",
      done: done,
      priority: priority(r.priority),
      tags: tags
        .filter(function (t) { return t.task_id === id })
        .map(function (t) { return String(t.tag) }),
      starts: text(r.starts),
      due: text(r.due),
      startTime: text(r.start_time),
      endTime: text(r.end_time),
      subtasks: subs
        .filter(function (s) { return s.task_id === id })
        .map(function (s): Subtask {
          return {
            id: String(s.id),
            title: String(s.title ?? ""),
            done: bool(s.done),
            completedAt: int(s.completed_at),
          }
        }),
      images: imgs
        .filter(function (i) { return i.task_id === id })
        .map(function (i): TaskImage {
          return { id: String(i.id), w: Number(i.w) || 0, h: Number(i.h) || 0 }
        }),
      order: typeof r.sort_order === "number" ? r.sort_order : 0,
      createdAt: typeof r.created_at === "number" ? r.created_at : 0,
      completedAt: int(r.completed_at),
      doing: doing,
      doingAt: doing ? int(r.doing_at) : null,
      boardId: text(r.board_id),
    }
  })
}

export async function loadTasks(store: Storage): Promise<Task[]> {
  const rows = await store.query(`SELECT ${TASK_COLS} FROM tasks ORDER BY sort_order, created_at`)
  const tags = await store.query("SELECT task_id, tag FROM task_tags ORDER BY tag")
  const subs = await store.query("SELECT id, task_id, title, done, completed_at FROM task_subtasks ORDER BY task_id, pos, id")
  const imgs = await store.query("SELECT id, task_id, w, h FROM task_images ORDER BY task_id, pos, id")
  return assemble(rows, tags, subs, imgs)
}

export async function loadTask(store: Storage, id: string): Promise<Task | null> {
  const rows = await store.query(`SELECT ${TASK_COLS} FROM tasks WHERE id = ?`, [id])
  if (rows.length === 0) return null
  const tags = await store.query("SELECT task_id, tag FROM task_tags WHERE task_id = ? ORDER BY tag", [id])
  const subs = await store.query("SELECT id, task_id, title, done, completed_at FROM task_subtasks WHERE task_id = ? ORDER BY pos, id", [id])
  const imgs = await store.query("SELECT id, task_id, w, h FROM task_images WHERE task_id = ? ORDER BY pos, id", [id])
  const tasks = assemble(rows, tags, subs, imgs)
  return tasks.length > 0 ? (tasks[0] as Task) : null
}

export async function countTasks(store: Storage): Promise<number> {
  const rows = await store.query("SELECT COUNT(*) AS n FROM tasks")
  const first = rows[0] as { n?: unknown } | undefined
  return Number(first && first.n !== undefined ? first.n : 0)
}

/** The fixed 默认 pseudo-board first, then user boards in sort order. */
export async function loadBoards(store: Storage): Promise<Board[]> {
  const rows = await store.query("SELECT id, name FROM boards ORDER BY sort_order, created_at")
  const boards: Board[] = [{ id: "default", name: "默认", fixed: true }]
  for (let i = 0; i < rows.length; i++) {
    boards.push({ id: String(rows[i].id), name: String(rows[i].name), fixed: false })
  }
  return boards
}

/** Next sort slot for a new board. */
export async function nextBoardSort(store: Storage): Promise<number> {
  const rows = await store.query("SELECT MAX(sort_order) AS m FROM boards")
  const first = rows[0] as { m?: unknown } | undefined
  const m = first ? first.m : null
  return (typeof m === "number" ? m : 0) + 1
}

export async function minSortOrder(store: Storage): Promise<number> {
  const rows = await store.query("SELECT MIN(sort_order) AS m FROM tasks")
  const first = rows[0] as { m?: unknown } | undefined
  const m = first ? first.m : null
  return typeof m === "number" ? m : 0
}

async function writeChildren(store: Storage, task: Task): Promise<void> {
  for (let i = 0; i < task.tags.length; i++) {
    await store.run("INSERT INTO task_tags (task_id, tag) VALUES (?, ?)", [task.id, task.tags[i]])
  }
  let pos = 0
  for (let i = 0; i < task.subtasks.length; i++) {
    const s = task.subtasks[i]
    pos += 1
    await store.run(
      "INSERT INTO task_subtasks (id, task_id, pos, title, done, completed_at) VALUES (?, ?, ?, ?, ?, ?)",
      [s.id, task.id, pos, s.title, s.done ? 1 : 0, s.completedAt]
    )
  }
  // task_images rows are owned by imageAdd / imageRemove: they carry the bytes in
  // `data`, which a Task object does not hold. Rewriting them here would drop the data.
}

export async function insertTask(store: Storage, task: Task): Promise<void> {
  await store.run(
    `INSERT INTO tasks (${TASK_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      task.id,
      task.title,
      task.notes,
      task.done ? 1 : 0,
      task.priority,
      task.starts,
      task.due,
      task.startTime,
      task.endTime,
      task.order,
      task.createdAt,
      task.completedAt,
      task.doing && !task.done ? 1 : 0,
      task.doing && !task.done ? task.doingAt : null,
      task.boardId || null,
    ]
  )
  await writeChildren(store, task)
}

export async function persistTask(store: Storage, task: Task): Promise<void> {
  await store.run(
    "UPDATE tasks SET title = ?, notes = ?, done = ?, priority = ?, starts = ?, due = ?, start_time = ?, end_time = ?, sort_order = ?, completed_at = ?, doing = ?, doing_at = ?, board_id = ? WHERE id = ?",
    [
      task.title,
      task.notes,
      task.done ? 1 : 0,
      task.priority,
      task.starts,
      task.due,
      task.startTime,
      task.endTime,
      task.order,
      task.completedAt,
      task.doing && !task.done ? 1 : 0,
      task.doing && !task.done ? task.doingAt : null,
      task.boardId || null,
      task.id,
    ]
  )
  await store.run("DELETE FROM task_tags WHERE task_id = ?", [task.id])
  await store.run("DELETE FROM task_subtasks WHERE task_id = ?", [task.id])
  await writeChildren(store, task)
}

export async function deleteTask(store: Storage, id: string): Promise<void> {
  await store.run("DELETE FROM task_tags WHERE task_id = ?", [id])
  await store.run("DELETE FROM task_subtasks WHERE task_id = ?", [id])
  await store.run("DELETE FROM task_images WHERE task_id = ?", [id])
  await store.run("DELETE FROM tasks WHERE id = ?", [id])
}

export async function clearDoneRows(store: Storage): Promise<void> {
  await store.run("DELETE FROM task_tags WHERE task_id IN (SELECT id FROM tasks WHERE done = 1)")
  await store.run("DELETE FROM task_subtasks WHERE task_id IN (SELECT id FROM tasks WHERE done = 1)")
  await store.run("DELETE FROM task_images WHERE task_id IN (SELECT id FROM tasks WHERE done = 1)")
  await store.run("DELETE FROM tasks WHERE done = 1")
}

export async function clearAllTasks(store: Storage): Promise<void> {
  await store.run("DELETE FROM task_tags")
  await store.run("DELETE FROM task_subtasks")
  await store.run("DELETE FROM task_images")
  await store.run("DELETE FROM tasks")
}

function likePattern(q: string): string {
  const esc = q.replace(/[\\%_]/g, function (ch) { return "\\" + ch })
  return "%" + esc.toLowerCase() + "%"
}

/** SQL-side search: title, notes, tags, subtask titles. */
export async function searchTaskIds(store: Storage, q: string): Promise<string[]> {
  const pat = likePattern(q)
  const rows = await store.query(
    "SELECT t.id FROM tasks t" +
      " WHERE lower(t.title) LIKE ? ESCAPE '\\'" +
      " OR lower(t.notes) LIKE ? ESCAPE '\\'" +
      " OR EXISTS (SELECT 1 FROM task_tags g WHERE g.task_id = t.id AND lower(g.tag) LIKE ? ESCAPE '\\')" +
      " OR EXISTS (SELECT 1 FROM task_subtasks s WHERE s.task_id = t.id AND lower(s.title) LIKE ? ESCAPE '\\')" +
      " ORDER BY t.sort_order, t.created_at",
    [pat, pat, pat, pat]
  )
  return rows.map(function (r) { return String(r.id) })
}
