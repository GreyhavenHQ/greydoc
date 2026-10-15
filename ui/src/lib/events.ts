import type { Source } from '@/lib/authors'
import { shortDateTime } from '@/lib/time'

export interface AuditEvent {
  id: string
  note_id?: string
  actor_id?: string
  actor_name: string
  source: Source
  client?: string
  kind: string
  data: Record<string, unknown>
  created_at: string
  note_alias?: string
  note_title?: string
  note_state?: '' | 'live' | 'trash' | 'deleted'
}

const levelWords: Record<string, string> = { deny: 'no access', read: 'view access', comment: 'comment access', write: 'edit access' }

// aiAsk describes an AI request in the timeline, with the person's own words when there are some.
function aiAsk(action: string, instruction: string): string {
  const what: Record<string, string> = {
    refine: 'asked the AI to refine the text',
    shorten: 'asked the AI to shorten the text',
    fix: 'asked the AI to fix spelling and grammar',
    diagram: 'asked the AI for a diagram',
    continue: 'asked the AI to continue the text',
    revise: 'asked the AI to revise its suggestion',
  }
  if (instruction) return `asked the AI: “${instruction}”`
  return what[action] ?? 'asked the AI for a change'
}

export function describe(e: AuditEvent): string {
  const d = e.data ?? {}
  switch (e.kind) {
    case 'note.create':
      return 'created the note'
    case 'note.delete':
      return d.reason ? `deleted “${d.title || d.alias}” for good after its time in the trash` : `deleted “${d.title || d.alias}” for good`
    case 'note.trash':
      return 'moved the note to the trash'
    case 'note.restore':
      return 'restored the note from the trash'
    case 'permission.user':
      return d.level === 'deny' ? `removed @${d.username}` : `gave @${d.username} ${levelWords[String(d.level)] ?? d.level}`
    case 'permission.group': {
      const g = d.group === '_everyone' ? 'anyone with the address' : d.group === '_signed_in' ? 'signed-in users' : `group ${d.group}`
      return d.level === 'deny' ? `removed access for ${g}` : `gave ${g} ${levelWords[String(d.level)] ?? d.level}`
    }
    case 'permission.owner':
      return `made @${d.username} the owner`
    case 'agent_policy':
      return `set the agent policy to “${d.policy}”`
    case 'share_link.create':
      return 'created a view-only link'
    case 'share_link.revoke':
      return 'revoked a view-only link'
    case 'alias.add':
      return `added the address /${d.alias}`
    case 'alias.primary':
      return `made /${d.alias} the main address`
    case 'alias.remove':
      return `removed the address /${d.alias}`
    case 'revision.restore':
      return `restored the version from ${shortDateTime(String(d.at))}`
    case 'comment.create':
      return `commented: “${String(d.excerpt ?? '')}”`
    case 'comment.reply':
      return `replied: “${String(d.excerpt ?? '')}”`
    case 'comment.resolve':
      return 'resolved a comment'
    case 'comment.reopen':
      return 'reopened a comment'
    case 'comment.delete':
      return 'deleted a comment'
    case 'suggestion.create':
      if (d.ai_action) return aiAsk(String(d.ai_action), String(d.instruction ?? ''))
      return 'suggested a change'
    case 'suggestion.accept':
      return 'accepted a suggestion'
    case 'suggestion.reject':
      return 'rejected a suggestion'
    case 'suggestion.revise':
      return `asked the AI to revise a suggestion: “${String(d.instruction ?? '')}”`
    case 'user.login':
      return 'signed in'
    case 'token.create':
      return `created the access token “${String(d.label ?? '')}”`
    case 'token.revoke':
      return 'revoked an access token'
    case 'oauth.connect':
      return `connected the agent ${String(d.client ?? '')}`
    case 'mcp.call':
      return `called ${String(d.tool ?? 'a tool')}`
    case 'mcp.session':
      return `opened an MCP session${d.client ? ` with ${String(d.client)}${d.version ? ' ' + String(d.version) : ''}` : ''}`
    default:
      return e.kind
  }
}


// callArgs renders MCP call arguments on one line, for the audit log.
export function callArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  return Object.entries(args as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' · ')
}
