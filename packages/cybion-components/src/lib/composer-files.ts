import type { Language } from "../api"
import { formatBytes } from "./format"

// A picked file that travels as text. The model reads bytes directly only as
// images and audio, so a document, a log or a source file becomes a fenced block
// in the message: the composer shows a chip, the request carries the content, and
// history shows exactly what was sent.
export type ComposerFile = {
  name: string
  /// The size on disk, so a chip keeps telling the truth once the text is cut.
  bytes: number
  text: string
  truncated: boolean
}

/// Why a picked file never became an attachment; the composer says so instead of
/// dropping it silently.
export type SkippedFileReason = "type" | "size" | "count" | "room"
export type SkippedFile = { name: string; reason: SkippedFileReason }

/// A message carries a few attachments, not a directory.
export const maxComposerFiles = 8
/// Bigger than this is refused rather than read into memory and cut.
export const maxComposerFileBytes = 2 * 1024 * 1024
/// One attachment never sends more than this many characters.
export const maxComposerFileChars = 30_000
/// All attachments of one message together.
export const maxComposerChars = 60_000
/// Below this much room a file is noise instead of content, so it is refused.
export const minComposerFileChars = 1_000
/// The Controller rejects a longer input; typed text and attachments share it.
export const maxInputChars = 100_000

// Recognised by MIME type first and by extension second: the browser reports an
// empty type for plenty of the files people actually attach.
const textExtensions = new Set([
  "txt", "text", "md", "markdown", "mdx", "rst", "org", "csv", "tsv", "json", "jsonl", "ndjson",
  "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "log", "xml", "html", "htm", "css", "scss",
  "sass", "less", "js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts", "vue", "svelte", "astro",
  "py", "pyi", "rs", "go", "java", "kt", "kts", "c", "h", "cc", "cpp", "cxx", "hpp", "cs", "rb",
  "php", "pl", "pm", "lua", "r", "jl", "swift", "m", "mm", "dart", "scala", "clj", "cljs", "ex",
  "exs", "erl", "hrl", "hs", "elm", "zig", "nim", "sql", "graphql", "gql", "proto", "diff",
  "patch", "tex", "bib", "srt", "vtt", "properties", "gradle", "cmake", "sh", "bash", "zsh",
  "fish", "ps1", "bat", "awk", "sed", "mk", "lock", "svg",
])
const textMediaTypes = new Set([
  "application/json", "application/ld+json", "application/xml", "application/xhtml+xml",
  "application/javascript", "application/ecmascript", "application/x-yaml", "application/yaml",
  "application/toml", "application/x-sh", "application/sql", "application/graphql",
  "application/x-httpd-php", "application/x-ndjson", "application/rtf",
])

function extensionOf(name: string) {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}

/// Pictures keep their own path (thumbnail, downscale, image part). SVG is markup
/// the image path would re-encode into a bitmap, so it travels as text instead.
export function isImagePickedFile(file: File) {
  return file.type.startsWith("image/") && file.type !== "image/svg+xml"
}

export function isAudioSelectedFile(file: File) {
  return file.type.startsWith("audio/")
}

export function isTextPickedFile(file: File) {
  const type = file.type.toLowerCase()
  if (type.startsWith("text/")) return true
  if (textMediaTypes.has(type.split(";")[0].trim())) return true
  if (type !== "" && !type.startsWith("image/") && !type.startsWith("audio/") && type !== "application/octet-stream") {
    // A declared type the browser knows and we do not recognise as text: trust it
    // over the extension, so a .pdf stays unsupported and a typeless .md works.
    return false
  }
  return textExtensions.has(extensionOf(file.name))
}

export function splitPickedFiles(picked: File[]) {
  const images: File[] = []
  const audios: File[] = []
  const texts: File[] = []
  const unsupported: string[] = []
  for (const file of picked) {
    if (isImagePickedFile(file)) images.push(file)
    else if (isAudioSelectedFile(file)) audios.push(file)
    else if (isTextPickedFile(file)) texts.push(file)
    else unsupported.push(file.name)
  }
  return { images, audios, texts, unsupported }
}

/// Decodes the text as UTF-8 and cuts it to `budget` characters. Returns null for
/// anything the browser cannot read as text, which is how a binary file that
/// slipped past the extension check stays out of the message.
export async function readComposerFile(file: File, budget: number): Promise<ComposerFile | null> {
  const limit = Math.min(maxComposerFileChars, Math.max(0, budget))
  if (limit === 0) return null
  const text = await readText(file)
  if (text === null) return null
  const truncated = text.length > limit
  return { name: file.name || "attachment", bytes: file.size, text: truncated ? text.slice(0, limit) : text, truncated }
}

function readText(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsText(file)
  })
}

export function composerFileChars(files: ComposerFile[]) {
  return files.reduce((total, file) => total + file.text.length, 0)
}

/// Longer than the shortest run of backticks inside, so a file that itself holds a
/// fence cannot end its own block.
function fenceFor(text: string) {
  let longest = 0
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  return "`".repeat(Math.max(3, longest + 1))
}

const fenceLanguages: Record<string, string> = {
  bash: "bash", c: "c", cc: "cpp", cfg: "ini", clj: "clojure", cmake: "cmake", conf: "ini",
  cpp: "cpp", cs: "csharp", css: "css", csv: "csv", cxx: "cpp", dart: "dart", diff: "diff",
  elm: "elm", erl: "erlang", ex: "elixir", exs: "elixir", fish: "fish", go: "go", gql: "graphql",
  graphql: "graphql", gradle: "groovy", h: "c", hpp: "cpp", hs: "haskell", htm: "html",
  html: "html", ini: "ini", java: "java", js: "js", json: "json", jsonl: "json", jsx: "jsx",
  kt: "kotlin", kts: "kotlin", less: "less", lua: "lua", m: "objective-c", markdown: "markdown",
  md: "markdown", mdx: "markdown", mjs: "js", mm: "objective-c", ndjson: "json", php: "php",
  pl: "perl", proto: "protobuf", ps1: "powershell", py: "python", pyi: "python", r: "r",
  rb: "ruby", rs: "rust", sass: "scss", scala: "scala", scss: "scss", sh: "bash", sql: "sql",
  svelte: "svelte", svg: "xml", swift: "swift", tex: "latex", toml: "toml", ts: "ts",
  tsv: "tsv", tsx: "tsx", txt: "text", vue: "vue", xml: "xml", yaml: "yaml", yml: "yaml",
  zig: "zig", zsh: "bash",
}

function fenceLanguage(name: string) {
  return fenceLanguages[extensionOf(name)] ?? ""
}

/// One attachment as the model receives it: a heading that names the file and its
/// size, then the content in a fence long enough to survive what is inside.
export function attachmentBlock(file: ComposerFile, language: Language) {
  const fence = fenceFor(file.text)
  const size = formatBytes(file.bytes)
  const cut = file.truncated
    ? language === "zh" ? `，仅前 ${file.text.length} 字符` : `, first ${file.text.length} characters`
    : ""
  const heading = language === "zh" ? `附件：${file.name}（${size}${cut}）` : `Attachment: ${file.name} (${size}${cut})`
  return `${heading}\n${fence}${fenceLanguage(file.name)}\n${file.text.replace(/\n+$/, "")}\n${fence}`
}

/// What actually goes to the Controller: the typed text, then one block per
/// attachment. An attachment-only message is legitimate, so the typed text may be
/// empty.
export function composeComposerInput(input: string, files: ComposerFile[], language: Language) {
  const typed = input.trim()
  if (files.length === 0) return typed
  return [typed, ...files.map((file) => attachmentBlock(file, language))].filter((part) => part !== "").join("\n\n")
}
