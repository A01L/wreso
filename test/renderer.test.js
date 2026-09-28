const test = require('node:test');
const assert = require('node:assert');
const { buildArgs, atempoChain } = require('../src/services/renderer');
const { clipRect, clipDuration } = require('../src/services/timeline');

const baseClip = {
  timeline_start: 0, source_in: 0, source_out: 4, speed: 1, volume: 1, muted: false,
  fade_in: 0, fade_out: 0, crop_left: 0, crop_top: 0, crop_right: 0, crop_bottom: 0,
  pos_x: 0, pos_y: 0, scale: 1, opacity: 1,
};
const comp = { width: 1920, height: 1080, fps: 30, background_color: '#112233' };

test('atempo is chained to stay within 0.5..2', () => {
  assert.deepStrictEqual(atempoChain(1), []);
  assert.deepStrictEqual(atempoChain(4), ['atempo=2', 'atempo=2']);
  assert.deepStrictEqual(atempoChain(0.25), ['atempo=0.5', 'atempo=0.5']);
  assert.deepStrictEqual(atempoChain(3), ['atempo=2', 'atempo=1.5']);
});

test('clip duration accounts for speed', () => {
  assert.strictEqual(clipDuration({ ...baseClip, source_in: 2, source_out: 6, speed: 2 }), 2);
});

test('clipRect fits the source inside the canvas (contain) and applies crop/scale/offset', () => {
  assert.deepStrictEqual(clipRect(baseClip, 1280, 720, 1920, 1080), { x: 0, y: 0, w: 1920, h: 1080 });
  // Square source in a 16:9 canvas is pillarboxed.
  assert.deepStrictEqual(clipRect(baseClip, 1000, 1000, 1920, 1080), { x: 420, y: 0, w: 1080, h: 1080 });
  const r = clipRect({ ...baseClip, scale: 0.5, pos_x: 100, pos_y: -50 }, 1920, 1080, 1920, 1080);
  assert.deepStrictEqual(r, { x: 580, y: 220, w: 960, h: 540 });
  // Cropping 25% on each side leaves a 1:2 source.
  const c = clipRect({ ...baseClip, crop_left: 0.25, crop_right: 0.25 }, 1000, 1000, 1000, 1000);
  assert.deepStrictEqual(c, { x: 250, y: 0, w: 500, h: 1000 });
});

test('buildArgs produces overlay + mixed audio graph', () => {
  const tracks = [
    { id: 't1', kind: 'video', position: 0, muted: false, hidden: false, volume: 1, clips: [
      { ...baseClip, id: 'img', timeline_start: 1, source_out: 2, opacity: 0.5 },
    ] },
    { id: 't2', kind: 'video', position: 1, muted: false, hidden: false, volume: 1, clips: [
      { ...baseClip, id: 'v1', source_in: 1, source_out: 5, speed: 2, crop_left: 0.1 },
    ] },
    { id: 't3', kind: 'audio', position: 2, muted: false, hidden: false, volume: 0.5, clips: [
      { ...baseClip, id: 'a1', timeline_start: 0.5, source_out: 3, fade_in: 1 },
    ] },
  ];
  const sources = new Map([
    ['img', { file: '/m/img.png', kind: 'image', width: 800, height: 800, hasVideo: true, hasAudio: false }],
    ['v1', { file: '/m/v.mp4', kind: 'video', width: 1280, height: 720, hasVideo: true, hasAudio: true }],
    ['a1', { file: '/m/a.mp3', kind: 'audio', width: null, height: null, hasVideo: false, hasAudio: true }],
  ]);
  const args = buildArgs({ composition: comp, tracks, duration: 4, sources, output: '/out.mp4' });
  const graph = args[args.indexOf('-filter_complex') + 1];

  assert.ok(graph.startsWith('color=c=0x112233:s=1920x1080:r=30:d=4'));
  // Bottom track (v1) is overlaid first, top track (img) last.
  assert.ok(graph.indexOf('[base][v0]overlay') < graph.indexOf('[o0][v1]overlay'));
  assert.match(graph, /setpts=\(PTS-STARTPTS\)\/2/);
  assert.match(graph, /crop=w=iw\*0\.9/);
  assert.match(graph, /colorchannelmixer=aa=0\.5/);
  assert.match(graph, /atempo=2/);
  assert.match(graph, /adelay=500:all=1/);
  assert.match(graph, /volume=0\.5/);
  assert.match(graph, /amix=inputs=2/);
  // Image input loops for the clip duration, video input seeks to source_in.
  assert.deepStrictEqual(args.slice(args.indexOf('/m/img.png') - 7, args.indexOf('/m/img.png') + 1),
    ['-loop', '1', '-framerate', '30', '-t', '2', '-i', '/m/img.png']);
  assert.deepStrictEqual(args.slice(args.indexOf('/m/v.mp4') - 5, args.indexOf('/m/v.mp4') + 1),
    ['-ss', '1', '-t', '4', '-i', '/m/v.mp4']);
  assert.strictEqual(args[args.length - 1], '/out.mp4');
});

test('muted clips/tracks and hidden tracks are skipped; silence is generated when nothing is audible', () => {
  const tracks = [
    { id: 't1', kind: 'video', position: 0, muted: true, hidden: true, volume: 1, clips: [
      { ...baseClip, id: 'v1' },
    ] },
    { id: 't2', kind: 'audio', position: 1, muted: false, hidden: false, volume: 1, clips: [
      { ...baseClip, id: 'a1', muted: true },
    ] },
  ];
  const sources = new Map([
    ['v1', { file: '/v.mp4', kind: 'video', width: 640, height: 360, hasVideo: true, hasAudio: true }],
    ['a1', { file: '/a.mp3', kind: 'audio', hasVideo: false, hasAudio: true }],
  ]);
  const args = buildArgs({ composition: comp, tracks, duration: 4, sources, output: '/o.mp4' });
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.ok(!graph.includes('overlay'));
  assert.ok(args.includes('anullsrc=r=48000:cl=stereo'));
  assert.ok(!args.includes('/v.mp4'));
});
