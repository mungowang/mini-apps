import { inflateRawSync } from "node:zlib"
import type { Sheet } from "../shared/types.ts"

function parseCsv(text: string): Sheet {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++ } else quoted = false
      } else cur += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ",") { row.push(cur.trim()); cur = "" }
    else if (ch === "\n") { row.push(cur.trim()); rows.push(row); row = []; cur = "" }
    else if (ch !== "\r") cur += ch
  }
  if (cur.length || row.length) { row.push(cur.trim()); rows.push(row) }
  const cleaned = rows.filter((item) => item.some((cell) => cell !== ""))
  return { name: "CSV", columns: cleaned[0] ?? [], rows: cleaned.slice(1, 2001) }
}

function unzip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error("不是有效的 Excel 文件")
  const count = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  const files: Record<string, string> = {}
  for (let n = 0; n < count; n++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break
    const method = view.getUint16(offset + 10, true)
    const compSize = view.getUint32(offset + 20, true)
    const nameLen = view.getUint16(offset + 28, true)
    const extraLen = view.getUint16(offset + 30, true)
    const commentLen = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLen))
    const localNameLen = view.getUint16(localOffset + 26, true)
    const localExtraLen = view.getUint16(localOffset + 28, true)
    const start = localOffset + 30 + localNameLen + localExtraLen
    const compressed = bytes.subarray(start, start + compSize)
    const raw = method === 0 ? compressed : inflateRawSync(compressed)
    files[name] = new TextDecoder().decode(raw)
    offset += 46 + nameLen + extraLen + commentLen
  }
  return files
}

function texts(xml: string, tag: string) {
  return [...xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g"))].map((match) => match[1])
}

function decode(value: string) {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&#10;/g, "\n")
}

function sheetRows(xml: string, strings: string[]) {
  return texts(xml, "row").map((row) => {
    const cells = [...row.matchAll(/<c([^>/]*)(?:\/>|>([\s\S]*?)<\/c>)/g)]
    const values: string[] = []
    for (const cell of cells) {
      const ref = /r="([A-Z]+)/.exec(cell[1])?.[1] ?? ""
      const index = ref ? ref.charCodeAt(0) - 65 : values.length
      const type = /t="([^"]+)"/.exec(cell[1])?.[1]
      const inner = cell[2] ?? ""
      const raw = texts(inner, "v")[0] ?? texts(inner, "t")[0] ?? ""
      while (values.length < index) values.push("")
      values[index] = type === "s" ? strings[Number(raw)] ?? "" : decode(raw)
    }
    return values
  }).filter((row) => row.some(Boolean))
}

function xlsxSheets(bytes: Uint8Array): Sheet[] {
  const files = unzip(bytes)
  const book = files["xl/workbook.xml"] ?? ""
  const rels = files["xl/_rels/workbook.xml.rels"] ?? ""
  const shared = texts(files["xl/sharedStrings.xml"] ?? "", "si").map((item) => decode(texts(item, "t").join("")))
  const names = [...book.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)]
  const sheets: Sheet[] = []
  for (const name of names) {
    const target = new RegExp(`Id="${name[2]}"[^>]*Target="([^"]+)"`).exec(rels)?.[1]
    if (!target) continue
    const path = "xl/" + target.replace(/^\//, "").replace(/^xl\//, "").replace(/^\.\.\//, "")
    const matrix = sheetRows(files[path] ?? "", shared)
    if (!matrix.length) continue
    sheets.push({ name: name[1], columns: matrix[0], rows: matrix.slice(1, 2001) })
  }
  return sheets
}

export async function parseWorkbook(bytes: Uint8Array, filename: string): Promise<Sheet[]> {
  if (filename.toLowerCase().endsWith(".csv")) return [parseCsv(new TextDecoder().decode(bytes).replace(/^\uFEFF/, ""))]
  const sheets = xlsxSheets(bytes)
  if (!sheets.length) throw new Error("文件里没有可读的表")
  return sheets
}
