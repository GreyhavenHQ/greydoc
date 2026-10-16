// Minimal OIDC provider for e2e tests, and the greydoc server that signs in with it.
// GET /as/<username> picks who the next login is for in this browser.
import http from 'node:http'
import { spawn } from 'node:child_process'

const port = 3997
const issuer = `http://127.0.0.1:${port}`
const people = {
  alice: { name: 'Alice Martin' },
  bob: { name: 'Bob' },
  carol: { name: 'Carol' },
}
const codes = new Map()

const cookie = (req) => /(?:^|;\s*)idp_user=([a-z]+)/.exec(req.headers.cookie ?? '')?.[1]

http
  .createServer((req, res) => {
    const url = new URL(req.url, issuer)
    const json = (v) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(v))
    }
    if (url.pathname === '/.well-known/openid-configuration') {
      return json({ issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', userinfo_endpoint: issuer + '/userinfo' })
    }
    if (url.pathname.startsWith('/as/')) {
      res.setHeader('Set-Cookie', `idp_user=${url.pathname.slice(4)}; Path=/`)
      return res.end('ok')
    }
    if (url.pathname === '/authorize') {
      const user = cookie(req) ?? 'bob'
      const code = 'code-' + Math.random().toString(36).slice(2)
      codes.set(code, user)
      const back = new URL(url.searchParams.get('redirect_uri'))
      back.searchParams.set('code', code)
      back.searchParams.set('state', url.searchParams.get('state'))
      res.writeHead(302, { Location: back.toString() })
      return res.end()
    }
    if (url.pathname === '/token') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => json({ access_token: new URLSearchParams(body).get('code'), token_type: 'Bearer' }))
      return
    }
    if (url.pathname === '/userinfo') {
      const user = codes.get((req.headers.authorization ?? '').replace(/^Bearer /, ''))
      if (!user) {
        res.statusCode = 401
        return res.end()
      }
      return json({ sub: 'sub-' + user, preferred_username: user, name: people[user]?.name ?? user, email: user + '@example.com' })
    }
    res.statusCode = 404
    res.end()
  })
  .listen(port, '127.0.0.1', () => {
    const dir = '/tmp/greydoc-e2e-oidc'
    const env = {
      ...process.env,
      GREYDOC_DATABASE_URL: dir + '/greydoc.db',
      GREYDOC_DATA_DIR: dir + '/data',
      GREYDOC_SECRET_FILE: dir + '/secret',
      GREYDOC_BASE_URL: 'http://127.0.0.1:3996',
      GREYDOC_OIDC_ISSUER: issuer,
      GREYDOC_OIDC_CLIENT_ID: 'greydoc',
      GREYDOC_OIDC_CLIENT_SECRET: 'secret',
      GREYDOC_ROOM_SAVE_INTERVAL: '200ms',
      GREYDOC_ROOM_IDLE_GRACE: '500ms',
    }
    const app = spawn('sh', ['-c', `rm -rf ${dir} && mkdir -p ${dir} && exec ../bin/greydoc serve --port 3996`], { env, stdio: 'inherit' })
    const stop = () => app.kill()
    process.on('SIGTERM', stop)
    process.on('SIGINT', stop)
    process.on('exit', stop)
    app.on('exit', (code) => process.exit(code ?? 0))
  })
