import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import test from "node:test"
import ts from "typescript"

// React calls the same hooks in the same order on every render, but a component may return
// a placeholder before its data arrives. A hook written below that early return is skipped on
// the first render and called on the second, so React throws #310 ("Rendered more hooks than
// during the previous render") and the error boundary replaces the page. Opening a Thread
// from its URL is exactly that shape — no Thread List row to render from, one loading render,
// then the detail read lands — so every hook has to sit above the placeholders.
const hookName = /^use[A-Z0-9]/

// Hook calls of one statement, ignoring nested function bodies: a hook inside a callback or a
// nested component belongs to that function, not to the component this scan is walking.
function hookCalls(node: ts.Node, found: string[] = []): string[] {
  if (ts.isCallExpression(node)) {
    const callee = node.expression
    if (ts.isIdentifier(callee) && hookName.test(callee.text)) found.push(callee.text)
    else if (ts.isPropertyAccessExpression(callee) && hookName.test(callee.name.text)) found.push(callee.name.text)
  }
  ts.forEachChild(node, (child) => {
    if (ts.isFunctionLike(child) && !ts.isCallExpression(node)) return
    hookCalls(child, found)
  })
  return found
}

function returnsEarly(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement)) return true
  let early = false
  const walk = (node: ts.Node) => {
    if (early || ts.isFunctionLike(node)) return
    if (ts.isReturnStatement(node)) {
      early = true
      return
    }
    ts.forEachChild(node, walk)
  }
  walk(statement)
  return early
}

function componentName(node: ts.Node): [string, ts.SignatureDeclaration & { body?: ts.Node }] | null {
  if (ts.isFunctionDeclaration(node) && node.name) return [node.name.text, node]
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return [node.parent.name.text, node]
  return null
}

function violationsIn(dir: URL): string[] {
  const offenders: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir)
    if (entry.isDirectory()) {
      offenders.push(...violationsIn(child))
      continue
    }
    if (!entry.name.endsWith(".tsx")) continue
    const path = new URL(entry.name, dir)
    const text = readFileSync(path, "utf8")
    const source = ts.createSourceFile(path.pathname, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const visit = (node: ts.Node) => {
      const named = componentName(node)
      if (named && /^[A-Z]/.test(named[0]) && named[1].body && ts.isBlock(named[1].body)) {
        let placeholder = false
        for (const statement of named[1].body.statements) {
          if (placeholder) {
            const hooks = hookCalls(statement)
            if (hooks.length > 0) {
              const { line } = source.getLineAndCharacterOfPosition(statement.getStart(source))
              offenders.push(`${entry.name}:${line + 1} ${named[0]} calls ${hooks.join(", ")} after an early return`)
            }
          }
          if (returnsEarly(statement)) placeholder = true
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return offenders
}

test("no component calls a hook below an early return", () => {
  assert.deepEqual(violationsIn(new URL("../src/", import.meta.url)), [])
})
