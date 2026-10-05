const CYBION_MARK_PATH = "M32 13.8 L53 50.2 L11 50.2 Z"

const FAVICON_STROKE = {
  light: "#000",
  dark: "#fff",
} as const

// Browsers render the SVG favicon once and never re-evaluate its
// prefers-color-scheme styles, so a theme toggle leaves the old color in the
// tab until the next page load. Replacing the link with a data URL carrying
// the theme-colored mark updates the icon immediately.
export function applyFavicon(resolvedTheme: keyof typeof FAVICON_STROKE) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="${CYBION_MARK_PATH}" fill="none" stroke="${FAVICON_STROKE[resolvedTheme]}" stroke-width="9" stroke-linejoin="round"/></svg>`
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')!
  link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`
}
