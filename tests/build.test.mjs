import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, readdir } from 'node:fs/promises';
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
