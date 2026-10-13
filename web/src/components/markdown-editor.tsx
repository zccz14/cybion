import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ClipboardEvent,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"
import Image from "@tiptap/extension-image"
import Placeholder from "@tiptap/extension-placeholder"
import TableCell from "@tiptap/extension-table-cell"
import TableHeader from "@tiptap/extension-table-header"
import TableRow from "@tiptap/extension-table-row"
import TaskItem from "@tiptap/extension-task-item"
import TaskList from "@tiptap/extension-task-list"
import Typography from "@tiptap/extension-typography"
import { Table } from "@tiptap/extension-table"
import { Markdown } from "@tiptap/markdown"
import { BubbleMenu } from "@tiptap/react/menus"
import {
  EditorContent,
  type Editor,
  useEditor,
  useEditorState,
} from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import {
  BoldIcon,
  Code2Icon,
  FileCode2Icon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ItalicIcon,
  ListChecksIcon,
  ListIcon,
  ListOrderedIcon,
  LoaderCircleIcon,
  MinusIcon,
  PilcrowIcon,
  QuoteIcon,
  Redo2Icon,
  StrikethroughIcon,
  Table2Icon,
  Undo2Icon,
  type LucideIcon,
} from "lucide-react"

import { Markdown as MarkdownPreview } from "@/components/markdown"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

export type MarkdownEditorLanguage = "en" | "zh"

type EditorMode = "write" | "markdown" | "preview"

type SlashCommand = {
  id: string
  label: string
  description: string
  icon: LucideIcon
  run: (editor: Editor) => void
}

type SlashMenu = {
  from: number
  query: string
  top: number
  left: number
}

type MarkdownEditorCopy = {
  undo: string
  redo: string
  bold: string
  italic: string
  strikethrough: string
  inlineCode: string
  heading1: string
  heading2: string
  heading3: string
  bulletedList: string
  numberedList: string
  todoList: string
  quote: string
  codeBlock: string
  horizontalRule: string
  table: string
  commands: string
  writeMode: string
  markdownMode: string
  previewMode: string
  placeholder: string
  imageUploadFailed: string
  commandItems: {
    textLabel: string
    textDescription: string
    bulletedListDescription: string
    todoListDescription: string
    quoteDescription: string
    codeBlockDescription: string
    tableDescription: string
  }
}

const copy: Record<MarkdownEditorLanguage, MarkdownEditorCopy> = {
  en: {
    undo: "Undo",
    redo: "Redo",
    bold: "Bold",
    italic: "Italic",
    strikethrough: "Strikethrough",
    inlineCode: "Inline code",
    heading1: "Heading 1",
    heading2: "Heading 2",
    heading3: "Heading 3",
    bulletedList: "Bulleted list",
    numberedList: "Numbered list",
    todoList: "To-do list",
    quote: "Quote",
    codeBlock: "Code block",
    horizontalRule: "Horizontal rule",
    table: "Table",
    commands: "Blocks",
    writeMode: "Write",
    markdownMode: "Markdown",
    previewMode: "Preview",
    placeholder: "Type / to add a block, or just start writing…",
    imageUploadFailed: "Image upload failed. Paste or upload the image again.",
    commandItems: {
      textLabel: "Text",
      textDescription: "Start writing with plain text",
      bulletedListDescription: "A simple unordered list",
      todoListDescription: "Track a checked or open task",
      quoteDescription: "Call out a quotation",
      codeBlockDescription: "Code, Mermaid, or a literal block",
      tableDescription: "A three-column Markdown table",
    },
  },
  zh: {
    undo: "撤销",
    redo: "重做",
    bold: "加粗",
    italic: "斜体",
    strikethrough: "删除线",
    inlineCode: "行内代码",
    heading1: "一级标题",
    heading2: "二级标题",
    heading3: "三级标题",
    bulletedList: "无序列表",
    numberedList: "有序列表",
    todoList: "任务清单",
    quote: "引用",
    codeBlock: "代码块",
    horizontalRule: "分割线",
    table: "表格",
    commands: "插入块",
    writeMode: "编辑",
    markdownMode: "源码",
    previewMode: "预览",
    placeholder: "输入 / 添加块，或直接开始写作…",
    imageUploadFailed: "图片上传失败。请重新粘贴或上传图片。",
    commandItems: {
      textLabel: "文本",
      textDescription: "用普通文本开始写作",
      bulletedListDescription: "简单的无序列表",
      todoListDescription: "跟踪已办或待办事项",
      quoteDescription: "引用一段内容",
      codeBlockDescription: "代码、Mermaid 或纯文本块",
      tableDescription: "一个三列的 Markdown 表格",
    },
  },
}

function slashCommandsOf(labels: MarkdownEditorCopy): SlashCommand[] {
  return [
    {
      id: "text",
      label: labels.commandItems.textLabel,
      description: labels.commandItems.textDescription,
      icon: PilcrowIcon,
      run: (editor) => editor.chain().focus().setParagraph().run(),
    },
    {
      id: "heading-1",
      label: labels.heading1,
      description: labels.commandItems.textDescription,
      icon: Heading1Icon,
      run: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
    },
    {
      id: "heading-2",
      label: labels.heading2,
      description: labels.commandItems.textDescription,
      icon: Heading2Icon,
      run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      id: "bulleted-list",
      label: labels.bulletedList,
      description: labels.commandItems.bulletedListDescription,
      icon: ListIcon,
      run: (editor) => editor.chain().focus().toggleBulletList().run(),
    },
    {
      id: "task-list",
      label: labels.todoList,
      description: labels.commandItems.todoListDescription,
      icon: ListChecksIcon,
      run: (editor) => editor.chain().focus().toggleTaskList().run(),
    },
    {
      id: "quote",
      label: labels.quote,
      description: labels.commandItems.quoteDescription,
      icon: QuoteIcon,
      run: (editor) => editor.chain().focus().toggleBlockquote().run(),
    },
    {
      id: "code",
      label: labels.codeBlock,
      description: labels.commandItems.codeBlockDescription,
      icon: FileCode2Icon,
      run: (editor) => editor.chain().focus().toggleCodeBlock().run(),
    },
    {
      id: "table",
      label: labels.table,
      description: labels.commandItems.tableDescription,
      icon: Table2Icon,
      run: (editor) =>
        editor
          .chain()
          .focus()
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run(),
    },
  ]
}

function markdownFromEditor(editor: Editor) {
  return editor.getMarkdown().replace(/\n$/, "")
}

function findSlashMenu(editor: Editor): SlashMenu | null {
  const { from, empty } = editor.state.selection
  if (!empty) return null

  const start = Math.max(1, from - 48)
  const text = editor.state.doc.textBetween(start, from, "\n", "\0")
  const match = /(?:^|\s)\/([\p{L}\p{N}-]*)$/u.exec(text)
  if (!match) return null

  const slashOffset = match[0].lastIndexOf("/")
  const position = start + text.length - match[0].length + slashOffset
  const coordinates = editor.view.coordsAtPos(from)
  const menuWidth = 288
  const menuHeight = 344
  const top =
    coordinates.bottom + menuHeight < window.innerHeight
      ? coordinates.bottom + 8
      : Math.max(12, coordinates.top - menuHeight - 8)

  return {
    from: position,
    query: match[1].toLocaleLowerCase(),
    top,
    left: Math.min(
      Math.max(12, coordinates.left),
      window.innerWidth - menuWidth - 12
    ),
  }
}

function imageFromClipboard(clipboard: DataTransfer): File | null {
  return (
    Array.from(clipboard.items)
      .find((item) => item.kind === "file" && item.type.startsWith("image/"))
      ?.getAsFile() ?? null
  )
}

export function MarkdownEditor({
  id,
  language,
  value,
  onChange,
  disabled = false,
  defaultMode = "write",
  onImageUpload,
}: {
  id?: string
  language: MarkdownEditorLanguage
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  defaultMode?: EditorMode
  /** Uploads a pasted image and resolves to its public URL. */
  onImageUpload?: (image: File) => Promise<string>
}) {
  const labels = copy[language]
  const [mode, setMode] = useState<EditorMode>(defaultMode)
  const toolbarId = id ? `${id}-toolbar` : undefined
  const [slashMenu, setSlashMenu] = useState<SlashMenu | null>(null)
  const [imageUploading, setImageUploading] = useState(false)
  const [imageUploadFailed, setImageUploadFailed] = useState(false)
  const locked = disabled || mode !== "write"
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
          link: {
            autolink: true,
            defaultProtocol: "https",
            openOnClick: false,
            HTMLAttributes: { rel: "noreferrer" },
          },
          underline: false,
        }),
        Markdown.configure({ indentation: { style: "space", size: 2 } }),
        Image.configure({ allowBase64: false, inline: false }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Table.configure({ resizable: false }),
        TableRow,
        TableHeader,
        TableCell,
        Placeholder.configure({ placeholder: labels.placeholder }),
        Typography,
      ],
      content: value,
      contentType: "markdown",
      editable: !locked,
      immediatelyRender: false,
      onUpdate: ({ editor: currentEditor }) => {
        onChange(markdownFromEditor(currentEditor))
        setSlashMenu(findSlashMenu(currentEditor))
      },
      onSelectionUpdate: ({ editor: currentEditor }) => {
        setSlashMenu(findSlashMenu(currentEditor))
      },
    },
    [labels.placeholder]
  )

  const editorState = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => ({
      bold: currentEditor?.isActive("bold") ?? false,
      italic: currentEditor?.isActive("italic") ?? false,
      strike: currentEditor?.isActive("strike") ?? false,
      code: currentEditor?.isActive("code") ?? false,
      heading1: currentEditor?.isActive("heading", { level: 1 }) ?? false,
      heading2: currentEditor?.isActive("heading", { level: 2 }) ?? false,
      heading3: currentEditor?.isActive("heading", { level: 3 }) ?? false,
      bulletList: currentEditor?.isActive("bulletList") ?? false,
      orderedList: currentEditor?.isActive("orderedList") ?? false,
      taskList: currentEditor?.isActive("taskList") ?? false,
      blockquote: currentEditor?.isActive("blockquote") ?? false,
      codeBlock: currentEditor?.isActive("codeBlock") ?? false,
    }),
  })

  useEffect(() => {
    if (!editor || mode !== "write") return
    if (markdownFromEditor(editor) === value) return
    editor.commands.setContent(value, {
      contentType: "markdown",
      emitUpdate: false,
    })
  }, [editor, mode, value])

  useEffect(() => {
    editor?.setEditable(!locked)
  }, [editor, locked])

  useEffect(() => {
    const clearSlashMenu = () => setSlashMenu(null)
    window.addEventListener("resize", clearSlashMenu)
    window.addEventListener("scroll", clearSlashMenu, true)
    return () => {
      window.removeEventListener("resize", clearSlashMenu)
      window.removeEventListener("scroll", clearSlashMenu, true)
    }
  }, [])

  const filteredCommands = useMemo(() => {
    const query = slashMenu?.query ?? ""
    return slashCommandsOf(labels).filter((command) =>
      `${command.label} ${command.description}`
        .toLocaleLowerCase()
        .includes(query)
    )
  }, [slashMenu?.query, labels])

  const runSlashCommand = useCallback(
    (command: SlashCommand) => {
      if (!editor || !slashMenu) return
      editor
        .chain()
        .focus()
        .deleteRange({ from: slashMenu.from, to: editor.state.selection.from })
        .run()
      command.run(editor)
      setSlashMenu(null)
    },
    [editor, slashMenu]
  )

  const pasteImage = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      if (!onImageUpload || !editor || disabled) return
      const image = imageFromClipboard(event.clipboardData)
      if (!image) return
      const { from, to } = editor.state.selection
      event.preventDefault()
      setImageUploadFailed(false)
      setImageUploading(true)
      void onImageUpload(image)
        .then((url) => {
          editor
            .chain()
            .focus()
            .insertContentAt(
              { from, to },
              { type: "image", attrs: { src: url, alt: "" } }
            )
            .run()
        })
        .catch(() => setImageUploadFailed(true))
        .finally(() => setImageUploading(false))
    },
    [disabled, editor, onImageUpload]
  )

  return (
    <div className="markdown-editor min-w-0" data-mode={mode}>
      <div
        id={toolbarId}
        role="toolbar"
        aria-label={labels.commands}
        aria-orientation="horizontal"
        className="markdown-editor__toolbar"
      >
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          <EditorButton
            disabled={locked}
            label={labels.undo}
            onClick={() => editor?.chain().focus().undo().run()}
          >
            <Undo2Icon />
          </EditorButton>
          <EditorButton
            disabled={locked}
            label={labels.redo}
            onClick={() => editor?.chain().focus().redo().run()}
          >
            <Redo2Icon />
          </EditorButton>
          <ToolbarSeparator />
          <EditorButton
            active={editorState?.bold}
            disabled={locked}
            label={labels.bold}
            onClick={() => editor?.chain().focus().toggleBold().run()}
          >
            <BoldIcon />
          </EditorButton>
          <EditorButton
            active={editorState?.italic}
            disabled={locked}
            label={labels.italic}
            onClick={() => editor?.chain().focus().toggleItalic().run()}
          >
            <ItalicIcon />
          </EditorButton>
          <EditorButton
            active={editorState?.strike}
            disabled={locked}
            label={labels.strikethrough}
            onClick={() => editor?.chain().focus().toggleStrike().run()}
          >
            <StrikethroughIcon />
          </EditorButton>
          <EditorButton
            active={editorState?.code}
            disabled={locked}
            label={labels.inlineCode}
            onClick={() => editor?.chain().focus().toggleCode().run()}
          >
            <Code2Icon />
          </EditorButton>
          <ToolbarSeparator />
          <EditorButton
            active={editorState?.heading1}
            disabled={locked}
            label={labels.heading1}
            onClick={() =>
              editor?.chain().focus().toggleHeading({ level: 1 }).run()
            }
          >
            <Heading1Icon />
          </EditorButton>
          <EditorButton
            active={editorState?.heading2}
            disabled={locked}
            label={labels.heading2}
            onClick={() =>
              editor?.chain().focus().toggleHeading({ level: 2 }).run()
            }
          >
            <Heading2Icon />
          </EditorButton>
          <EditorButton
            active={editorState?.heading3}
            disabled={locked}
            label={labels.heading3}
            onClick={() =>
              editor?.chain().focus().toggleHeading({ level: 3 }).run()
            }
          >
            <Heading3Icon />
          </EditorButton>
          <EditorButton
            active={editorState?.bulletList}
            disabled={locked}
            label={labels.bulletedList}
            onClick={() => editor?.chain().focus().toggleBulletList().run()}
          >
            <ListIcon />
          </EditorButton>
          <EditorButton
            active={editorState?.orderedList}
            disabled={locked}
            label={labels.numberedList}
            onClick={() => editor?.chain().focus().toggleOrderedList().run()}
          >
            <ListOrderedIcon />
          </EditorButton>
          <EditorButton
            active={editorState?.taskList}
            disabled={locked}
            label={labels.todoList}
            onClick={() => editor?.chain().focus().toggleTaskList().run()}
          >
            <ListChecksIcon />
          </EditorButton>
          <EditorButton
            active={editorState?.blockquote}
            disabled={locked}
            label={labels.quote}
            onClick={() => editor?.chain().focus().toggleBlockquote().run()}
          >
            <QuoteIcon />
          </EditorButton>
          <EditorButton
            active={editorState?.codeBlock}
            disabled={locked}
            label={labels.codeBlock}
            onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
          >
            <FileCode2Icon />
          </EditorButton>
          <EditorButton
            disabled={locked}
            label={labels.horizontalRule}
            onClick={() => editor?.chain().focus().setHorizontalRule().run()}
          >
            <MinusIcon />
          </EditorButton>
          <EditorButton
            disabled={locked}
            label={labels.table}
            onClick={() =>
              editor
                ?.chain()
                .focus()
                .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                .run()
            }
          >
            <Table2Icon />
          </EditorButton>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1 border-l pl-2">
          {imageUploading ? (
            <span
              role="status"
              aria-label={language === "zh" ? "图片上传中" : "Uploading image"}
              title={language === "zh" ? "图片上传中" : "Uploading image"}
            >
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            </span>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant={mode === "write" ? "secondary" : "ghost"}
            aria-pressed={mode === "write"}
            onClick={() => setMode("write")}
          >
            {labels.writeMode}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "markdown" ? "secondary" : "ghost"}
            aria-pressed={mode === "markdown"}
            onClick={() => setMode("markdown")}
          >
            {labels.markdownMode}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "preview" ? "secondary" : "ghost"}
            aria-pressed={mode === "preview"}
            onClick={() => setMode("preview")}
          >
            {labels.previewMode}
          </Button>
        </div>
      </div>

      {imageUploadFailed ? (
        <p role="alert" className="border-b bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {labels.imageUploadFailed}
        </p>
      ) : null}

      {mode === "write" ? (
        <>
          <EditorContent
            editor={editor}
            className="markdown-editor__canvas"
            onPaste={pasteImage}
          />
          {editor ? (
            <BubbleMenu
              editor={editor}
              shouldShow={({ state }) => !state.selection.empty}
              className="markdown-editor__bubble-menu"
            >
              <EditorButton
                active={editorState?.bold}
                label={labels.bold}
                onClick={() => editor.chain().focus().toggleBold().run()}
              >
                <BoldIcon />
              </EditorButton>
              <EditorButton
                active={editorState?.italic}
                label={labels.italic}
                onClick={() => editor.chain().focus().toggleItalic().run()}
              >
                <ItalicIcon />
              </EditorButton>
              <EditorButton
                active={editorState?.code}
                label={labels.inlineCode}
                onClick={() => editor.chain().focus().toggleCode().run()}
              >
                <Code2Icon />
              </EditorButton>
            </BubbleMenu>
          ) : null}
          {slashMenu && filteredCommands.length > 0
            ? createPortal(
                <div
                  role="listbox"
                  aria-label={labels.commands}
                  className="markdown-editor__slash-menu"
                  style={{ top: slashMenu.top, left: slashMenu.left }}
                >
                  <p className="px-3 pt-2.5 pb-1 text-xs font-medium text-muted-foreground">
                    {labels.commands}
                  </p>
                  <div className="max-h-72 overflow-y-auto px-1.5 pb-1.5">
                    {filteredCommands.map((command) => {
                      const Icon = command.icon
                      return (
                        <Button
                          key={command.id}
                          type="button"
                          variant="ghost"
                          className="h-auto w-full justify-start gap-2 px-2 py-2 text-left"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => runSlashCommand(command)}
                        >
                          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted">
                            <Icon className="size-3.5" />
                          </span>
                          <span className="min-w-0">
                            <span className="block text-sm font-medium">
                              {command.label}
                            </span>
                            <span className="block truncate text-xs font-normal text-muted-foreground">
                              {command.description}
                            </span>
                          </span>
                        </Button>
                      )
                    })}
                  </div>
                </div>,
                document.body
              )
            : null}
        </>
      ) : null}

      {mode === "markdown" ? (
        <Textarea
          id={id}
          aria-label={labels.markdownMode}
          className={cn(
            "markdown-editor__source min-h-[32rem] rounded-none border-x-0 border-b-0 font-mono text-sm leading-6",
            disabled && "cursor-not-allowed"
          )}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}

      {mode === "preview" ? (
        <div className="markdown-editor__preview min-h-[32rem] px-5 py-8">
          <div className="prose prose-sm max-w-[72ch] break-words dark:prose-neutral dark:prose-invert prose-headings:font-semibold prose-pre:overflow-x-auto prose-pre:rounded-lg prose-pre:bg-muted prose-pre:text-foreground">
            <MarkdownPreview>{value}</MarkdownPreview>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function EditorButton({
  active = false,
  disabled = false,
  label,
  onClick,
  children,
}: {
  active?: boolean
  disabled?: boolean
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "ghost"}
      size="icon-sm"
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      title={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

function ToolbarSeparator() {
  return <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-border" />
}
