export type Region = { x: number; y: number; w: number; h: number }

export type Point = { x: number; y: number }

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function normalize(a: Point, b: Point, maxW: number, maxH: number): Region {
  const left = clamp(Math.min(a.x, b.x), 0, maxW)
  const top = clamp(Math.min(a.y, b.y), 0, maxH)
  const right = clamp(Math.max(a.x, b.x), 0, maxW)
  const bottom = clamp(Math.max(a.y, b.y), 0, maxH)
  return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) }
}

export function clampMove(origin: Region, dx: number, dy: number, maxW: number, maxH: number): Region {
  return {
    x: clamp(origin.x + dx, 0, Math.max(0, maxW - origin.w)),
    y: clamp(origin.y + dy, 0, Math.max(0, maxH - origin.h)),
    w: origin.w,
    h: origin.h,
  }
}

export function resize(origin: Region, handle: string, point: Point, maxW: number, maxH: number): Region {
  let x1 = origin.x
  let y1 = origin.y
  let x2 = origin.x + origin.w
  let y2 = origin.y + origin.h
  if (handle.includes("w")) x1 = point.x
  if (handle.includes("e")) x2 = point.x
  if (handle.includes("n")) y1 = point.y
  if (handle.includes("s")) y2 = point.y
  return normalize({ x: x1, y: y1 }, { x: x2, y: y2 }, maxW, maxH)
}

export function nudge(region: Region, key: string, step: number, maxW: number, maxH: number): Region {
  const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0
  const dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0
  return clampMove(region, dx, dy, maxW, maxH)
}

export function inside(point: Point, region: Region): boolean {
  return point.x >= region.x && point.y >= region.y && point.x <= region.x + region.w && point.y <= region.y + region.h
}

export function isTiny(region: Region): boolean {
  return region.w < 8 && region.h < 8
}
