// OpenAI-compatible stub for e2e tests: answers every chat request with a fixed refinement.
import http from 'node:http'

http
  .createServer((req, res) => {
    if (req.url === '/health') return res.end('ok')
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message: { content: 'The meeting went well.' } }] }))
    })
  })
  .listen(3998, '127.0.0.1')
