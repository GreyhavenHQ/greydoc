import { useEffect, useRef } from 'react'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { HighlightStyle, bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import * as Y from 'yjs'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import type { Awareness } from 'y-protocols/awareness'
import { livePreview, liveStyle, refreshLive, type LiveStyle } from '@/editor/live'
import { useTheme } from '@/lib/theme'

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '14px', backgroundColor: 'rgb(var(--card))', color: 'rgb(var(--foreground))' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { padding: '16px 0', caretColor: 'rgb(var(--primary))' },
  '.cm-gutters': { backgroundColor: 'rgb(var(--card))', color: 'rgb(var(--muted-foreground) / 0.6)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'rgb(var(--muted) / 0.5)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'rgb(var(--foreground))' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'rgb(var(--primary))' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'rgb(var(--primary) / 0.18) !important',
  },
  '.cm-ySelectionInfo': { fontFamily: 'var(--font-sans)', fontSize: '11px', padding: '1px 4px', opacity: '1' },
  '.cm-tooltip.cm-tooltip-autocomplete': {
    border: '1px solid rgb(var(--border))', borderRadius: 'var(--radius)', backgroundColor: 'rgb(var(--popover))',
    boxShadow: '0 8px 24px rgb(0 0 0 / 0.12)', padding: '4px', overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-sans)', fontSize: '13px', maxHeight: '18em', minWidth: '260px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '5px 8px', borderRadius: '4px', color: 'rgb(var(--popover-foreground))' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'rgb(var(--primary) / 0.12)', color: 'rgb(var(--foreground))' },
  '.cm-completionIcon': { display: 'none' },
  '.cm-completionDetail': { marginLeft: '12px', fontStyle: 'normal', fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'rgb(var(--muted-foreground))' },
})

const markdownStyle = HighlightStyle.define([
  { tag: tags.heading1, fontWeight: '700', fontSize: '1.15em' },
  { tag: tags.heading2, fontWeight: '700', fontSize: '1.08em' },
  { tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], color: 'rgb(var(--primary))' },
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: 'rgb(var(--muted-foreground))' },
  { tag: tags.quote, color: 'rgb(var(--muted-foreground))', fontStyle: 'italic' },
  { tag: tags.monospace, color: 'rgb(var(--foreground) / 0.85)' },
])

export interface CodeEditorProps {
  ytext: Y.Text
  awareness: Awareness
  readOnly: boolean
  extensions?: Extension[]
  // overlay is reconfigurable at runtime, for the attribution layer.
  overlay?: Extension
  // live renders Markdown in place instead of showing the source with line numbers.
  live?: boolean
  liveStyle?: LiveStyle
  // undoManager outlives the editor, so the history stays when the mode changes.
  undoManager?: Y.UndoManager
  onView?: (view: EditorView | null) => void
  autoFocus?: boolean
}

// The source style also sizes headings. It MUST NOT apply in live mode, which has the sizes of the view.
const sourceView = () => [lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), syntaxHighlighting(markdownStyle)]

export function CodeEditor({ ytext, awareness, readOnly, extensions = [], overlay = [], live = false, liveStyle: style = 'obsidian', undoManager: shared, onView, autoFocus }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const readOnlyCompartment = useRef(new Compartment())
  const overlayCompartment = useRef(new Compartment())
  const viewCompartment = useRef(new Compartment())
  const styleCompartment = useRef(new Compartment())

  useEffect(() => {
    const undoManager = shared ?? new Y.UndoManager(ytext)
    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        viewCompartment.current.of(live ? livePreview() : sourceView()),
        styleCompartment.current.of(liveStyle.of(style)),
        highlightSpecialChars(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        rectangularSelection(),
        crosshairCursor(),
        highlightSelectionMatches(),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...completionKeymap,
          ...yUndoManagerKeymap,
          indentWithTab,
        ]),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        EditorView.lineWrapping,
        theme,
        readOnlyCompartment.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        yCollab(ytext, awareness, { undoManager }),
        overlayCompartment.current.of(overlay),
        ...extensions,
      ],
    })
    const view = new EditorView({ state, parent: host.current! })
    viewRef.current = view
    onView?.(view)
    if (autoFocus && !readOnly) {
      view.focus()
      view.dispatch({ selection: { anchor: view.state.doc.length } })
    }
    return () => {
      onView?.(null)
      view.destroy()
      if (!shared) undoManager.destroy()
      viewRef.current = null
    }
    // Extensions and callbacks are fixed for the editor's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytext, awareness, shared])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartment.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    })
  }, [readOnly])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: overlayCompartment.current.reconfigure(overlay) })
  }, [overlay])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: viewCompartment.current.reconfigure(live ? livePreview() : sourceView()) })
  }, [live])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: styleCompartment.current.reconfigure(liveStyle.of(style)) })
  }, [style])

  const { resolvedTheme } = useTheme()
  useEffect(() => {
    viewRef.current?.dispatch({ effects: refreshLive.of(null) })
  }, [resolvedTheme])

  return <div ref={host} className="h-full overflow-hidden" data-testid="editor" />
}
