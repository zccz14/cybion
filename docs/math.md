# Math rendering

Cybion renders LaTeX math through [KaTeX](https://katex.org/) wherever it renders
Markdown. The wiring lives in the one shared `Markdown` component
(`web/src/components/markdown.tsx`), so assistant replies, checkpoints, and the
Manual editor's preview all render formulas the same way, and a new Markdown
surface inherits math for free.

## Delimiters

Two delimiter families are accepted, because models pick either one:

| Source | Result |
| --- | --- |
| `$E=mc^2$` | Inline math |
| `\(E=mc^2\)` | Inline math, LaTeX-style |
| `$$\n\sum_{i=1}^{n} i\n$$` | Display math, centered on its own line |
| `\[\n\sum_{i=1}^{n} i\n\]` | Display math, LaTeX-style |
| ```` ```math ```` fence | Display math, like `$$` |

`remark-math-extended` parses the delimiters, `rehype-katex` renders them, and
the KaTeX stylesheet and fonts are imported by the same component, so a formula
is never rendered without its typography. The plugin is upstream
[`remark-math`](https://github.com/remarkjs/remark-math)'s own `mdast-util-math`
paired with a tokenizer that adds the TeX delimiters, so `$` behavior is
unchanged and only the backslash forms are new.

Display `\[...\]` is a block construct: the opener must sit where a block can
start (line start, list item start) and the closer must end its line, which is
how display math is written in practice. Written mid-sentence, `\[ x \]` stays
literal brackets — use `\(x\)` or `$x$` inside a sentence.

## Behavior

- **Incomplete math stays source.** Streaming cuts Markdown mid-expression; a
  `$`, `$$`, `\(` or `\[` without its closer is ordinary text, so nothing
  half-parsed flickers as a formula.
- **Code is never math.** Fenced blocks and inline code keep `\[ a \]` byte for
  byte, and `\*`, `\_` still escape Markdown punctuation; the TeX delimiters do
  not take over CommonMark escapes that are not a formula.
- **`\\[2pt]` stays a line break.** Inside display math, `\\` is TeX's line
  break and the following `[2pt]` is its argument, so `aligned` blocks do not get
  split by a second delimiter.
- **Broken math degrades, it never throws.** KaTeX parses with `throwOnError`
  off, so a malformed expression becomes one `.katex-error` span whose `title`
  carries the parser message and whose color is the theme's `destructive` token.
  The surrounding sentence renders normally.
- **Escaping works.** `\$5` and `\$10` stay literal dollars; that is the way out
  when a price pair would otherwise read as math.
- **Single dollars are live.** Inline `$...$` is enabled (as on GitHub and in
  most chat products). A price pair such as `$5 和 $10` is therefore a real risk;
  escaping it fixes that line. Requiring `$$` everywhere is one option away
  (`singleDollarTextMath: false`) if false positives ever outweigh inline math.
- **Theme follows the text.** KaTeX draws in `currentColor`, so formulas take the
  prose palette and need no separate dark palette.
- **Wide display math scrolls.** `.katex-display` scrolls horizontally inside the
  message column instead of widening the transcript (see `web/src/styles.css`),
  the same rule code blocks and diagrams follow.
- **Maths stays accessible.** KaTeX emits MathML plus an `aria-hidden` HTML copy,
  so screen readers get the expression and sighted users get the glyphs.

## Tests

- `web/tests/markdown.test.ts` renders inline, display, fenced, and broken math
  through the shared component, plus the `\(...\)` / `\[...\]` forms, escaped
  punctuation, code blocks, and `\\[2pt]` inside display math.
- `web/e2e/katex.spec.ts` (fixture `web/e2e/katex.tsx`) checks the browser
  rendering: KaTeX fonts actually load, display math is a centered block, wide
  formulas stay inside the column down to 320px in both themes, broken math keeps
  the rest of the message readable, and the model's `\[...\]` / `\(...\)`
  replies render as formulas rather than leftover source.
