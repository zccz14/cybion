# Math rendering

Math is no longer wired here. Cybion renders Markdown — formulas included — through the shared
`<Markdown>` component in [`@zccz14/ux`](https://github.com/zccz14/ux), which owns the delimiters,
the KaTeX pipeline and the typography for every surface in the family: assistant replies,
checkpoint bodies, and Manual previews.

The behaviour that used to be documented on this page — accepted delimiters, streaming and
broken-formula fallbacks, escaping, and why the KaTeX runtime loads on demand — lives in that
package's README, next to the code that implements it.

What changed on this side:

- `web/src/components/markdown.tsx` and `web/src/components/mermaid.tsx` are gone. The surfaces
  import `<Markdown content={...} />` from `@zccz14/ux` and pass one prop.
- The app no longer depends on `react-markdown`, `remark-gfm`, `remark-math-extended`,
  `rehype-katex`, `katex` or `mermaid`; they arrive with the component, and only the pieces a
  surface actually needs are downloaded.
- Typography comes from `.ux-markdown` in the package stylesheet, so the app no longer applies
  `prose` classes or ships `@tailwindcss/typography`. A surface still decides two things: the font
  size of its container (`text-sm` in the transcript) and its measure (`max-w-[75ch]`).
