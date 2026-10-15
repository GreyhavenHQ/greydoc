import { useEffect } from 'react'
import features from '../../../docs/features.md?raw'
import { AppHeader } from '@/components/AppHeader'
import { Preview } from '@/render/Preview'

// Features is the built-in guide at /features, like HedgeDoc's features note. Its source is docs/features.md.
export default function Features() {
  useEffect(() => {
    document.title = 'Features · greydoc'
  }, [])
  return (
    <div className="min-h-screen">
      <AppHeader />
      <main className="mx-auto max-w-3xl px-6 py-10" data-testid="features-page">
        <Preview source={features} />
      </main>
    </div>
  )
}
