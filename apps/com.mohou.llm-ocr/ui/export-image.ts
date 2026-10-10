import type { Region } from "./region.ts"

const MAX_BYTES = 3_500_000
const MAX_SIDE = 2200

export type ExportedImage = {
  mimeType: "image/png" | "image/jpeg"
  data: string
  width: number
  height: number
  scaled: boolean
}

function decodedBytes(data: string): number {
  const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0
  return Math.floor((data.length * 3) / 4) - pad
}

function splitDataUrl(url: string): { mimeType: "image/png" | "image/jpeg"; data: string } {
  const match = /^data:(image\/(?:png|jpeg));base64,([\s\S]+)$/.exec(url)
  if (!match) throw new Error("无法导出图片")
  return { mimeType: match[1] === "image/jpeg" ? "image/jpeg" : "image/png", data: match[2].replace(/\s/g, "") }
}

function paint(
  image: HTMLImageElement,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  scale: number,
  type: "image/png" | "image/jpeg",
  quality?: number,
): ExportedImage {
  const width = Math.max(1, Math.round(sw * scale))
  const height = Math.max(1, Math.round(sh * scale))
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext("2d")
  if (!context) throw new Error("无法裁切这张图")
  context.drawImage(image, sx, sy, sw, sh, 0, 0, width, height)
  const url = type === "image/jpeg" ? canvas.toDataURL(type, quality ?? 0.9) : canvas.toDataURL(type)
  const split = splitDataUrl(url)
  return { ...split, width, height, scaled: scale < 0.999 }
}

export function exportRegion(image: HTMLImageElement, region: Region | null): ExportedImage {
  const naturalW = image.naturalWidth
  const naturalH = image.naturalHeight
  if (!naturalW || !naturalH) throw new Error("这张图还没有准备好")
  const sx = Math.max(0, Math.floor(region?.x ?? 0))
  const sy = Math.max(0, Math.floor(region?.y ?? 0))
  const sw = Math.max(1, Math.min(naturalW - sx, Math.ceil(region?.w ?? naturalW)))
  const sh = Math.max(1, Math.min(naturalH - sy, Math.ceil(region?.h ?? naturalH)))
  let scale = Math.min(1, MAX_SIDE / Math.max(sw, sh))
  let exported = paint(image, sx, sy, sw, sh, scale, "image/png")
  while (decodedBytes(exported.data) > MAX_BYTES && scale > 0.28) {
    scale *= 0.72
    exported = paint(image, sx, sy, sw, sh, scale, "image/png")
  }
  if (decodedBytes(exported.data) > MAX_BYTES) {
    exported = paint(image, sx, sy, sw, sh, scale, "image/jpeg", 0.9)
  }
  if (decodedBytes(exported.data) > MAX_BYTES) {
    exported = paint(image, sx, sy, sw, sh, scale * 0.8, "image/jpeg", 0.82)
  }
  if (decodedBytes(exported.data) > MAX_BYTES) throw new Error("这块区域仍然太大。再框小一点。")
  return exported
}
