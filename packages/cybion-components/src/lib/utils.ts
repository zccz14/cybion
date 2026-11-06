import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Every request the app makes funnels its failure message through here, so a
// component that reports an error never invents its own wording.
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed"
}
