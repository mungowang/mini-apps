const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i

export function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
}

export function imageFileFromList(files: FileList | readonly File[] | null): File | null {
  if (!files) return null
  for (const file of files) {
    if (file.type.startsWith("image/") || IMAGE_NAME.test(file.name)) return file
  }
  return null
}

/** WKWebView often puts the image in `files`. WebView2 often puts it in `items`. */
export function imageFileFromClipboard(data: DataTransfer | null): File | null {
  if (!data) return null
  const fromFiles = imageFileFromList(data.files)
  if (fromFiles) return fromFiles
  for (const item of data.items) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue
    const file = item.getAsFile()
    if (file) return file
  }
  return null
}

export function readImageFile(file: File): Promise<{ preview: string; name: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const preview = String(reader.result ?? "")
      if (!preview.startsWith("data:image/")) {
        reject(new Error("只支持 PNG、JPEG、GIF、WebP"))
        return
      }
      resolve({ preview, name: file.name || "剪贴板" })
    }
    reader.onerror = () => reject(reader.error ?? new Error("读取失败"))
    reader.readAsDataURL(file)
  })
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error("这张图打不开"))
    image.src = src
  })
}

export async function writeClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
}

/** Clipboard writes after an awaited model call are no longer a user gesture. WebKit then throws NotAllowedError. */
export function isClipboardBlocked(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false
  const name = "name" in cause ? cause.name : ""
  const message = cause instanceof Error ? cause.message : ""
  return name === "NotAllowedError" || /not allowed by the user agent|denied permission/i.test(message)
}
