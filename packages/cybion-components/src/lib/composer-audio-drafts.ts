/// 录音不能只活在内存里。一段话讲完，它必须先在本地有一份，之后才谈发不发得出去：
/// 请求失败、刷新页面、浏览器被关掉、扩展侧边栏被收起来，都不该让这段白讲。
///
/// 存储用 IndexedDB 而不是 localStorage：一条几分钟的 Opus 录音是几 MB，而
/// localStorage 只有 5 MB 且是同步写。一条记录管一个输入框（用户 + 线程），值就是
/// 待发的音频数组；发送成功时整条删掉。
const databaseName = "cybion-composer"
const storeName = "audio-drafts"
const databaseVersion = 1

export type AudioDraftClip = { dataUrl: string; createdAt: number }

/// 和草稿文本同一个作用域口径：同一用户、同一线程（新建页算 "new"）共用一个槽。
export function audioDraftScope(userId: string, threadId: string | null): string {
  const scope = threadId === null ? "new" : `thread:${encodeURIComponent(threadId)}`
  return `${encodeURIComponent(userId)}:${scope}`
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T | null> {
  // 存不了（隐私模式、配额用尽、老浏览器）不该把录音流程弄崩：调用方拿 null 继续走。
  if (typeof indexedDB === "undefined") return null
  try {
    const database = await openDatabase()
    return await new Promise<T | null>((resolve, reject) => {
      const transaction = database.transaction(storeName, mode)
      const request = run(transaction.objectStore(storeName))
      request.onsuccess = () => resolve((request.result ?? null) as T | null)
      request.onerror = () => reject(request.error)
      transaction.oncomplete = () => database.close()
      transaction.onabort = () => {
        database.close()
        reject(transaction.error)
      }
    })
  } catch {
    return null
  }
}

/// 这条输入框里还没发出去的录音。读失败就当没有——但绝不清空已有的。
export async function readAudioDrafts(scope: string): Promise<AudioDraftClip[]> {
  const stored = await withStore<AudioDraftClip[]>("readonly", (store) => store.get(scope))
  if (!Array.isArray(stored)) return []
  return stored.filter(
    (clip): clip is AudioDraftClip =>
      typeof clip?.dataUrl === "string" && clip.dataUrl.startsWith("data:audio/") && typeof clip.createdAt === "number",
  )
}

/// 整条覆盖：当前这组待发音频就是真相，空数组等于“没有待发的”，删记录。
export async function writeAudioDrafts(scope: string, clips: AudioDraftClip[]): Promise<void> {
  if (clips.length === 0) {
    await withStore("readwrite", (store) => store.delete(scope))
    return
  }
  await withStore("readwrite", (store) => store.put(clips, scope))
}
