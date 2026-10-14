import { Link, useNavigate } from 'react-router-dom'
import { LogIn, LogOut, Moon, Plus, Settings, Sun } from 'lucide-react'
import { Logo } from '@/components/Logo'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTheme } from '@/lib/theme'
import { loginHref, useMe } from '@/lib/me'
import { localName, setLocalName } from '@/lib/presence'

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle theme"
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
    >
      {resolvedTheme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  )
}

export function UserMenu() {
  const { me } = useMe()
  if (!me) return null
  if (!me.authenticated) {
    return (
      <Button variant="outline" size="sm" asChild>
        <a href={loginHref()}>
          <LogIn className="size-4" /> Sign in
        </a>
      </Button>
    )
  }
  const name = me.local_mode ? localName() : me.display_name || me.username
  const initials = (name ?? '?')
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="rounded-full bg-muted text-xs font-semibold" aria-label="Account">
          {initials}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="text-sm font-medium">{name}</div>
          <div className="text-xs text-muted-foreground">
            {me.local_mode ? 'Local mode, no sign-in' : '@' + me.username}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/settings">
            <Settings className="size-4" /> Settings and agents
          </Link>
        </DropdownMenuItem>
        {me.local_mode ? (
          <DropdownMenuItem
            onSelect={() => {
              const n = prompt('Name shown to other editors', name)
              if (n && n.trim()) {
                setLocalName(n.trim())
                location.reload()
              }
            }}
          >
            Change display name
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem asChild>
            <form method="post" action="/auth/logout" className="w-full">
              <button type="submit" className="flex w-full items-center gap-2">
                <LogOut className="size-4" /> Sign out
              </button>
            </form>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function NewNoteButton({ size = 'sm' }: { size?: 'sm' | 'default' | 'lg' }) {
  const navigate = useNavigate()
  return (
    <Button size={size} onClick={() => navigate('/new')}>
      <Plus className="size-4" /> New note
    </Button>
  )
}

export function AppHeader({ children }: { children?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur">
      <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
        <Logo className="h-6 text-foreground" />
        <span>greydoc</span>
      </Link>
      <div className="flex flex-1 items-center gap-2">{children}</div>
      <ThemeToggle />
      <UserMenu />
    </header>
  )
}
