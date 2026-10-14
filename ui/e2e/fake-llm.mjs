// OpenAI-compatible stub for e2e tests: answers every chat request with a fixed refinement.
import http from 'node:http'

http
  .createServer((req, res) => {
    if (req.url === '/health') return res.end('ok')
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      const asksDiagram = body.includes('Mermaid diagram') || body.includes('mermaid')
      const content = asksDiagram ? '```mermaid\nflowchart LR\n  W[Write] --> R[Review] --> S[Ship]\n```' : 'The meeting went well.'
      res.end(JSON.stringify({ choices: [{ message: { content } }] }))
    })
  })
  .listen(3998, '127.0.0.1')
