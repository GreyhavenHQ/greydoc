import type { MermaidConfig } from 'mermaid'

// Greyhaven tokens (tokens/build/tokens-{light,dark}.css) as hex for Mermaid.
const tokens = {
  light: { bg: '#f0f0ec', card: '#f9f9f7', fg: '#161614', muted: '#575753', border: '#c4c4bd', accent: '#dddDd7', primary: '#d95e2a' },
  dark: { bg: '#161614', card: '#2f2f2c', fg: '#f9f9f7', muted: '#c4c4bd', border: '#575753', accent: '#575753', primary: '#d95e2a' },
}

// diagramUsesElk is true for diagram types the ELK layout supports. Others, such as mindmaps, break with it.
export function diagramUsesElk(src: string): boolean {
  const lines = src.split('\n')
  let i = 0
  if (lines[0]?.trim() === '---') {
    i = lines.findIndex((l, j) => j > 0 && l.trim() === '---') + 1
  }
  for (; i < lines.length; i++) {
    const l = lines[i].trim()
    if (!l || l.startsWith('%%')) continue
    return /^(flowchart|graph|stateDiagram)\b/.test(l)
  }
  return false
}

export function mermaidConfig(mode: 'light' | 'dark', elk = false): MermaidConfig {
  const t = tokens[mode]
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    ...(elk ? { layout: 'elk' } : {}),
    fontFamily: 'Aspekta, ui-sans-serif, system-ui, sans-serif',
    themeVariables: {
      darkMode: mode === 'dark',
      background: t.bg,
      fontFamily: 'Aspekta, ui-sans-serif, system-ui, sans-serif',
      fontSize: '14px',
      primaryColor: t.card,
      primaryTextColor: t.fg,
      primaryBorderColor: t.primary,
      secondaryColor: t.accent.toLowerCase(),
      secondaryTextColor: t.fg,
      secondaryBorderColor: t.border,
      tertiaryColor: t.bg,
      tertiaryTextColor: t.fg,
      tertiaryBorderColor: t.border,
      lineColor: t.muted,
      textColor: t.fg,
      mainBkg: t.card,
      nodeBorder: t.primary,
      clusterBkg: t.bg,
      clusterBorder: t.border,
      edgeLabelBackground: t.bg,
      noteBkgColor: t.accent.toLowerCase(),
      noteTextColor: t.fg,
      noteBorderColor: t.border,
      actorBkg: t.card,
      actorBorder: t.primary,
      actorTextColor: t.fg,
      signalColor: t.fg,
      signalTextColor: t.fg,
      labelBoxBkgColor: t.card,
      labelBoxBorderColor: t.border,
      activationBkgColor: t.accent.toLowerCase(),
      activationBorderColor: t.primary,
      pie1: t.primary,
      pie2: '#575753',
      pie3: '#7f7f79',
      pie4: '#a6a69f',
      pie5: '#2f2f2c',
      git0: t.primary,
    },
    flowchart: { curve: 'basis', padding: 12 },
    sequence: { mirrorActors: false },
  }
}
