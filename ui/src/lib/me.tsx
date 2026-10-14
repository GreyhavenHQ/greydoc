import { createContext, useContext, useEffect, useState } from 'react'
import { api, type Me } from '@/lib/api'

const MeContext = createContext<{ me: Me | null; reload: () => void }>({ me: null, reload: () => {} })

export function MeProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  const reload = () => {
    api.get<Me>('/api/me').then(setMe).catch(() => setMe({ authenticated: false, local_mode: false, ai_enabled: false, login_url: '/auth/login' }))
  }
  useEffect(reload, [])
  return <MeContext.Provider value={{ me, reload }}>{children}</MeContext.Provider>
}

export const useMe = () => useContext(MeContext)

export function loginHref(next = location.pathname + location.search) {
  return '/auth/login?next=' + encodeURIComponent(next)
}
