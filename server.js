// Pokecast — serves a local video library over HTTP and casts it to a
// Chromecast / Android TV. Run it directly to start the server; require() it
// to reuse the express app and helpers.

const express = require('express');
const path = require('path');
const fs = require('fs');
const dgram = require('dgram');
const { Bonjour } = require('bonjour-service');
const { Client, DefaultMediaReceiver } = require('castv2-client');

const ROOT = process.env.POKECAST_ROOT || __dirname;
const PORT = Number(process.env.POKECAST_PORT) || 8099;
const TV_NAME = process.env.POKECAST_TV || '';
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.avi', '.mov', '.m4v', '.webm']);
const MIME = { '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.avi': 'video/x-msvideo' };
const PROGRESS_FILE = path.join(ROOT, '.pokecast-progress.json');

let lanIp = '127.0.0.1';
let device = null;
let client = null;
let clientHost = null;
let player = null;
let playerReady = false;
let autoplayOn = false;
let volume = { level: null, muted: false };
let current = { rel: null, title: null, state: 'IDLE', currentTime: 0, duration: 0 };
let libraryCache = null;

const contentTypeFor = file => MIME[path.extname(file).toLowerCase()] || 'video/mp4';
const titleFor = file => path.basename(file).replace(/\.[^.]+$/, '');
const cmpNatural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const mediaUrl = rel => `http://${lanIp}:${PORT}/media/${rel.split(path.sep).map(encodeURIComponent).join('/')}`;

// Resume positions, keyed by relative path, persisted between runs.
function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); } catch { return {}; }
}
let progress = loadProgress();
let flushTimer = null;
function flushProgress() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => fs.writeFile(PROGRESS_FILE, JSON.stringify(progress), () => {}), 1500);
}
function saveProgress(rel, time, duration) {
  if (!rel || !time || time < 10) return;
  progress[rel] = { time, duration: duration || progress[rel]?.duration || 0, at: Date.now() };
  flushProgress();
}
function clearProgress(rel) {
  if (progress[rel]) { delete progress[rel]; flushProgress(); }
}

function scanLibrary() {
  const groups = {};
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) {
        const rel = path.relative(ROOT, full);
        const folder = path.dirname(rel) === '.' ? '(root)' : path.dirname(rel);
        (groups[folder] ??= []).push({ rel, name: titleFor(entry.name) });
      }
    }
  })(ROOT);

  libraryCache = Object.keys(groups).sort(cmpNatural).map(folder => ({
    folder,
    items: groups[folder].sort((a, b) => cmpNatural(a.name, b.name)).map(it => ({
      rel: it.rel,
      name: it.name,
      progress: progress[it.rel] ? { time: progress[it.rel].time, duration: progress[it.rel].duration } : null,
    })),
  }));
  return libraryCache;
}

// Ask the kernel which local address reaches the outside world. Picks the real
// LAN interface and ignores the Docker/VPN ones the TV cannot reach.
function getLanIp() {
  return new Promise(resolve => {
    const probe = dgram.createSocket('udp4');
    probe.once('error', () => { probe.close(); resolve('127.0.0.1'); });
    try {
      probe.connect(80, '8.8.8.8', () => {
        const ip = probe.address().address;
        probe.close();
        resolve(ip);
      });
    } catch { resolve('127.0.0.1'); }
  });
}

let bonjour = null;
let finder = null;
const discovered = new Map();
function pickDevice() {
  if (TV_NAME && discovered.has(TV_NAME)) device = { name: TV_NAME, host: discovered.get(TV_NAME) };
  else if (discovered.size) { const [name, host] = discovered.entries().next().value; device = { name, host }; }
}
function startDiscovery() {
  try { finder?.stop(); } catch {}
  try { bonjour?.destroy(); } catch {}
  bonjour = new Bonjour();
  finder = bonjour.find({ type: 'googlecast' });
  finder.on('up', svc => {
    const name = svc.txt?.fn || svc.txt?.n || svc.name;
    const host = (svc.addresses || []).find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || svc.referer?.address;
    if (name && host) { discovered.set(name, host); pickDevice(); }
  });
}

// Connect to the TV, reconnecting if it moved to a new IP.
function connect() {
  return new Promise((resolve, reject) => {
    if (!device) return reject(new Error('TV not found on the network (turn on the TV and try reconnecting)'));
    if (client && clientHost === device.host) return resolve(client);
    try { client?.close(); } catch {}
    client = player = null;
    playerReady = false;

    const c = new Client();
    let settled = false;
    c.on('error', err => {
      if (client === c) { try { c.close(); } catch {} client = player = null; playerReady = false; }
      if (!settled) { settled = true; reject(err); }
    });
    c.connect(device.host, () => {
      if (settled) return;
      settled = true;
      client = c;
      clientHost = device.host;
      resolve(c);
    });
  });
}

function launchReceiver() {
  return new Promise((resolve, reject) => {
    client.launch(DefaultMediaReceiver, (err, p) => {
      if (err) return reject(err);
      player = p;
      playerReady = true;
      p.on('status', onCastStatus);
      p.on('close', () => { playerReady = false; });
      resolve(p);
    });
  });
}

function onCastStatus(status) {
  if (!status) return;
  if (status.playerState) current.state = status.playerState;
  if (typeof status.currentTime === 'number') current.currentTime = status.currentTime;
  if (status.media?.duration) current.duration = status.media.duration;
  if (current.rel && current.state === 'PLAYING') saveProgress(current.rel, current.currentTime, current.duration);

  if (status.playerState === 'IDLE' && status.idleReason === 'FINISHED') {
    const finished = current.rel;
    clearProgress(finished);
    current.state = 'IDLE';
    if (autoplayOn) playNext(finished);
  }
}

async function cast(rel, resume = true) {
  await connect();
  if (!playerReady) await launchReceiver();

  const saved = progress[rel];
  const resumeAt = resume && saved && saved.time > 10 && (!saved.duration || saved.time < saved.duration - 30) ? saved.time : 0;
  const media = {
    contentId: mediaUrl(rel),
    contentType: contentTypeFor(rel),
    streamType: 'BUFFERED',
    metadata: { type: 0, metadataType: 0, title: titleFor(rel) },
  };
  current = { rel, title: titleFor(rel), state: 'BUFFERING', currentTime: resumeAt, duration: saved?.duration || 0 };

  await new Promise((resolve, reject) => {
    player.load(media, { autoplay: true, currentTime: resumeAt }, (err, status) => {
      if (err) return reject(err);
      onCastStatus(status);
      resolve();
    });
  });
  refreshVolume();
}

function playNext(rel) {
  for (const group of libraryCache || scanLibrary()) {
    const i = group.items.findIndex(it => it.rel === rel);
    if (i >= 0 && i + 1 < group.items.length) {
      cast(group.items[i + 1].rel, false).catch(err => console.error('autoplay failed:', err.message));
      return;
    }
  }
}

function refreshVolume() {
  try { client?.getVolume((err, v) => { if (!err && v) volume = v; }); } catch {}
}

// While something plays, the TV only pushes a status on changes, so poll for the
// current time to keep the seek bar and saved position fresh.
function startStatusPoll() {
  setInterval(() => {
    if (playerReady && (current.state === 'PLAYING' || current.state === 'PAUSED')) {
      try { player.getStatus((err, s) => { if (!err) onCastStatus(s); }); } catch {}
    }
  }, 4000);
}

const app = express();
app.use(express.json());

app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));

app.get('/api/library', (req, res) => res.json({ root: ROOT, tv: TV_NAME, groups: scanLibrary() }));

app.get('/api/status', (req, res) => res.json({
  device,
  connected: !!(client && device && clientHost === device.host),
  playback: current,
  volume,
  autoplay: autoplayOn,
  lanIp,
}));

app.post('/api/cast', async (req, res) => {
  try {
    await cast(req.body.rel, req.body.resume !== false);
    res.json({ ok: true, playback: current });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/control', (req, res) => {
  if (!playerReady) return res.status(409).json({ error: 'nothing playing' });
  const done = err => (err ? res.status(500).json({ error: String(err) }) : res.json({ ok: true }));
  switch (req.body.action) {
    case 'play': return player.play(done);
    case 'pause': return player.pause(done);
    case 'stop': return player.stop(err => { current.state = 'IDLE'; done(err); });
    default: return res.status(400).json({ error: 'invalid action' });
  }
});

app.post('/api/seek', (req, res) => {
  if (!playerReady) return res.status(409).json({ error: 'nothing playing' });
  player.seek(Math.max(0, Number(req.body.time) || 0), err =>
    err ? res.status(500).json({ error: String(err) }) : res.json({ ok: true }));
});

app.post('/api/volume', (req, res) => {
  if (!client) return res.status(409).json({ error: 'no connection' });
  client.setVolume({ level: Math.max(0, Math.min(1, Number(req.body.level))) }, (err, v) => {
    if (err) return res.status(500).json({ error: String(err) });
    if (v) volume = v;
    res.json({ ok: true, volume });
  });
});

app.post('/api/autoplay', (req, res) => {
  autoplayOn = !!req.body.on;
  res.json({ ok: true, autoplay: autoplayOn });
});

app.post('/api/reconnect', (req, res) => {
  discovered.clear();
  device = null;
  startDiscovery();
  setTimeout(() => res.json({ ok: true, device }), 2500);
});

app.post('/api/quit', (req, res) => {
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 200);
});

// The TV fetches the file from here; Range support is what makes seeking work.
app.get('/media/*', (req, res) => {
  let abs = path.resolve(ROOT, req.params[0] || '');
  if (!fs.existsSync(abs)) { try { abs = path.resolve(ROOT, decodeURIComponent(req.params[0])); } catch {} }
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return res.status(403).end();
  if (!VIDEO_EXT.has(path.extname(abs).toLowerCase())) return res.status(403).end();
  res.sendFile(abs, { acceptRanges: true, headers: { 'Content-Type': contentTypeFor(abs) } }, err => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

async function start() {
  lanIp = await getLanIp();
  startDiscovery();
  startStatusPoll();
  scanLibrary();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Pokecast: http://localhost:${PORT}  (media served at ${lanIp}:${PORT})`);
    console.log(TV_NAME ? `Searching for TV "${TV_NAME}" on the network...` : 'Searching for a cast device on the network...');
  });
}

// Boot only when run directly; required as a module for the tests.
if (require.main === module) start();

module.exports = { app, cmpNatural, scanLibrary, contentTypeFor, titleFor, mediaUrl };
