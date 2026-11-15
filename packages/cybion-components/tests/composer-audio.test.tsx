import { act, render, renderHook, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ComposerAudio } from "../src/components/composer-audio"
import { useComposerAudio } from "../src/hooks/use-composer-audio"

// jsdom 既没有麦克风也没有 MediaRecorder：这里给一个能 start/stop 的假实现，
// 让「录完 → 收尾 → 交出 data URL」这条链在测试里真的走一遍。
class FakeMediaRecorder {
  state: "inactive" | "recording" = "inactive"
  mimeType = "audio/webm"
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly stream: unknown) {}
  start() {
    this.state = "recording"
  }
  stop() {
    this.state = "inactive"
    if (this.chunk) this.ondataavailable?.({ data: this.chunk })
    this.onstop?.()
  }
  /** 下一次 stop 时上报的音频块；不设就是「什么都没录到」。 */
  chunk: Blob | null = null
}

let recorders: FakeMediaRecorder[] = []

function installMicrophone(getUserMedia: () => Promise<unknown>) {
  recorders = []
  class Recording extends FakeMediaRecorder {
    constructor(stream: unknown) {
      super(stream)
      recorders.push(this)
    }
  }
  window.MediaRecorder = Recording as unknown as typeof window.MediaRecorder
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(getUserMedia) },
  })
}

const fakeStream = () => ({ getTracks: () => [{ stop: vi.fn() }] })
const denial = () => Object.assign(new Error("denied"), { name: "NotAllowedError" })

beforeEach(() => {
  installMicrophone(async () => fakeStream())
})

describe("useComposerAudio", () => {
  it("explains a refused microphone instead of doing nothing", async () => {
    installMicrophone(async () => {
      throw denial()
    })
    const { result } = renderHook(() => useComposerAudio())
    await act(async () => {
      expect(await result.current.start()).toBe(false)
    })
    expect(result.current.error).toBe("denied")
    expect(result.current.phase).toBe("idle")
    expect(result.current.recording).toBe(false)
  })

  it("hands a finished take back as a data URL and returns to idle", async () => {
    const { result } = renderHook(() => useComposerAudio())
    await act(async () => {
      await result.current.start()
    })
    expect(result.current.phase).toBe("recording")
    expect(result.current.recording).toBe(true)
    recorders[0].chunk = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" })
    let clip: string | null = null
    await act(async () => {
      clip = await result.current.finish()
    })
    expect(clip).toMatch(/^data:audio\//)
    expect(result.current.phase).toBe("idle")
    expect(result.current.error).toBeNull()
  })

  it("says so when a take captured nothing", async () => {
    const { result } = renderHook(() => useComposerAudio())
    await act(async () => {
      await result.current.start()
    })
    let clip: string | null = "unset"
    await act(async () => {
      clip = await result.current.finish()
    })
    expect(clip).toBeNull()
    // 以前这里静默返回 null，用户以为发出去了。
    expect(result.current.error).toBe("empty")
  })

  it("parks a recorded clip as an attachment so a failed send keeps it", async () => {
    const { result } = renderHook(() => useComposerAudio())
    await act(async () => {
      result.current.attach("data:audio/webm;base64,AAAA")
    })
    expect(result.current.audios).toEqual(["data:audio/webm;base64,AAAA"])
    await act(async () => {
      result.current.clear()
    })
    expect(result.current.audios).toEqual([])
  })

  it("discards a cancelled take without blaming the user", async () => {
    const { result } = renderHook(() => useComposerAudio())
    await act(async () => {
      await result.current.start()
    })
    recorders[0].chunk = new Blob([new Uint8Array([9])], { type: "audio/webm" })
    await act(async () => {
      result.current.cancel()
    })
    expect(result.current.phase).toBe("idle")
    expect(result.current.error).toBeNull()
    expect(result.current.audios).toEqual([])
  })

  it("counts the seconds while it is recording", async () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useComposerAudio())
      await act(async () => {
        await result.current.start()
      })
      expect(result.current.elapsed).toBe(0)
      await act(async () => {
        vi.advanceTimersByTime(2400)
      })
      expect(result.current.elapsed).toBeGreaterThanOrEqual(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("ComposerAudio", () => {
  const base = { language: "zh" as const, recording: false, disabled: false, onStart: async () => true, onSend: () => undefined, onCancel: () => undefined }

  it("shows that the browser is asking for the microphone", () => {
    render(<ComposerAudio {...base} phase="starting" />)
    expect(screen.getByText(/正在请求麦克风/)).toBeTruthy()
  })

  it("shows a running clock while recording", () => {
    render(<ComposerAudio {...base} recording phase="recording" elapsed={42} />)
    expect(screen.getByText(/正在录音 0:42/)).toBeTruthy()
    expect(screen.getByLabelText("发送语音")).toBeTruthy()
  })

  it("shows the take being prepared rather than a dead button", () => {
    render(<ComposerAudio {...base} phase="finalizing" />)
    expect(screen.getByText(/正在处理录音/)).toBeTruthy()
  })
})
