import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useApp } from "@mohou/ui"
import type { ViewDef } from "../shared/types.ts"
import { viewIllustrationAsset } from "../shared/view-illu.ts"

/** Liquid-glass segmented view switcher (collapsed rail). */
export function ViewRailSwitch({
  views,
  activeId,
  onSelect,
}: {
  views: ViewDef[]
  activeId: string
  onSelect: (id: string) => void
}) {
  const { resolveAssetUrl } = useApp()
  const segRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLSpanElement>(null)
  const activeIndex = Math.max(0, views.findIndex((item) => item.id === activeId))
  const prevRef = useRef(activeIndex)
  const stretchTimer = useRef(0)
  const [stretch, setStretch] = useState(false)

  function placeThumb(index: number, travel: boolean) {
    const seg = segRef.current
    const thumb = thumbRef.current
    if (!seg || !thumb) return
    const item = seg.querySelectorAll<HTMLElement>(".view-seg-item")[index]
    if (!item) return
    const left = item.offsetLeft
    // reference: thumb wider than option (84 vs 68) → center under item
    const thumbW = 84
    const x = left + (item.offsetWidth - thumbW) / 2
    if (travel) {
      const prev = parseFloat(thumb.style.left || String(x))
      const goingRight = x >= prev
      thumb.style.transformOrigin = goingRight ? "left center" : "right center"
      thumb.classList.add("is-travel")
      thumb.style.width = thumbW + 10 + "px"
      thumb.style.left = (goingRight ? prev : x - 10) + "px"
      void thumb.offsetWidth
      requestAnimationFrame(() => {
        thumb.style.left = x + "px"
        thumb.style.width = thumbW + "px"
      })
      window.clearTimeout(stretchTimer.current)
      setStretch(true)
      stretchTimer.current = window.setTimeout(() => {
        thumb.classList.remove("is-travel")
        setStretch(false)
      }, 440)
    } else {
      thumb.classList.remove("is-travel")
      thumb.style.left = x + "px"
      thumb.style.width = thumbW + "px"
    }
  }

  useLayoutEffect(() => {
    placeThumb(activeIndex, false)
  }, [views.length])

  useEffect(() => {
    if (activeIndex === prevRef.current) {
      placeThumb(activeIndex, false)
      return
    }
    prevRef.current = activeIndex
    placeThumb(activeIndex, true)
  }, [activeIndex, activeId, views.length])

  useEffect(() => {
    const onResize = () => placeThumb(activeIndex, false)
    window.addEventListener("resize", onResize)
    return () => {
      window.removeEventListener("resize", onResize)
      window.clearTimeout(stretchTimer.current)
    }
  }, [activeIndex])

  if (views.length < 1) return null

  return (
    <div className="view-seg-wrap">
      <div ref={segRef} className="view-seg" role="tablist" aria-label="视图">
        <span
          ref={thumbRef}
          className={"view-seg-thumb" + (stretch ? " is-stretch" : "")}
          aria-hidden="true"
        />
        {views.map((view) => {
          const illu = viewIllustrationAsset(view.illustration, view.id)
          const on = view.id === activeId
          return (
            <button
              key={view.id}
              type="button"
              role="tab"
              aria-selected={on}
              className={"view-seg-item" + (on ? " is-on" : "")}
              onClick={() => onSelect(view.id)}
            >
              <span className="view-seg-face">
                <img src={resolveAssetUrl(illu.path)} alt="" />
              </span>
            </button>
          )
        })}
      </div>
      <div className="view-seg-labels">
        {views.map((view) => (
          <span key={view.id} className={view.id === activeId ? "is-on" : undefined}>
            {view.name}
          </span>
        ))}
      </div>
    </div>
  )
}
