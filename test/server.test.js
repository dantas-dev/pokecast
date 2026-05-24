const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A throwaway media library, built before the server is required so that
// scanLibrary() runs against known content instead of the real folder.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pokecast-'));
fs.mkdirSync(path.join(fixture, 'Season 1'));
fs.writeFileSync(path.join(fixture, 'Season 1', 'Ep 1.mp4'), Buffer.alloc(2048, 1));
fs.writeFileSync(path.join(fixture, 'Season 1', 'Ep 2.mp4'), Buffer.alloc(1024, 2));
fs.writeFileSync(path.join(fixture, 'Season 1', 'Ep 10.mp4'), Buffer.alloc(512, 3));
fs.writeFileSync(path.join(fixture, 'Movie.mp4'), Buffer.alloc(4096, 4));
fs.writeFileSync(path.join(fixture, 'notes.txt'), 'ignore me');

process.env.POKECAST_ROOT = fixture;
const app = require('../server.js');

let base;
let server;

before(async () => {
  server = app.app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(fixture, { recursive: true, force: true });
});

const post = (route, body) =>
  fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('cmpNatural sorts numbers as numbers, not text', () => {
  assert.deepEqual(['Ep 10', 'Ep 2', 'Ep 1'].sort(app.cmpNatural), ['Ep 1', 'Ep 2', 'Ep 10']);
});

test('contentTypeFor maps known extensions and defaults to mp4', () => {
  assert.equal(app.contentTypeFor('a.mp4'), 'video/mp4');
  assert.equal(app.contentTypeFor('a.mkv'), 'video/x-matroska');
  assert.equal(app.contentTypeFor('a.webm'), 'video/webm');
  assert.equal(app.contentTypeFor('a.avi'), 'video/x-msvideo');
  assert.equal(app.contentTypeFor('a.unknown'), 'video/mp4');
});

test('titleFor drops the folder and the extension', () => {
  assert.equal(app.titleFor('Season 1/Ep 1.mp4'), 'Ep 1');
});

test('mediaUrl percent-encodes each segment but keeps the slashes', () => {
  assert.match(app.mediaUrl('Season 1/Herói.mp4'), /\/media\/Season%201\/Her%C3%B3i\.mp4$/);
});

test('scanLibrary groups by folder, sorts naturally, ignores non-video', () => {
  const byFolder = Object.fromEntries(app.scanLibrary().map(g => [g.folder, g.items.map(i => i.name)]));
  assert.deepEqual(byFolder['Season 1'], ['Ep 1', 'Ep 2', 'Ep 10']);
  assert.deepEqual(byFolder['(root)'], ['Movie']);
  assert.ok(!Object.values(byFolder).flat().includes('notes'));
});

test('GET /api/library mirrors the library', async () => {
  const res = await fetch(base + '/api/library');
  assert.equal(res.status, 200);
  const { groups } = await res.json();
  const season = groups.find(g => g.folder === 'Season 1');
  assert.deepEqual(season.items.map(i => i.name), ['Ep 1', 'Ep 2', 'Ep 10']);
});

test('GET /api/status reports an idle, disconnected server', async () => {
  const s = await (await fetch(base + '/api/status')).json();
  assert.equal(s.device, null);
  assert.equal(s.playback.state, 'IDLE');
  assert.equal(s.autoplay, false);
  assert.ok('lanIp' in s);
});

test('GET /media serves a byte range with 206', async () => {
  const res = await fetch(base + '/media/Season%201/Ep%201.mp4', { headers: { Range: 'bytes=0-9' } });
  assert.equal(res.status, 206);
  assert.equal(Buffer.from(await res.arrayBuffer()).length, 10);
});

test('GET /media refuses non-video files', async () => {
  assert.equal((await fetch(base + '/media/notes.txt')).status, 403);
});

test('GET /media blocks path traversal', async () => {
  assert.equal((await fetch(base + '/media/..%2f..%2f..%2fetc%2fpasswd')).status, 403);
});

test('GET /media is 404 for a missing file', async () => {
  assert.equal((await fetch(base + '/media/Season%201/Nope.mp4')).status, 404);
});

test('controls answer 409 while nothing is playing', async () => {
  assert.equal((await post('/api/control', { action: 'pause' })).status, 409);
  assert.equal((await post('/api/seek', { time: 5 })).status, 409);
  assert.equal((await post('/api/volume', { level: 0.5 })).status, 409);
});

test('POST /api/autoplay flips the flag', async () => {
  assert.equal((await (await post('/api/autoplay', { on: true })).json()).autoplay, true);
  assert.equal((await (await fetch(base + '/api/status')).json()).autoplay, true);
  await post('/api/autoplay', { on: false });
});
