import type { MermaidConfig } from 'mermaid'

// Greyhaven tokens (tokens/build/tokens-{light,dark}.css) as hex for Mermaid. Diagrams are neutral greys
// with the orange accent kept for links between nodes only, flat: no shadows, no gradients.
const tokens = {
  light: { bg: '#f0f0ec', card: '#f9f9f7', fg: '#161614', muted: '#575753', line: '#7f7f79', border: '#a6a69f', soft: '#dddDd7', accent: '#d95e2a' },
  dark: { bg: '#161614', card: '#2f2f2c', fg: '#f9f9f7', muted: '#c4c4bd', line: '#a6a69f', border: '#7f7f79', soft: '#3d3d3a', accent: '#d95e2a' },
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
  const soft = t.soft.toLowerCase()
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    look: 'classic',
    ...(elk ? { layout: 'elk' } : {}),
    fontFamily: 'Aspekta, ui-sans-serif, system-ui, sans-serif',
    themeVariables: {
      darkMode: mode === 'dark',
      background: 'transparent',
      fontFamily: 'Aspekta, ui-sans-serif, system-ui, sans-serif',
      fontSize: '14px',
      dropShadow: 'none',
      useGradient: false,
      primaryColor: t.card,
      primaryTextColor: t.fg,
      primaryBorderColor: t.border,
      secondaryColor: soft,
      secondaryTextColor: t.fg,
      secondaryBorderColor: t.border,
      tertiaryColor: t.bg,
      tertiaryTextColor: t.fg,
      tertiaryBorderColor: t.border,
      lineColor: t.line,
      textColor: t.fg,
      titleColor: t.fg,
      mainBkg: t.card,
      nodeBorder: t.border,
      nodeTextColor: t.fg,
      clusterBkg: mode === 'dark' ? '#1f1f1d' : '#f4f4f1',
      clusterBorder: t.border,
      edgeLabelBackground: mode === 'dark' ? t.bg : t.card,
      noteBkgColor: soft,
      noteTextColor: t.fg,
      noteBorderColor: t.border,
      actorBkg: t.card,
      actorBorder: t.border,
      actorTextColor: t.fg,
      actorLineColor: t.line,
      signalColor: t.fg,
      signalTextColor: t.fg,
      labelBoxBkgColor: t.card,
      labelBoxBorderColor: t.border,
      labelTextColor: t.fg,
      loopTextColor: t.fg,
      activationBkgColor: soft,
      activationBorderColor: t.border,
      sequenceNumberColor: t.card,
      pie1: t.accent,
      pie2: '#575753',
      pie3: '#7f7f79',
      pie4: '#a6a69f',
      pie5: '#2f2f2c',
      pieStrokeColor: t.card,
      pieOuterStrokeColor: t.border,
      pieTitleTextColor: t.fg,
      pieSectionTextColor: '#f9f9f7',
      git0: t.accent,
      cScale0: t.card,
      cScale1: soft,
      cScale2: t.bg,
    },
    flowchart: { curve: 'basis', padding: 12 },
    sequence: { mirrorActors: false },
  }
}
