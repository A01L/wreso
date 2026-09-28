const path = require('path');
require('dotenv').config({ quiet: true });

const env = process.env;
const root = path.resolve(__dirname, '..');

const config = {
  port: Number(env.PORT) || 3000,
  jwtSecret: env.JWT_SECRET || 'dev-secret-change-me',
  cookieSecure: env.COOKIE_SECURE === 'true',
  db: {
    host: env.DB_HOST || '127.0.0.1',
    port: Number(env.DB_PORT) || 3306,
    user: env.DB_USER || 'wreso',
    password: env.DB_PASSWORD || 'wreso',
    database: env.DB_NAME || 'wreso',
  },
  autoMigrate: env.DB_AUTO_MIGRATE !== 'false',
  storageDir: path.resolve(root, env.STORAGE_DIR || 'storage'),
  maxUploadBytes: (Number(env.MAX_UPLOAD_MB) || 2048) * 1024 * 1024,
  ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: env.FFPROBE_PATH || 'ffprobe',
  renderConcurrency: Math.max(1, Number(env.RENDER_CONCURRENCY) || 1),
};

config.dirs = {
  media: path.join(config.storageDir, 'media'),
  thumbs: path.join(config.storageDir, 'thumbs'),
  renders: path.join(config.storageDir, 'renders'),
  tmp: path.join(config.storageDir, 'tmp'),
};

if (!env.JWT_SECRET && env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be set in production');
}

module.exports = config;
