import { Suspense, lazy } from 'react'
import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import { MeProvider } from '@/lib/me'
import Home from '@/pages/Home'
import NewNote from '@/pages/NewNote'
import Editor from '@/pages/Editor'
import Settings from '@/pages/Settings'
import View from '@/pages/View'
import Trash from '@/pages/Trash'
import Audit from '@/pages/Audit'

const Slides = lazy(() => import('@/pages/Slides'))

export default function App() {
  return (
    <MeProvider>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/new" element={<NewNote />} />
        <Route path="/n/:alias" element={<Editor />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/trash" element={<Trash />} />
        <Route path="/audit" element={<Audit />} />
        <Route path="/s/:alias" element={<View />} />
        <Route
          path="/p/:alias"
          element={
            <Suspense fallback={null}>
              <Slides />
            </Suspense>
          }
        />
        <Route path="/:alias" element={<ShortLink />} />
        <Route path="*" element={<Home />} />
      </Routes>
    </MeProvider>
  )
}

function ShortLink() {
  const { alias } = useParams()
  return <Navigate to={'/n/' + alias + location.search} replace />
}
