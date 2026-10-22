import { useEffect } from 'react'
import features from '../../../docs/features.md?raw'
import { AppHeader } from '@/components/AppHeader'
import { Preview } from '@/render/Preview'
import { WithToc } from '@/components/TocSidebar'

// Features is the built-in guide at /features, like HedgeDoc's features note. Its source is docs/features.md.
export default function Features() {
  useEffect(() => {
    document.title = 'Features · greydoc'
  }, [])
  return (
    <div className="min-h-screen">
      <AppHeader />
      <main data-testid="features-page">
        <WithToc show inset={24}>
          <div className="px-6 py-10">
            <Preview source={features} followHash />
          </div>
        </WithToc>
      </main>
    </div>
  )
}
