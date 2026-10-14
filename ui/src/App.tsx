import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import { MeProvider } from '@/lib/me'
import Home from '@/pages/Home'
import NewNote from '@/pages/NewNote'
import Editor from '@/pages/Editor'
import Settings from '@/pages/Settings'

export default function App() {
  return (
    <MeProvider>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/new" element={<NewNote />} />
        <Route path="/n/:alias" element={<Editor />} />
        <Route path="/settings" element={<Settings />} />
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
