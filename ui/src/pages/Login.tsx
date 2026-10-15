import { Navigate } from 'react-router-dom'
import { Logo } from '@/components/Logo'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useMe } from '@/lib/me'

function nextPath(): string {
  const next = new URLSearchParams(location.search).get('next') ?? '/'
  return next.startsWith('/') && !next.startsWith('//') ? next : '/'
}

// SignInCard is the whole sign-in screen: one centered card, as in llmproxy.
export function SignInCard({ next = nextPath() }: { next?: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4" data-testid="sign-in">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <Logo className="mx-auto mb-2 h-10" />
          <CardTitle className="font-serif text-2xl">greydoc</CardTitle>
          <CardDescription>Shared notes, written together.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button className="w-full" onClick={() => (window.location.href = '/auth/login?next=' + encodeURIComponent(next))}>
            Sign in
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

export default function Login() {
  const { me } = useMe()
  if (!me) return null
  if (me.authenticated) return <Navigate to={nextPath()} replace />
  return <SignInCard />
}
