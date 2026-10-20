import { Suspense, lazy } from 'react'
import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import { MeProvider } from '@/lib/me'
import View, { ShortShare } from '@/pages/View'

// Pages load on demand, so the view page does not download the editor.
const Home = lazy(() => import('@/pages/Home'))
const NewNote = lazy(() => import('@/pages/NewNote'))
const Editor = lazy(() => import('@/pages/Editor'))
const Settings = lazy(() => import('@/pages/Settings'))
const Trash = lazy(() => import('@/pages/Trash'))
const Audit = lazy(() => import('@/pages/Audit'))
const Groups = lazy(() => import('@/pages/Groups'))
const Login = lazy(() => import('@/pages/Login'))
const Slides = lazy(() => import('@/pages/Slides'))
const Features = lazy(() => import('@/pages/Features'))

export default function App() {
  return (
    <MeProvider>
      <Suspense fallback={null}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/new" element={<NewNote />} />
        <Route path="/login" element={<Login />} />
        <Route path="/n/:alias" element={<Editor />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/trash" element={<Trash />} />
        <Route path="/audit" element={<Audit />} />
        <Route path="/admin/groups" element={<Groups />} />
        <Route path="/s/:alias" element={<View />} />
        <Route path="/v/:token" element={<ShortShare />} />
        <Route path="/features" element={<Features />} />
        <Route path="/p/:alias" element={<Slides />} />
        <Route path="/:alias" element={<ShortLink />} />
        <Route path="/:alias/publish" element={<ShortLink to="/s/" />} />
        <Route path="/:alias/slide" element={<ShortLink to="/p/" />} />
        <Route path="/:alias/download" element={<ShortLink to="download" />} />
        <Route path="*" element={<Home />} />
      </Routes>
      </Suspense>
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
