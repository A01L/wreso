const fs = require('fs');
const path = require('path');
const config = require('../config');

function ensureDirs() {
  for (const dir of Object.values(config.dirs)) fs.mkdirSync(dir, { recursive: true });
}

function mediaPath(filename) { return path.join(config.dirs.media, path.basename(filename)); }
function thumbPath(filename) { return path.join(config.dirs.thumbs, path.basename(filename)); }
function renderPath(filename) { return path.join(config.dirs.renders, path.basename(filename)); }

async function removeQuietly(file) {
  if (!file) return;
  await fs.promises.unlink(file).catch(() => {});
}

async function removeMediaFiles(media) {
  await removeQuietly(mediaPath(media.filename));
  if (media.thumbnail) await removeQuietly(thumbPath(media.thumbnail));
  if (media.waveform) await removeQuietly(thumbPath(media.waveform));
  if (media.proxy) await removeQuietly(mediaPath(media.proxy));
}

module.exports = { ensureDirs, mediaPath, thumbPath, renderPath, removeQuietly, removeMediaFiles };
