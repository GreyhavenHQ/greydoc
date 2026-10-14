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
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import * as Y from 'yjs'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import type { Awareness } from 'y-protocols/awareness'

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
})

export interface CodeEditorProps {
  ytext: Y.Text
  awareness: Awareness
  readOnly: boolean
  extensions?: Extension[]
  onView?: (view: EditorView | null) => void
  autoFocus?: boolean
}

export function CodeEditor({ ytext, awareness, readOnly, extensions = [], onView, autoFocus }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const readOnlyCompartment = useRef(new Compartment())

  useEffect(() => {
    const undoManager = new Y.UndoManager(ytext)
    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
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
        highlightActiveLine(),
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
      undoManager.destroy()
      viewRef.current = null
    }
    // Extensions and callbacks are fixed for the editor's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytext, awareness])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartment.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    })
  }, [readOnly])

  return <div ref={host} className="h-full overflow-hidden" data-testid="editor" />
}
