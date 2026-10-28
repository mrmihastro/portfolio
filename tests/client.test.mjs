import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build, root } from '../scripts/build.mjs';

// Minimal DOM harness: execute the actual inline client, with every fetch failing.
export function client(html, payload, fetchImpl = async () => { throw new Error('Network unavailable'); }) {
  class Element {
    children = []; style = {}; dataset = {}; listeners = {}; attributes = {};
    classList = { add() {}, remove() {} }; value = '';
    set innerHTML(value) { this.value = value; this.children = []; }
    get innerHTML() { return this.value + this.children.map(c => c.innerHTML).join(''); }
    set textContent(value) { this.innerHTML = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); this.text = value; }
    get textContent() { return this.text; }
    setAttribute(name, value) { this.attributes[name] = value; }
    appendChild(child) { this.children.push(child); }
    addEventListener(event, callback) { this.listeners[event] = callback; }
  }
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const buttons = ['games', 'multimedia', 'concerts'].map(category => { const b = new Element(); b.dataset.category = category; return b; });
  get('site-content').textContent = payload;
  const requests = [];
  const context = vm.createContext({
    document: { getElementById: get, querySelectorAll: () => buttons, createElement: () => new Element() },
    window: { scrollY: 0, addEventListener() {}, requestAnimationFrame(fn) { fn(); } },
    console,
    fetch: (...args) => { requests.push(args[0]); return fetchImpl(...args); },
  });
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  vm.runInContext(script, context);
  return { get, buttons, requests, context };
}

async function built(t) {
  const output = await mkdtemp(join(tmpdir(), 'portfolio-client-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const data = await build(root, output);
  const html = await readFile(join(output, 'index.html'), 'utf8');
  return { data, html };
}

test('profile, every category, order, media and posts render with all network requests rejected', async t => {
  const { data, html } = await built(t);
  const { get, buttons, requests } = client(html, JSON.stringify(data));
  assert.equal(get('author-name').textContent, data.profile.name);
  assert.equal(get('author-avatar').src, data.profile.avatar);
  assert.ok(get('author-bio').innerHTML.length > 0);
  let count = 0;
  for (const button of buttons) {
    button.listeners.click();
    const expected = data.projects.filter(p => (p.category || 'games') === button.dataset.category).sort((a,b) => (Number(a.order)||999)-(Number(b.order)||999));
    const cards = get('projects-container').children;
    assert.equal(cards.length, expected.length);
    count += cards.length;
    expected.forEach((p, i) => {
      for (const value of [p.title, p.image, p.audio, p.link_url].filter(Boolean)) assert.ok(cards[i].innerHTML.includes(value), value);
      if (p.audio) assert.ok(cards[i].innerHTML.includes('preload="none"'));
    });
  }
  assert.equal(count, data.projects.length);
  const posts = data.posts.sort((a,b) => (Number(a.order)||999)-(Number(b.order)||999));
  assert.equal(get('posts-container').children.length, posts.length);
  posts.forEach((post, i) => assert.ok(get('posts-container').children[i].innerHTML.includes(post.title)));
  assert.deepEqual(requests, []);
});

test('HTTP 403/429/500 responses cannot affect portfolio: no content requests exist', async t => {
  const { data, html } = await built(t);
  for (const status of [403,429,500]) {
    const app = client(html, JSON.stringify(data), async () => ({ ok: false, status }));
    assert.equal(app.get('author-name').textContent, data.profile.name);
    assert.equal(app.get('posts-container').children.length, data.posts.length);
    assert.deepEqual(app.requests, []);
  }
});

test('missing/corrupt embedded content is an error, including after a category change', async t => {
  const { html } = await built(t);
  for (const payload of ['null', '{broken', '{}']) {
    const { get, buttons } = client(html, payload);
    for (const id of ['author-bio', 'projects-container', 'posts-container']) {
      assert.equal(get(id).children[0].attributes.role, 'alert');
      assert.match(get(id).children[0].textContent, /Не удалось загрузить/);
    }
    buttons[1].listeners.click();
    assert.match(get('projects-container').children[0].textContent, /Не удалось загрузить/);
  }
});

test('valid empty collections show empty states rather than errors', async t => {
  const { data, html } = await built(t);
  const { get } = client(html, JSON.stringify({ ...data, projects: [], posts: [] }));
  assert.match(get('projects-container').innerHTML, /пока нет проектов/);
  assert.match(get('posts-container').innerHTML, /Записи пока отсутствуют/);
});
