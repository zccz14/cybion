import { cn } from "./utils"

/**
 * The view's root is a page by default: it claims the height below a 3.5rem
 * header, which is what the full-page shell wants. An embedder that owns the
 * box — a ticket panel, a drawer — passes its own minimum height and wins
 * through tailwind-merge, so the view fills that box instead of the window.
 */
export function threadRootClass(className?: string) {
  return cn("flex min-h-[calc(100svh-3.5rem)] min-w-0 flex-1 flex-col", className)
}
