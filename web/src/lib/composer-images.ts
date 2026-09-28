// A pasted image becomes part of the thread database, the history API, and the
// model request. Screenshots that are already small keep their exact pixels;
// larger files are downscaled and re-encoded so one paste stays bounded.
const passthroughTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"])
const passthroughBytes = 1_500_000
const maxSide = 2048
const jpegQuality = 0.85

export function pastedImageFiles(clipboard: DataTransfer | null): File[] {
  return Array.from(clipboard?.items ?? []).flatMap((item) => {
    if (item.kind !== "file" || !item.type.startsWith("image/")) return []
    const file = item.getAsFile()
    return file ? [file] : []
  })
}

export async function inputImageDataUrl(file: File): Promise<string | null> {
  try {
    if (passthroughTypes.has(file.type) && file.size <= passthroughBytes) return await readDataUrl(file)
    return await downscaledDataUrl(file)
  } catch {
    // RECOVERY: an image this browser cannot read or decode is skipped; the
    // other attachments and the text input stay usable.
    return null
  }
}

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error("image could not be read"))
    reader.readAsDataURL(blob)
  })
}

async function downscaledDataUrl(file: File): Promise<string | null> {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext("2d")
    if (!context) return null
    // JPEG has no alpha channel; flatten onto white so transparent pixels stay readable.
    context.fillStyle = "#ffffff"
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", jpegQuality))
    return blob ? await readDataUrl(blob) : null
  } finally {
    bitmap.close()
  }
}
