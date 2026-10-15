import { createContext, useContext, useEffect, useState } from 'react'
import { api, type Me } from '@/lib/api'
import { takeBoot } from '@/lib/boot'

const MeContext = createContext<{ me: Me | null; reload: () => void }>({ me: null, reload: () => {} })

export function MeProvider({ children }: { children: React.ReactNode }) {
  const [booted] = useState(() => (takeBoot('me') as Me | undefined) ?? null)
  const [me, setMe] = useState<Me | null>(booted)
  const reload = () => {
    api.get<Me>('/api/me').then(setMe).catch(() => setMe({ authenticated: false, local_mode: false, ai_enabled: false, login_url: '/auth/login' }))
  }
  useEffect(() => {
    if (!booted) reload()
  }, [booted])
  return <MeContext.Provider value={{ me, reload }}>{children}</MeContext.Provider>
}

export const useMe = () => useContext(MeContext)

export function loginHref(next = location.pathname + location.search) {
  return '/auth/login?next=' + encodeURIComponent(next)
}
