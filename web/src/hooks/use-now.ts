import { useSyncExternalStore } from "react"

// One shared minute clock behind every relative label: each subscriber re-renders
// at most once a minute, so "5 分钟前" style text stays correct even while
// react-query keeps an unchanged thread list from re-rendering.
const tickMs = 60_000
const listeners = new Set<() => void>()
let timer: number | undefined
let seconds = Math.floor(Date.now() / 1000)

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    // Catch up after an idle gap so remounted labels do not start stale.
    seconds = Math.floor(Date.now() / 1000)
    timer = window.setInterval(() => {
      seconds = Math.floor(Date.now() / 1000)
      for (const notify of listeners) notify()
    }, tickMs)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== undefined) {
      window.clearInterval(timer)
      timer = undefined
    }
  }
}

export function useNowSeconds() {
  return useSyncExternalStore(subscribe, () => seconds)
}
