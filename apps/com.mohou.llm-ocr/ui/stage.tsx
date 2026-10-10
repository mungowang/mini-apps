import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"

import { Button, Icon, Kbd } from "@mohou/ui"

import { inside, isTiny, normalize, resize, clampMove, type Point, type Region } from "./region.ts"

type Box = { x: number; y: number; w: number; h: number }
type Handle = "move" | "draw" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw"

type Drag = {
  kind: Handle
  origin: Region
  start: Point
  rect: Region | null
}

const HANDLES: { id: Handle; edge?: string; label: string; className: string; cursor: string }[] = [
  { id: "nw", label: "左上", className: "left-0 top-0 -translate-x-1/2 -translate-y-1/2", cursor: "nwse-resize" },
  { id: "n", edge: "n", label: "上边", className: "left-1/2 top-0 -translate-x-1/2 -translate-y-1/2", cursor: "ns-resize" },
  { id: "ne", label: "右上", className: "right-0 top-0 translate-x-1/2 -translate-y-1/2", cursor: "nesw-resize" },
  { id: "e", edge: "e", label: "右边", className: "right-0 top-1/2 translate-x-1/2 -translate-y-1/2", cursor: "ew-resize" },
  { id: "se", label: "右下", className: "right-0 bottom-0 translate-x-1/2 translate-y-1/2", cursor: "nwse-resize" },
  { id: "s", edge: "s", label: "下边", className: "bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2", cursor: "ns-resize" },
  { id: "sw", label: "左下", className: "bottom-0 left-0 -translate-x-1/2 translate-y-1/2", cursor: "nesw-resize" },
  { id: "w", edge: "w", label: "左边", className: "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2", cursor: "ew-resize" },
]

export function Stage({
  preview,
  name,
  width,
  height,
  selection,
  large,
  running,
  onSelection,
  onRecognizeFull,
  onRecognizeSelection,
  onClearImage,
  onPickFile,
}: {
  preview: string | null
  name: string
  width: number
  height: number
  selection: Region | null
  large: boolean
  running: boolean
  onSelection: (region: Region | null) => void
  onRecognizeFull: () => void
  onRecognizeSelection: () => void
  onClearImage: () => void
  onPickFile: () => void
}) {
  const frame = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const [box, setBox] = useState<Box | null>(null)

  useLayoutEffect(() => {
    const node = frame.current
    if (!node || !preview || !width || !height) {
      setBox(null)
      return
    }
    const measure = () => {
      const rect = node.getBoundingClientRect()
      const scale = Math.min(rect.width / width, rect.height / height)
      const w = width * scale
      const h = height * scale
      setBox({ x: (rect.width - w) / 2, y: (rect.height - h) / 2, w, h })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [preview, width, height])

  function toNatural(localX: number, localY: number): Point | null {
    if (!box || !width || !height) return null
    const x = ((localX - box.x) / box.w) * width
    const y = ((localY - box.y) / box.h) * height
    if (x < -2 || y < -2 || x > width + 2 || y > height + 2) return null
    return {
      x: Math.min(width, Math.max(0, x)),
      y: Math.min(height, Math.max(0, y)),
    }
  }

  function localPoint(event: ReactPointerEvent): Point | null {
    const node = frame.current
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!box || !width) return
    const local = localPoint(event)
    if (!local) return
    const point = toNatural(local.x, local.y)
    if (!point) return
    const handle = (event.target as HTMLElement).closest("[data-handle]")?.getAttribute("data-handle")
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    if (handle && selection) {
      drag.current = { kind: handle as Handle, origin: selection, start: point, rect: selection }
      return
    }
    if (selection && inside(point, selection)) {
      drag.current = { kind: "move", origin: selection, start: point, rect: selection }
      return
    }
    const seed = { x: point.x, y: point.y, w: 0, h: 0 }
    drag.current = { kind: "draw", origin: seed, start: point, rect: seed }
    onSelection(seed)
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current
    if (!current || !width || !height) return
    const local = localPoint(event)
    if (!local) return
    const point = toNatural(local.x, local.y)
    if (!point) return
    let next: Region
    if (current.kind === "draw") next = normalize(current.start, point, width, height)
    else if (current.kind === "move") {
      next = clampMove(current.origin, point.x - current.start.x, point.y - current.start.y, width, height)
    } else next = resize(current.origin, current.kind, point, width, height)
    current.rect = next
    onSelection(next)
  }

  function onPointerUp() {
    const current = drag.current
    drag.current = null
    if (current?.kind === "draw" && current.rect && isTiny(current.rect)) onSelection(null)
  }

  const nearTop = selection ? selection.y / Math.max(height, 1) < 0.08 : false

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col" aria-label="截图">
      <div className="min-h-0 flex-1 p-3">
        <div ref={frame} className="glance-well relative h-full overflow-hidden rounded-xl border border-border">
          {preview && box ? (
            <img
              src={preview}
              alt=""
              draggable={false}
              className="pointer-events-none absolute select-none"
              style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
            />
          ) : null}
          {preview && box ? (
            <div
              className="absolute touch-none"
              style={{ left: box.x, top: box.y, width: box.w, height: box.h, cursor: selection ? "default" : "crosshair" }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              {selection ? (
                <div
                  data-selection="1"
                  className="glance-sel absolute cursor-move"
                  style={{
                    left: `${(selection.x / width) * 100}%`,
                    top: `${(selection.y / height) * 100}%`,
                    width: `${(selection.w / width) * 100}%`,
                    height: `${(selection.h / height) * 100}%`,
                  }}
                  onDoubleClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    onRecognizeSelection()
                  }}
                >
                  <span
                    className={
                      nearTop
                        ? "bg-primary text-primary-foreground pointer-events-none absolute bottom-1 left-1 rounded-full px-1.5 py-0.5 text-[10px] tabular-nums"
                        : "bg-primary text-primary-foreground pointer-events-none absolute -top-6 left-0 rounded-full px-1.5 py-0.5 text-[10px] tabular-nums"
                    }
                  >
                    {Math.round(selection.w)}×{Math.round(selection.h)}
                  </span>
                  {HANDLES.map((handle) => (
                    <button
                      key={handle.id}
                      type="button"
                      data-handle={handle.id}
                      data-edge={handle.edge}
                      aria-label={handle.label}
                      className={"glance-handle " + handle.className}
                      style={{ cursor: handle.cursor }}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <EmptyStage onPickFile={onPickFile} />
          )}
          {preview && large && !selection && !running ? (
            <div className="bg-card absolute inset-x-3 bottom-3 z-20 flex items-center gap-3 rounded-xl border border-border px-3 py-2.5 shadow-sm">
              <div className="min-w-0">
                <p className="text-sm font-medium">这张图比较大</p>
                <p className="text-muted-foreground text-xs">拖一框，只读你要的那一块。普通窗口截图不会停在这里。</p>
              </div>
              <Button size="sm" variant="outline" className="shrink-0" onClick={onRecognizeFull}>仍识别整图</Button>
            </div>
          ) : null}
        </div>
      </div>
      {preview ? (
        <div className="flex items-center gap-2 px-4 pb-2.5 text-xs text-muted-foreground">
          <span className="max-w-[40%] truncate">{name}</span>
          <span className="tabular-nums">{width}×{height}</span>
          <span className="text-foreground">{selection ? "选区" : "整图"}</span>
          <span className="ml-auto flex items-center gap-1">
            {selection ? (
              <Button size="sm" variant="ghost" onClick={() => onSelection(null)}>清除选区</Button>
            ) : null}
            <Button size="icon-sm" variant="ghost" aria-label="清除图片" onClick={onClearImage}>
              <Icon.X size={14} />
            </Button>
          </span>
        </div>
      ) : null}
    </section>
  )
}

function EmptyStage({ onPickFile }: { onPickFile: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <div className="bg-card text-muted-foreground flex size-14 items-center justify-center rounded-2xl border border-border">
        <Icon.Image size={22} strokeWidth={1.5} />
      </div>
      <div className="max-w-xs">
        <p className="text-base font-medium tracking-tight">把截图粘到这里</p>
        <p className="text-muted-foreground mt-1 text-sm leading-6">贴上之后可以框选，只识别指定区域。</p>
      </div>
      <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <Kbd>⌘</Kbd>
        <Kbd>V</Kbd>
        <span>或</span>
        <Kbd>Ctrl</Kbd>
        <Kbd>V</Kbd>
      </div>
      <Button size="sm" variant="outline" onClick={onPickFile}>选择图片</Button>
    </div>
  )
}
