// Images are downscaled and re-encoded in the browser before they ever reach storage, so a
// pasted screenshot costs tens of KB instead of megabytes.
export const MAX_EDGE = 1400;
export const JPEG_QUALITY = 0.82;

export type PickedImage = { data: string; w: number; h: number };

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise(function (resolve, reject) {
    const img = new Image();
    img.onload = function () {
      resolve(img);
    };
    img.onerror = function () {
      reject(new Error("图片读取失败"));
    };
    img.src = src;
  });
}

export async function shrinkImage(file: File | Blob): Promise<PickedImage | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext("2d");
    if (!g) return null;
    g.drawImage(img, 0, 0, w, h);
    return { data: canvas.toDataURL("image/jpeg", JPEG_QUALITY), w, h };
  } catch (e) {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// pull every image out of a paste / drop event
export function imageFilesFrom(list: DataTransfer | null): File[] {
  if (!list) return [];
  const out: File[] = [];
  if (list.files && list.files.length) {
    for (let i = 0; i < list.files.length; i++) {
      const f = list.files[i];
      if (f.type.indexOf("image/") === 0) out.push(f);
    }
  }
  if (!out.length && list.items) {
    for (let i = 0; i < list.items.length; i++) {
      const it = list.items[i];
      if (it.kind === "file" && it.type.indexOf("image/") === 0) {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  return out;
}
