import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, root } from '../scripts/build.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'portfolio-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ['settings', 'projects', 'posts', 'admin']) await cp(join(root, name), join(dir, name), { recursive: true });
  await cp(join(root, 'index.html'), join(dir, 'index.html'));
  return dir;
}
function embedded(html) {
  return JSON.parse(html.match(/<script id="site-content" type="application\/json">([\s\S]*?)<\/script>/)[1]);
}

test('build embeds every source field and preserves admin files', async t => {
  const dir = await fixture(t);
  const data = await build(dir);
  assert.deepEqual(embedded(await readFile(join(dir, 'dist/index.html'), 'utf8')), data);
  assert.equal(data.projects.length, (await readdir(join(dir, 'projects'))).filter(n => n.endsWith('.json')).length);
  assert.equal(data.posts.length, (await readdir(join(dir, 'posts'))).filter(n => n.endsWith('.json')).length);
  for (const name of ['config.yml', 'index.html']) assert.equal(await readFile(join(dir, 'admin', name), 'utf8'), await readFile(join(dir, 'dist/admin', name), 'utf8'));
  assert.doesNotMatch(await readFile(join(dir, 'dist/index.html'), 'utf8'), /api\.github\.com|download_url|atob\(/);
});

test('CMS create, edit, delete and empty collections are rebuilt without a manifest', async t => {
  const dir = await fixture(t);
  const initial = await build(dir);
  await writeFile(join(dir, 'projects/new.json'), JSON.stringify({ title: 'New', order: 1 }));
  await writeFile(join(dir, 'settings/profile.json'), JSON.stringify({ name: 'Updated' }));
  const updated = await build(dir);
  assert.equal(updated.profile.name, 'Updated');
  assert.equal(updated.projects.length, initial.projects.length + 1);
  for (const folder of ['projects', 'posts']) {
    await rm(join(dir, folder), { recursive: true });
    await mkdir(join(dir, folder));
  }
  const empty = await build(dir);
  assert.deepEqual(empty.projects, []);
  assert.deepEqual(empty.posts, []);
});

test('invalid or missing content fails the build and leaves last output intact', async t => {
  for (const content of ['{broken', '[]', 'null', '{"name":""}']) {
    const dir = await fixture(t);
    await build(dir);
    const previous = await readFile(join(dir, 'dist/index.html'), 'utf8');
    await writeFile(join(dir, 'settings/profile.json'), content);
    await assert.rejects(build(dir));
    assert.equal(await readFile(join(dir, 'dist/index.html'), 'utf8'), previous);
  }
  const dir = await fixture(t);
  await rm(join(dir, 'posts'), { recursive: true });
  await assert.rejects(build(dir));
});

test('JSON embedding escapes script terminators and preserves literal replacement patterns', async t => {
  const dir = await fixture(t);
  const name = '</script><script>alert(1)</script> $& $` $\' \u2028 \u2029';
  await writeFile(join(dir, 'settings/profile.json'), JSON.stringify({ name }));
  await build(dir);
  const html = await readFile(join(dir, 'dist/index.html'), 'utf8');
  assert.equal(embedded(html).profile.name, name);
  assert.ok(!html.includes('<script>alert(1)</script>'));
});

test('public media bytes are copied unchanged alongside embedded content', async t => {
  const dir = await fixture(t);
  await mkdir(join(dir, 'uploads'));
  const bytes = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0, 1, 255, 32]);
  await writeFile(join(dir, 'uploads/sample.ogg'), bytes);
  await build(dir);
  assert.deepEqual(await readFile(join(dir, 'dist/uploads/sample.ogg')), bytes);
});

test('portfolio folder links are embedded and CMS edits, deletion and invalid data are handled', async t => {
  const dir = await fixture(t);
  const items = [{ title: 'Folder <example>', url: 'https://drive.google.com/drive/folders/example', description: 'Portfolio folder' }];
  await writeFile(join(dir, 'settings/sounds.json'), JSON.stringify({ items }));
  const updated = await build(dir);
  assert.deepEqual(updated.sounds, items);
  assert.deepEqual(embedded(await readFile(join(dir, 'dist/index.html'), 'utf8')).sounds, items);
  await writeFile(join(dir, 'settings/sounds.json'), JSON.stringify({ items: [] }));
  assert.deepEqual((await build(dir)).sounds, []);
  const previous = await readFile(join(dir, 'dist/index.html'), 'utf8');
  for (const value of [{}, { items: null }, { items: [{ title: 'Unsafe URL', url: 'javascript:alert(1)' }] }, { items: [{ title: 'Missing URL' }] }, { items: [{ url: 'https://drive.google.com/drive/folders/example' }] }]) {
    await writeFile(join(dir, 'settings/sounds.json'), JSON.stringify(value));
    await assert.rejects(build(dir));
    assert.equal(await readFile(join(dir, 'dist/index.html'), 'utf8'), previous);
  }
});


async function waveformFixture(t) {
  const dir = await fixture(t);
  const url = '/uploads/wave-test.mp3';
  const bytes = Buffer.from('waveform-test-audio-bytes');
  const record = { sha256:createHash('sha256').update(bytes).digest('hex'), duration:12.5, peaks:Array.from({length:220}, (_, i) => i / 219) };
  await mkdir(join(dir, 'uploads'));
  await writeFile(join(dir, url.slice(1)), bytes);
  await writeFile(join(dir, 'projects/wave-test.json'), JSON.stringify({title:'Wave test',audio:url}));
  await writeFile(join(dir, 'settings/waveforms.json'), JSON.stringify({[url]:record}));
  return {dir, url, bytes, record};
}

test('waveform peaks are embedded only for currently referenced exact audio bytes', async t => {
  const {dir, url, record} = await waveformFixture(t);
  let data = await build(dir);
  assert.deepEqual(data.waveforms, {[url]:record});
  assert.deepEqual(embedded(await readFile(join(dir, 'dist/index.html'), 'utf8')).waveforms, data.waveforms);
  // CMS replaces bytes at the same URL: old visualization must disappear.
  await writeFile(join(dir, url.slice(1)), 'replacement audio');
  assert.deepEqual((await build(dir)).waveforms, {});
  // CMS points to a different or removed audio source: no stale record.
  await writeFile(join(dir, 'projects/wave-test.json'), JSON.stringify({title:'Wave test',audio:'/uploads/new.mp3'}));
  assert.deepEqual((await build(dir)).waveforms, {});
  await rm(join(dir, 'projects/wave-test.json'));
  assert.deepEqual((await build(dir)).waveforms, {});
});

test('missing, corrupt and malformed waveform metadata gracefully omit derived visualization', async t => {
  const {dir, url, record} = await waveformFixture(t);
  const malformed = [
    { ...record, peaks:[0,1] },
    { ...record, peaks:Array(220).fill(-0.1) },
    { ...record, peaks:Array(220).fill(1.1) },
    { ...record, peaks:Array(220).fill(null) },
    { ...record, duration:0 },
    { ...record, sha256:'stale' },
    null,
  ];
  for (const value of malformed) {
    await writeFile(join(dir, 'settings/waveforms.json'), JSON.stringify({[url]:value}));
    assert.deepEqual((await build(dir)).waveforms, {});
  }
  for (const value of ['{broken', '[]', 'null']) {
    await writeFile(join(dir, 'settings/waveforms.json'), value);
    assert.deepEqual((await build(dir)).waveforms, {});
  }
  await rm(join(dir, 'settings/waveforms.json'));
  assert.deepEqual((await build(dir)).waveforms, {});
});

test('waveform verification rejects path traversal and missing uploads', async t => {
  const {dir, url, record} = await waveformFixture(t);
  await rm(join(dir, url.slice(1)));
  assert.deepEqual((await build(dir)).waveforms, {});
  const traversal = '/uploads/../settings/profile.json';
  const profileBytes = await readFile(join(dir, 'settings/profile.json'));
  await writeFile(join(dir, 'projects/wave-test.json'), JSON.stringify({title:'Wave test',audio:traversal}));
  await writeFile(join(dir, 'settings/waveforms.json'), JSON.stringify({[traversal]:{...record,sha256:createHash('sha256').update(profileBytes).digest('hex')}}));
  assert.deepEqual((await build(dir)).waveforms, {});
});

test('published measured waveforms match original audio and have nondecorative variation', async t => {
  const output = await mkdtemp(join(tmpdir(), 'portfolio-waveforms-'));
  t.after(() => rm(output, {recursive:true, force:true}));
  const data = await build(root, output);
  // Do not freeze project count: future CMS additions/deletions must still build.
  for (const [url, record] of Object.entries(data.waveforms)) {
    assert.equal(record.sha256, createHash('sha256').update(await readFile(join(root, url.slice(1)))).digest('hex'));
    assert.equal(record.peaks.length, 220);
    assert.ok(new Set(record.peaks).size > 20);
    assert.equal(Math.max(...record.peaks), 1);
    assert.ok(record.duration > 0);
  }
});


function realWav(seconds, reverse = false) {
  const rate = 8000, length = Math.round(seconds * rate);
  const bytes = Buffer.alloc(44 + length * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(length * 2, 40);
  for (let i = 0; i < length; i++) {
    const ramp = reverse ? 1 - i / length : i / length;
    bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * (0.05 + 0.9 * ramp) * 32767), 44 + i * 2);
  }
  return bytes;
}

test('ordinary build automatically measures a new CMS upload and replacement bytes with no manual generator', async t => {
  const dir = await fixture(t);
  await mkdir(join(dir, 'uploads'));
  const url = '/uploads/new-cms.wav';
  await writeFile(join(dir, 'projects/new-cms.json'), JSON.stringify({title:'New upload',audio:url}));
  const cacheBefore = await readFile(join(dir, 'settings/waveforms.json'), 'utf8');
  const firstBytes = realWav(1);
  await writeFile(join(dir, url.slice(1)), firstBytes);
  const first = (await build(dir)).waveforms[url];
  assert.ok(first);
  assert.equal(first.sha256, createHash('sha256').update(firstBytes).digest('hex'));
  assert.equal(first.duration, 1);
  assert.equal(first.peaks.length, 220);
  assert.ok(first.peaks[0] < first.peaks.at(-1));
  // Simulate a committed cached version, then CMS replacement at identical URL.
  await writeFile(join(dir, 'settings/waveforms.json'), JSON.stringify({[url]:first}));
  const replacement = realWav(1.5, true);
  await writeFile(join(dir, url.slice(1)), replacement);
  const second = (await build(dir)).waveforms[url];
  assert.equal(second.sha256, createHash('sha256').update(replacement).digest('hex'));
  assert.notEqual(second.sha256, first.sha256);
  assert.equal(second.duration, 1.5);
  assert.ok(second.peaks[0] > second.peaks.at(-1));
  assert.notDeepEqual(second.peaks, first.peaks);
  assert.deepEqual(embedded(await readFile(join(dir, 'dist/index.html'), 'utf8')).waveforms[url], second);
  // Neither cache misses nor replacements silently mutate source metadata.
  assert.equal(await readFile(join(dir, 'settings/waveforms.json'), 'utf8'), JSON.stringify({[url]:first}));
  await writeFile(join(dir, 'settings/waveforms.json'), cacheBefore);
});

test('missing or invalid optional waveform cache does not stop automatic generation', async t => {
  const dir = await fixture(t);
  await mkdir(join(dir, 'uploads'));
  await writeFile(join(dir, 'uploads/uncached.wav'), realWav(0.5));
  await writeFile(join(dir, 'projects/uncached.json'), JSON.stringify({title:'Uncached',audio:'/uploads/uncached.wav'}));
  await rm(join(dir, 'settings/waveforms.json'));
  assert.equal((await build(dir)).waveforms['/uploads/uncached.wav'].duration, 0.5);
  await writeFile(join(dir, 'settings/waveforms.json'), '{broken');
  assert.equal((await build(dir)).waveforms['/uploads/uncached.wav'].peaks.length, 220);
});


test('waveform generation refuses symlink escapes from uploads', async t => {
  const {dir, record} = await waveformFixture(t);
  const url = '/uploads/escape.mp3';
  await symlink('../settings/profile.json', join(dir, url.slice(1)));
  const bytes = await readFile(join(dir, 'settings/profile.json'));
  await writeFile(join(dir, 'projects/wave-test.json'), JSON.stringify({title:'Escape',audio:url}));
  await writeFile(join(dir, 'settings/waveforms.json'), JSON.stringify({[url]:{...record,sha256:createHash('sha256').update(bytes).digest('hex')}}));
  assert.deepEqual((await build(dir)).waveforms, {});
});
