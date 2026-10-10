import { useState, type FormEvent } from "react"

import {
  Button,
  ConfirmDialog,
  Icon,
  Input,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Textarea,
} from "@mohou/ui"

import type { TemplateRow } from "../shared/modes.ts"

type Draft = { id: string; name: string; prompt: string }

const EMPTY_DRAFT: Draft = { id: "", name: "", prompt: "" }

export function TemplatesSheet({
  open,
  rows,
  hiddenCount,
  activeId,
  onOpenChange,
  onUse,
  onSave,
  onDelete,
  onMove,
  onRestore,
}: {
  open: boolean
  rows: TemplateRow[]
  hiddenCount: number
  activeId: string
  onOpenChange: (open: boolean) => void
  onUse: (id: string) => void
  onSave: (draft: Draft) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onMove: (id: string, direction: -1 | 1) => Promise<void>
  onRestore: () => Promise<void>
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [pendingDelete, setPendingDelete] = useState<TemplateRow | null>(null)
  const [saving, setSaving] = useState(false)

  function fork(row: TemplateRow) {
    setDraft({ id: "", name: row.name + " 副本", prompt: row.prompt })
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    try {
      await onSave(draft)
      setDraft(EMPTY_DRAFT)
    } catch {
      // The parent surfaces the message.
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" width="420px" className="flex h-full flex-col gap-0">
          <SheetHeader className="border-border border-b px-4 py-4">
            <SheetTitle>识别模板</SheetTitle>
            <SheetDescription>内置也可以删，上下箭头调整顺序。删掉的内置还能恢复。</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-auto px-4 py-2">
            {rows.length === 0 ? (
              <p className="text-muted-foreground py-3 text-sm">模板都去掉了。在下面新建一条，或恢复内置。</p>
            ) : rows.map((row, index) => (
              <div key={row.id} className="flex items-start gap-1 border-b border-border py-2.5">
                <div className="flex shrink-0 flex-col">
                  <Button size="icon-sm" variant="ghost" aria-label={"上移" + row.name} disabled={index === 0} onClick={() => void onMove(row.id, -1)}>
                    <Icon.ChevronUp size={14} />
                  </Button>
                  <Button size="icon-sm" variant="ghost" aria-label={"下移" + row.name} disabled={index === rows.length - 1} onClick={() => void onMove(row.id, 1)}>
                    <Icon.ChevronDown size={14} />
                  </Button>
                </div>
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onUse(row.id)}>
                  <span className="flex items-center gap-1.5 text-sm">
                    {row.title}
                    {row.builtin ? <span className="text-muted-foreground text-[10px]">内置</span> : null}
                    {activeId === row.id ? <Icon.Check size={13} /> : null}
                  </span>
                  <span className="text-muted-foreground mt-0.5 line-clamp-2 block text-xs leading-5">{row.builtin ? row.blurb : row.prompt}</span>
                </button>
                {row.builtin ? (
                  <Button size="sm" variant="ghost" onClick={() => fork(row)}>复制</Button>
                ) : (
                  <Button size="icon-sm" variant="ghost" aria-label={"编辑" + row.name} onClick={() => setDraft({ id: row.id, name: row.name, prompt: row.prompt })}>
                    <Icon.Pencil size={14} />
                  </Button>
                )}
                <Button size="icon-sm" variant="ghost" aria-label={"删除" + row.name} onClick={() => setPendingDelete(row)}>
                  <Icon.Trash2 size={14} />
                </Button>
              </div>
            ))}
            {hiddenCount > 0 ? (
              <Button size="sm" variant="ghost" className="mt-3" onClick={() => void onRestore()}>恢复已删除的内置</Button>
            ) : null}
          </div>
          <form className="border-border flex flex-col gap-2 border-t px-4 py-3" onSubmit={(event) => void submit(event)}>
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">{draft.id ? "编辑模板" : "新模板"}</p>
              {draft.name || draft.prompt ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(EMPTY_DRAFT)}>清空</Button>
              ) : null}
            </div>
            <Input
              value={draft.name}
              placeholder="名称，例如 金额"
              maxLength={24}
              onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
            />
            <Textarea
              value={draft.prompt}
              rows={5}
              placeholder="告诉模型只留下什么。例如：只提取金额和日期，每行一条，不要解释。"
              onChange={(event) => setDraft((prev) => ({ ...prev, prompt: event.target.value }))}
            />
            <Button type="submit" size="sm" disabled={saving}>{draft.id ? "保存修改" : "保存并使用"}</Button>
          </form>
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除这个模板？"
        description={pendingDelete
          ? pendingDelete.builtin
            ? "「" + pendingDelete.title + "」会从列表去掉。需要时可以恢复内置。"
            : "「" + pendingDelete.name + "」会从列表里去掉。"
          : ""}
        confirmLabel="删除"
        onOpenChange={(next) => { if (!next) setPendingDelete(null) }}
        onConfirm={() => {
          const id = pendingDelete?.id
          setPendingDelete(null)
          if (id) void onDelete(id)
        }}
      />
    </>
  )
}
