// Веб-сервер: сайт-дашборд, REST API, живые обновления (SSE) и MCP-эндпоинт.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Store, ValidationError, NotFoundError } from './store.js';
import { buildMcpServer } from './mcp.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createApp(store, { basicAuth, mcpSecret } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // MCP подключается до basic-auth: его защищает секрет в пути (см. README).
  const mcpPath = mcpSecret ? `/mcp/${mcpSecret}` : '/mcp';
  app.post(mcpPath, async (req, res) => {
    const server = buildMcpServer(store);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('MCP error:', e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });
  app.all(mcpPath, (_req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));

  if (basicAuth) {
    app.use((req, res, next) => {
      const [scheme, value] = String(req.headers.authorization || '').split(' ');
      const given = scheme === 'Basic' && value ? Buffer.from(value, 'base64').toString() : '';
      if (safeEqual(given, basicAuth)) return next();
      res.set('WWW-Authenticate', 'Basic realm="Team progress", charset="UTF-8"').status(401).send('Нужен логин и пароль');
    });
  }

  app.use(express.static(path.join(root, 'public')));

  const api = express.Router();
  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
      if (e instanceof NotFoundError) return res.status(404).json({ error: e.message });
      console.error(e);
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
  };

  api.get('/state', wrap(async () => store.snapshot()));
  api.post('/tasks', wrap(async (req) => store.addTask(req.body || {})));
  api.patch('/tasks/:id', wrap(async (req) => store.updateTask(req.params.id, req.body || {})));
  api.delete('/tasks/:id', wrap(async (req) => store.deleteTask(req.params.id)));
  api.post('/tasks/:id/criteria/:index', wrap(async (req) => store.checkCriterion(req.params.id, req.params.index, Boolean(req.body?.done))));
  api.put('/goal', wrap(async (req) => store.setGoal(req.body || {})));
  api.put('/metric', wrap(async (req) => store.setMetric(req.body || {})));
  api.post('/milestones', wrap(async (req) => store.addMilestone(req.body || {})));
  api.patch('/milestones/:id', wrap(async (req) => store.updateMilestone(req.params.id, req.body || {})));
  api.delete('/milestones/:id', wrap(async (req) => store.deleteMilestone(req.params.id)));
  api.put('/active-milestone', wrap(async (req) => store.setActiveMilestone(req.body?.id)));
  api.put('/aims/:milestone/:scope', wrap(async (req) => store.setAim(req.params.milestone, req.params.scope, req.body?.text)));

  // Server-Sent Events: каждое изменение (с сайта или от Claude) сразу прилетает всем открытым вкладкам.
  api.get('/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = (state) => res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
    send(store.snapshot());
    store.on('change', send);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); store.off('change', send); });
  });

  app.use('/api', api);
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const dataFile = path.resolve(process.env.DATA_FILE || path.join(root, 'data', 'db.json'));
  const seedFile = process.env.SEED_FILE ? path.resolve(process.env.SEED_FILE) : undefined;
  const store = await new Store(dataFile, { seedFile }).load();
  store.setMaxListeners(0);
  const app = createApp(store, { basicAuth: process.env.BASIC_AUTH, mcpSecret: process.env.MCP_SECRET });
  app.listen(port, host, () => {
    console.log(`Дашборд:     http://${host}:${port}`);
    console.log(`MCP для Claude: http://${host}:${port}${process.env.MCP_SECRET ? '/mcp/<MCP_SECRET>' : '/mcp'}`);
    console.log(`Данные:      ${dataFile}`);
  });
}
