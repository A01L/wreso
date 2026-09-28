const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const config = require('./config');
const migrate = require('./migrate');
const storage = require('./services/storage');
const renderQueue = require('./services/renderQueue');
const { requireAuth } = require('./middleware/auth');
const { HttpError } = require('./errors');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '5mb' }));
  app.use(cookieParser());

  // State-changing API calls must be JSON or multipart — plain HTML forms from other sites can't send those
  // with credentials (SameSite=Lax cookie + CORS preflight), which blocks CSRF.
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const type = req.get('content-type') || '';
    if (req.method === 'DELETE' || type.startsWith('application/json') || type.startsWith('multipart/form-data')) return next();
    if (!req.get('content-length') || req.get('content-length') === '0') return next();
    next(new HttpError(415, 'Unsupported content type'));
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/projects', requireAuth, require('./routes/projects'));
  app.use('/api', requireAuth, require('./routes/media'));
  app.use('/api', requireAuth, require('./routes/compositions'));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  const pub = path.join(__dirname, '..', 'public');
  app.use(express.static(pub));
  app.get('/{*splat}', (req, res) => res.sendFile(path.join(pub, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || err.statusCode || 500;
    if (err.code === 'LIMIT_FILE_SIZE') status = 413;
    if (err.type === 'entity.parse.failed') status = 400;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
  });
  return app;
}

async function start() {
  storage.ensureDirs();
  if (config.autoMigrate) await migrate();
  await renderQueue.resume();
  const app = createApp();
  app.listen(config.port, () => console.log(`Wreso is running on http://localhost:${config.port}`));
}

module.exports = { createApp };

if (require.main === module) {
  start().catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
}
