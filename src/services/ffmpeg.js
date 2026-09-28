const { spawn } = require('child_process');
const config = require('../config');

function run(bin, args, { onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (onStdout) onStdout(text);
      else stdout += text;
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    proc.on('error', (err) => reject(new Error(`Failed to start ${bin}: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${bin} exited with code ${code}: ${stderr.trim().split('\n').slice(-5).join('\n')}`));
    });
  });
}

function parseRate(rate) {
  if (!rate || rate === '0/0') return null;
  const [n, d] = rate.split('/').map(Number);
  const v = d ? n / d : n;
  return Number.isFinite(v) && v > 0 ? Math.round(v * 1000) / 1000 : null;
}

async function probe(file) {
  const out = await run(config.ffprobePath, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ]);
  const info = JSON.parse(out);
  const streams = info.streams || [];
  // Cover art in audio files shows up as a video stream with attached_pic.
  const video = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const audio = streams.find((s) => s.codec_type === 'audio');
  let duration = Number(info.format && info.format.duration);
  if (!Number.isFinite(duration) && video) duration = Number(video.duration);
  if (!Number.isFinite(duration) && audio) duration = Number(audio.duration);
  let width = video ? video.width : null;
  let height = video ? video.height : null;
  const rotation = video && video.side_data_list && video.side_data_list.find((d) => d.rotation !== undefined);
  const rotate = rotation ? Math.abs(Number(rotation.rotation)) : Number(video && video.tags && video.tags.rotate) || 0;
  if (rotate === 90 || rotate === 270) [width, height] = [height, width];
  return {
    formatName: info.format ? info.format.format_name : '',
    videoCodec: video ? video.codec_name : null,
    audioCodec: audio ? audio.codec_name : null,
    duration: Number.isFinite(duration) ? duration : null,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width,
    height,
    fps: video ? parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate) : null,
  };
}

async function thumbnail(input, output, { at = 0, isImage = false } = {}) {
  const args = ['-y', '-v', 'error'];
  if (!isImage) args.push('-ss', String(at));
  args.push('-i', input, '-frames:v', '1', '-vf', 'scale=320:-2', output);
  await run(config.ffmpegPath, args);
}

async function waveform(input, output) {
  await run(config.ffmpegPath, [
    '-y', '-v', 'error', '-i', input,
    '-filter_complex', 'aformat=channel_layouts=mono,showwavespic=s=1200x120:colors=#4fd1c5',
    '-frames:v', '1', output,
  ]);
}

/** Can Chrome/Firefox/Safari play this file directly in a <video> element? */
function isBrowserFriendly(info, ext) {
  const containers = ['.mp4', '.m4v', '.mov', '.webm'];
  const vcodecs = ['h264', 'vp8', 'vp9', 'av1'];
  const acodecs = [null, 'aac', 'mp3', 'opus', 'vorbis'];
  return containers.includes(ext) && vcodecs.includes(info.videoCodec) && acodecs.includes(info.audioCodec);
}

/** Lightweight H.264 copy for previewing formats browsers can't decode (MKV, AVI, HEVC, ProRes…). */
async function proxy(input, output) {
  await run(config.ffmpegPath, [
    '-y', '-v', 'error', '-i', input,
    '-vf', "scale=-2:'min(720,ih)'", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', output,
  ]);
}

module.exports = { run, probe, thumbnail, waveform, isBrowserFriendly, proxy };
