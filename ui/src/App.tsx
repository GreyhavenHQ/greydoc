import { Suspense, lazy } from 'react'
import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import { MeProvider } from '@/lib/me'
import Home from '@/pages/Home'
import NewNote from '@/pages/NewNote'
import Editor from '@/pages/Editor'
import Settings from '@/pages/Settings'
import View, { ShortShare } from '@/pages/View'
import Trash from '@/pages/Trash'
import Audit from '@/pages/Audit'
import Login from '@/pages/Login'

const Slides = lazy(() => import('@/pages/Slides'))
const Features = lazy(() => import('@/pages/Features'))

export default function App() {
  return (
    <MeProvider>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/new" element={<NewNote />} />
        <Route path="/login" element={<Login />} />
        <Route path="/n/:alias" element={<Editor />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/trash" element={<Trash />} />
        <Route path="/audit" element={<Audit />} />
        <Route path="/s/:alias" element={<View />} />
        <Route path="/v/:token" element={<ShortShare />} />
        <Route
          path="/features"
          element={
            <Suspense fallback={null}>
              <Features />
            </Suspense>
          }
        />
        <Route
          path="/p/:alias"
          element={
            <Suspense fallback={null}>
              <Slides />
            </Suspense>
          }
        />
        <Route path="/:alias" element={<ShortLink />} />
        <Route path="/:alias/publish" element={<ShortLink to="/s/" />} />
        <Route path="/:alias/slide" element={<ShortLink to="/p/" />} />
        <Route path="/:alias/download" element={<ShortLink to="download" />} />
        <Route path="*" element={<Home />} />
      </Routes>
    </MeProvider>
  )
}

// ShortLink keeps HedgeDoc links working: /<id>, /<id>/publish, /<id>/slide and /<id>/download.
function ShortLink({ to = '/n/' }: { to?: string }) {
  const { alias = '' } = useParams()
  if (to === 'download') {
    location.replace(`/api/notes/${encodeURIComponent(alias)}/download.md`)
    return null
  }
  return <Navigate to={to + alias + location.search + location.hash} replace />
}
