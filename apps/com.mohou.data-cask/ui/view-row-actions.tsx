import { useEffect, useRef, useState, type ReactElement, type RefObject } from "react"
import { createPortal } from "react-dom"
import { Icon, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@mohou/ui"

export type RowActId = "edit" | "clone" | "delete" | "copy" | "open"

export const ROW_ACTS: { id: RowActId; label: string; side: "left" | "right" }[] = [
  { id: "edit", label: "编辑", side: "left" },
  { id: "clone", label: "克隆", side: "left" },
  { id: "delete", label: "删除", side: "left" },
  { id: "copy", label: "复制", side: "right" },
  { id: "open", label: "跳转", side: "right" },
]

const HIDE_ORDER: RowActId[] = ["open", "delete", "clone", "copy", "edit"]

export function parseRowActPins(raw: unknown): [RowActId, RowActId] {
  const parts = String(raw ?? "edit,copy").split(",").map((item) => item.trim())
  const known = new Set(ROW_ACTS.map((item) => item.id))
  const left = known.has(parts[0] as RowActId) ? (parts[0] as RowActId) : "edit"
  let right = known.has(parts[1] as RowActId) ? (parts[1] as RowActId) : "copy"
  if (right === left) right = ROW_ACTS.find((item) => item.id !== left)?.id ?? "copy"
  return [left, right]
}

function available(canWrite: boolean) {
  return ROW_ACTS.filter((item) => canWrite || item.side === "right").map((item) => item.id)
}

export function resolveRowActPins(raw: unknown, canWrite: boolean): [RowActId, RowActId] {
  const avail = available(canWrite)
  let [left, right] = parseRowActPins(raw)
  if (!avail.includes(left)) left = avail[0] ?? "copy"
  if (!avail.includes(right) || right === left) right = avail.find((id) => id !== left) ?? left
  return [left, right]
}

export function rowActPinWidth(leftInline: number, rightInline: number, leftFold: boolean, rightFold: boolean) {
  // cell pad + glass rail pad + icons + divider + optional chevrons — never grow with table
  // must fit the rendered rail; too-tight width clips sticky actions and causes a stub scrollbar
  const cellPad = 10 + 14
  const railPad = 8 + 8
  const icons = Math.max(leftInline + rightInline, 2) * 28
  const divider = 9
  const chevs = (leftFold ? 16 : 0) + (rightFold ? 16 : 0)
  return cellPad + railPad + icons + divider + chevs
}

const WRITE: RowActId[] = ["edit", "clone", "delete"]
const READ: RowActId[] = ["copy", "open"]

/** Full width: write | read. Narrow: only settings pins + fold chevrons. */
export function layoutRowActs(opts: { sheetW: number; dataMin: number; canWrite: boolean; pins: [RowActId, RowActId] }) {
  const avail = available(opts.canWrite)
  const availSet = new Set(avail)
  const pinPair = resolveRowActPins(opts.pins.join(","), opts.canWrite)
  const writeIds = WRITE.filter((id) => availSet.has(id))
  const readIds = READ.filter((id) => availSet.has(id))
  // full: all write left of rule, all read right — pins ignored
  const fullW = rowActPinWidth(writeIds.length, readIds.length, false, false)
  // safety margin: scrollbar gutter + card chrome so we don't get a 4px phantom H-scroll
  const slack = opts.sheetW > 0 ? opts.sheetW - opts.dataMin - 28 : fullW
  if (slack >= fullW) {
    return {
      mode: "full" as const,
      pins: pinPair,
      hidden: [] as RowActId[],
      leftInline: writeIds,
      rightInline: readIds,
      leftHidden: [] as RowActId[],
      rightHidden: [] as RowActId[],
      pinW: rowActPinWidth(writeIds.length, readIds.length, false, false),
    }
  }

  // narrow / folded: only the two configured pins stay visible
  const hideable = HIDE_ORDER.filter((id) => availSet.has(id) && !pinPair.includes(id))
  const hidden = hideable
  const emerged = emergeSides(pinPair, hidden)
  return {
    mode: "narrow" as const,
    pins: pinPair,
    hidden,
    leftInline: [] as RowActId[],
    rightInline: [] as RowActId[],
    leftHidden: emerged.left,
    rightHidden: emerged.right,
    pinW: rowActPinWidth(0, 0, emerged.left.length > 0, emerged.right.length > 0),
  }
}

function familyOf(id: RowActId) {
  return WRITE.includes(id) ? "write" : "read"
}

function emergeSides(pins: [RowActId, RowActId], hidden: RowActId[]) {
  const [pinL, pinR] = pins
  const writeSide = familyOf(pinL) === "write" && familyOf(pinR) !== "write"
    ? "left"
    : familyOf(pinR) === "write" && familyOf(pinL) !== "write"
      ? "right"
      : familyOf(pinL) === "write" ? "left" : null
  const readSide = familyOf(pinL) === "read" && familyOf(pinR) !== "read"
    ? "left"
    : familyOf(pinR) === "read" && familyOf(pinL) !== "read"
      ? "right"
      : familyOf(pinR) === "read" ? "right" : null
  const left: RowActId[] = []
  const right: RowActId[] = []
  for (const id of hidden) {
    const side = familyOf(id) === "write" ? (writeSide ?? "left") : (readSide ?? "right")
    if (side === "left") left.push(id)
    else right.push(id)
  }
  return {
    left: orderOutside(left, "left"),
    right: orderOutside(right, "right"),
  }
}

function orderOutside(ids: RowActId[], side: "left" | "right") {
  const fam = ids.some((id) => familyOf(id) === "write") && !ids.some((id) => familyOf(id) === "read") ? WRITE : READ
  const sorted = [...ids].sort((a, b) => fam.indexOf(a) - fam.indexOf(b))
  return side === "left" ? sorted : sorted
}

function ActIcon({ id, size = 15 }: { id: RowActId; size?: number }) {
  if (id === "edit") return <Icon.Pencil size={size} />
  if (id === "clone") return <Icon.CopyPlus size={size} />
  if (id === "delete") return <Icon.Trash2 size={size} />
  if (id === "copy") return <Icon.Copy size={size} />
  return <Icon.ArrowUpRight size={size} />
}

function Chev({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {dir === "left" ? (
        <>
          <path d="M9 4 5.5 8 9 12" />
          <path d="M13 4 9.5 8 13 12" />
        </>
      ) : (
        <>
          <path d="M7 4 10.5 8 7 12" />
          <path d="M3 4 6.5 8 3 12" />
        </>
      )}
    </svg>
  )
}

function labelOf(id: RowActId) {
  return ROW_ACTS.find((item) => item.id === id)?.label ?? id
}

const TIPS: Record<RowActId, string> = {
  edit: "编辑",
  clone: "克隆为新记录",
  delete: "删除",
  copy: "复制整行",
  open: "在数据中打开",
}

function ActTip({ id, children }: { id: RowActId; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger delay={120} closeDelay={80} render={children} />
      <TooltipContent side="top" sideOffset={6}>{TIPS[id]}</TooltipContent>
    </Tooltip>
  )
}

function RailButton({ id, onRun }: { id: RowActId; onRun: (id: RowActId) => void }) {
  return (
    <ActTip id={id}>
    <button
      type="button"
      className={"grid h-7 w-7 place-items-center rounded-lg text-muted-foreground hover:bg-foreground/5 hover:text-foreground " + (id === "delete" ? "hover:text-destructive" : "")}
      aria-label={TIPS[id]}
      onClick={() => onRun(id)}
    >
      <ActIcon id={id} />
    </button>
    </ActTip>
  )
}

function PopButton({ id, side, onRun }: { id: RowActId; side: "left" | "right"; onRun: (id: RowActId) => void }) {
  return (
    <ActTip id={id}>
      <button
        type="button"
        className={"view-act-pop" + (id === "delete" ? " is-danger" : "")}
        data-side={side}
        aria-label={TIPS[id]}
        onClick={() => onRun(id)}
      >
        <ActIcon id={id} />
      </button>
    </ActTip>
  )
}

const GLASS_CSS = `
.view-act-glass {
  position: fixed;
  z-index: 80;
  display: flex;
  align-items: stretch;
  height: 44px;
  border-radius: 999px;
  overflow: hidden;
  pointer-events: none;
  background:
    linear-gradient(180deg, rgba(255,255,255,.5) 0%, rgba(255,252,247,.2) 46%, rgba(255,255,255,.08) 100%);
  backdrop-filter: blur(22px) saturate(1.8);
  -webkit-backdrop-filter: blur(22px) saturate(1.8);
  border: 1px solid rgba(255,255,255,.66);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.82),
    inset 0 -10px 14px rgba(28,25,22,.04),
    0 12px 28px rgba(28,25,22,.1);
}
.view-act-wing { pointer-events: auto; display: flex; align-items: center; justify-content: center; gap: 6px; flex: none; }
.view-act-wing.is-left { padding: 0 2px 0 8px; }
.view-act-wing.is-right { padding: 0 8px 0 2px; }
.view-act-hole { flex: none; pointer-events: none; }
.view-act-pop {
  width: 30px; height: 30px; border: 0; border-radius: 9px; background: transparent;
  color: #3f3a34; display: grid; place-items: center; cursor: pointer;
}
.view-act-pop:hover { background: rgba(28,25,22,.06); color: #1c1916; }
.view-act-lane {
  position: fixed;
  z-index: 79;
  pointer-events: auto;
  border-radius: 999px;
}
.view-act-drop {
  position: fixed;
  z-index: 80;
  width: 36px;
  height: 36px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 99em;
  display: grid;
  place-items: center;
  color: #3f3a34;
  cursor: pointer;
  pointer-events: auto;
  background-color: color-mix(in srgb, #d4c8b8 42%, transparent);
  backdrop-filter: blur(10px) saturate(140%);
  -webkit-backdrop-filter: blur(10px) saturate(140%);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, #fff 14%, transparent),
    inset 2px 1px 0 -1px color-mix(in srgb, #fff 70%, transparent),
    inset -1.5px -1px 0 -1px color-mix(in srgb, #fff 55%, transparent),
    inset -2px -6px 1px -5px color-mix(in srgb, #fff 35%, transparent),
    inset -1px 2px 3px -1px color-mix(in srgb, #1c1916 12%, transparent),
    inset 0 -4px 1px -2px color-mix(in srgb, #1c1916 8%, transparent),
    0 3px 6px 0 color-mix(in srgb, #1c1916 8%, transparent);
  transform: translate(-50%, -50%);
}
.view-act-drop:hover { color: #1c1916; }
.view-act-drop.is-danger:hover { color: #a63d32; }
.view-act-glass::before {
  content: "";
  position: absolute;
  left: 12px;
  right: 12px;
  top: 2px;
  height: 46%;
  border-radius: 999px;
  background: linear-gradient(180deg, rgba(255,255,255,.78), rgba(255,255,255,0));
  pointer-events: none;
}
.view-act-glass::after {
  content: "";
  position: absolute;
  left: 22%;
  right: 22%;
  bottom: 1px;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,.85), transparent);
  pointer-events: none;
}
.view-act-ico {
  position: relative;
  z-index: 1;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: #4a453f;
  display: grid;
  place-items: center;
  cursor: pointer;
}
.view-act-ico:hover { background: rgba(28,25,22,.06); color: #1c1916; }
.view-act-ico.is-danger:hover { background: rgba(166,61,50,.1); color: #a63d32; }
.view-act-rule {
  width: 1px;
  height: 16px;
  margin: 0 6px;
  background: rgba(28,25,22,.16);
  flex: none;
}
:root[data-mode="dark"] .view-act-pop,
:root[data-mode="dark"] .view-act-drop,
:root[data-mode="dark"] .view-act-ico {
  color: color-mix(in oklab, var(--foreground) 92%, transparent);
}
:root[data-mode="dark"] .view-act-pop:hover,
:root[data-mode="dark"] .view-act-ico:hover {
  background: color-mix(in oklab, var(--foreground) 10%, transparent);
  color: var(--foreground);
}
:root[data-mode="dark"] .view-act-drop:hover {
  color: var(--foreground);
}
:root[data-mode="dark"] .view-act-pop.is-danger:hover,
:root[data-mode="dark"] .view-act-drop.is-danger:hover,
:root[data-mode="dark"] .view-act-ico.is-danger:hover {
  color: var(--destructive);
}
:root[data-mode="dark"] .view-act-rule {
  background: color-mix(in oklab, var(--foreground) 32%, transparent);
}
`

function ensureGlassCss() {
  if (typeof document === "undefined") return
  let style = document.getElementById("view-act-glass-css")
  if (!style) {
    style = document.createElement("style")
    style.id = "view-act-glass-css"
    document.head.appendChild(style)
  }
  if (style.textContent !== GLASS_CSS) style.textContent = GLASS_CSS
}

export function ViewRowActBar({
  layout,
  onRun,
}: {
  layout: ReturnType<typeof layoutRowActs>
  onRun: (id: RowActId) => void
}) {
  const railRef = useRef<HTMLDivElement>(null)
  const trayRef = useRef<HTMLDivElement>(null)
  const timer = useRef(0)
  const [phase, setPhase] = useState<"in" | "out" | null>(null)
  const [box, setBox] = useState<DOMRect | null>(null)
  const folded = layout.leftHidden.length + layout.rightHidden.length > 0

  function measure() {
    const el = railRef.current
    if (!el) return
    setBox(el.getBoundingClientRect())
  }
  function markHot(on: boolean) {
    const row = railRef.current?.closest("tr")
    if (!row) return
    if (on) {
      // only one hot row — clear leftovers from fast pointer hops
      row.closest("tbody")?.querySelectorAll("tr.is-act-hot").forEach((el) => {
        if (el !== row) el.classList.remove("is-act-hot")
      })
      row.classList.add("is-act-hot")
    } else {
      row.classList.remove("is-act-hot")
    }
  }
  function show() {
    window.clearTimeout(timer.current)
    // full mode: CSS :hover is enough; is-act-hot only while glass is needed
    if (folded) markHot(true)
    if (!folded) return
    measure()
    setPhase("in")
  }
  function stillInside(next: EventTarget | null) {
    if (!(next instanceof Node)) return false
    const row = railRef.current?.closest("tr")
    // keep hot while pointer stays on this row or glass tray (portal)
    return !!row?.contains(next) || !!trayRef.current?.contains(next)
  }
  function leave(next: EventTarget | null) {
    if (stillInside(next)) return
    markHot(false)
    window.clearTimeout(timer.current)
    setPhase((current) => current ? "out" : null)
  }
  // always clear sticky hot when pointer leaves the row (full + folded)
  useEffect(() => {
    const row = railRef.current?.closest("tr")
    if (!row) return
    const onRowLeave = (event: PointerEvent) => leave(event.relatedTarget)
    row.addEventListener("pointerleave", onRowLeave)
    return () => {
      row.removeEventListener("pointerleave", onRowLeave)
      row.classList.remove("is-act-hot")
    }
  }, [])
  useEffect(() => {
    if (!phase) return
    const scroller = railRef.current?.closest(".overflow-auto")
    const onScroll = () => measure()
    scroller?.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("resize", onScroll)
    return () => {
      scroller?.removeEventListener("scroll", onScroll)
      window.removeEventListener("resize", onScroll)
    }
  }, [phase])

  return (
    <TooltipProvider delay={120}>
    <>
      <div
        ref={railRef}
        className={"view-act-rail relative z-[3] mx-auto inline-flex h-8 items-center justify-center " + (folded ? "is-fold " : "") + (phase === "in" ? "is-open" : "")}
        onPointerEnter={show}
        onPointerLeave={(event) => {
          if (stillInside(event.relatedTarget)) return
          leave(event.relatedTarget)
        }}
      >
        {layout.mode === "full" ? (
          <>
            {layout.leftInline.map((id) => <RailButton key={id} id={id} onRun={onRun} />)}
            {layout.leftInline.length > 0 && layout.rightInline.length > 0 && (
              <span className="mx-1 h-2.5 w-px bg-border" aria-hidden="true" />
            )}
            {layout.rightInline.map((id) => <RailButton key={id} id={id} onRun={onRun} />)}
          </>
        ) : (
          <>
            {layout.leftHidden.length > 0 && (
              <span className={"grid h-7 w-3.5 place-items-center text-muted-foreground/80 " + (phase === "in" ? "invisible" : "")} aria-hidden="true"><Chev dir="left" /></span>
            )}
            <RailButton id={layout.pins[0]} onRun={onRun} />
            <span className="mx-1 h-2.5 w-px bg-border" aria-hidden="true" />
            <RailButton id={layout.pins[1]} onRun={onRun} />
            {layout.rightHidden.length > 0 && (
              <span className={"grid h-7 w-3.5 place-items-center text-muted-foreground/80 " + (phase === "in" ? "invisible" : "")} aria-hidden="true"><Chev dir="right" /></span>
            )}
          </>
        )}
      </div>
      {phase && box && folded ? (
        <GlassWings
          trayRef={trayRef}
          box={box}
          phase={phase}
          left={layout.leftHidden}
          right={layout.rightHidden}
          onRun={(id) => {
            setPhase(null)
            onRun(id)
          }}
          onEnter={() => window.clearTimeout(timer.current)}
          onLeave={(event) => leave(event.relatedTarget)}
          onExited={() => setPhase(null)}
        />
      ) : null}
    </>
    </TooltipProvider>
  )
}

function GlassWings({
  trayRef,
  box,
  phase,
  left,
  right,
  onRun,
  onEnter,
  onLeave,
  onExited,
}: {
  trayRef: RefObject<HTMLDivElement | null>
  box: DOMRect
  phase: "in" | "out"
  left: RowActId[]
  right: RowActId[]
  onRun: (id: RowActId) => void
  onEnter: () => void
  onLeave: (event: { relatedTarget: EventTarget | null }) => void
  onExited: () => void
}) {
  ensureGlassCss()
  const y = box.top + box.height / 2
  const fitted = fitEmerge(left, right, window.innerWidth - box.right)
  const drops = [
    ...placeDrops(fitted.left, "left", box),
    ...placeDrops(fitted.right, "right", box),
  ]
  const leftDrops = drops.filter((drop) => drop.side === "left")
  const rightDrops = drops.filter((drop) => drop.side === "right")
  const lanes = [
    leftDrops.length ? { left: Math.min(...leftDrops.map((drop) => drop.x)) - 28, right: box.left + 10 } : null,
    rightDrops.length ? { left: box.right - 10, right: Math.max(...rightDrops.map((drop) => drop.x)) + 28 } : null,
  ].filter((lane): lane is { left: number; right: number } => !!lane && lane.right > lane.left)
  useEffect(() => {
    const root = trayRef.current
    if (!root) return
    const buttons = [...root.querySelectorAll<HTMLButtonElement>(".view-act-drop")]
    const motions = buttons.map((btn) => {
      const slot = Number(btn.dataset.x)
      const edge = Number(btn.dataset.edge)
      const delay = Number(btn.dataset.delay)
      const point = btn.dataset.side === "left" ? "46% 70% 70% 46%" : "70% 46% 46% 70%"
      return btn.animate(phase === "in"
        ? [
            { left: edge + "px", opacity: 0, transform: "translate(-50%, -50%) scale(.2)", borderRadius: point },
            { left: (edge + (slot - edge) * 0.62) + "px", opacity: 1, transform: "translate(-50%, -50%) scale(1.12, .86)", borderRadius: "50%", offset: 0.58 },
            { left: slot + "px", opacity: 1, transform: "translate(-50%, -50%) scale(1)", borderRadius: "50%" },
          ]
        : [
            { left: slot + "px", opacity: 1, transform: "translate(-50%, -50%) scale(1)", borderRadius: "50%" },
            { left: edge + "px", opacity: 0, transform: "translate(-50%, -50%) scale(.2)", borderRadius: point },
          ], {
        duration: phase === "in" ? 520 : 260,
        delay: phase === "in" ? delay : 0,
        easing: phase === "in" ? "cubic-bezier(.18, .86, .22, 1)" : "cubic-bezier(.4, 0, 1, 1)",
        fill: "forwards",
      })
    })
    if (phase === "out") {
      const last = motions[motions.length - 1]
      if (last) last.onfinish = () => onExited()
      else onExited()
    }
    return () => motions.forEach((motion) => motion.cancel())
  }, [phase, box.left, box.top, box.width])

  const node = (
    <div ref={trayRef} style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 80 }}>
      {lanes.map((lane) => (
        <div
          key={lane.left}
          className="view-act-lane"
          style={{ left: lane.left, top: y - 26, width: lane.right - lane.left, height: 52 }}
          onPointerEnter={onEnter}
          onPointerLeave={onLeave}
        />
      ))}
      {drops.map((drop) => (
        <ActTip key={drop.id} id={drop.id}>
        <button
          type="button"
          className={"view-act-drop" + (drop.id === "delete" ? " is-danger" : "")}
          data-side={drop.side}
          data-x={drop.x}
          data-edge={drop.edge}
          data-delay={drop.delay}
          style={{ left: drop.edge, top: y }}
          aria-label={TIPS[drop.id]}
          onClick={() => onRun(drop.id)}
          onPointerEnter={onEnter}
          onPointerLeave={onLeave}
        >
          <ActIcon id={drop.id} />
        </button>
        </ActTip>
      ))}
    </div>
  )
  if (typeof document === "undefined") return node
  return createPortal(node, document.body)
}

function fitEmerge(left: RowActId[], right: RowActId[], roomRight: number) {
  const canRight = roomRight >= 48 ? 1 : 0
  return { left: [...left, ...right.slice(canRight)], right: right.slice(0, canRight) }
}

function placeDrops(ids: RowActId[], side: "left" | "right", box: DOMRect) {
  const size = 34
  const gap = 8
  return ids.map((id, index) => {
    const fromRail = side === "left" ? ids.length - index : index + 1
    const x = side === "left"
      ? box.left - fromRail * (size + gap) + size / 2
      : box.right + fromRail * (size + gap) - size / 2
    return {
      id,
      side,
      x,
      edge: side === "left" ? box.left - 2 : box.right + 2,
      delay: (fromRail - 1) * 55,
    }
  })
}

