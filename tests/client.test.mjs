import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build, root } from '../scripts/build.mjs';

// Minimal DOM harness: execute the actual inline client, with every fetch failing.
export function client(html, payload, fetchImpl = async () => { throw new Error('Network unavailable'); }, options = {}) {
  const animations = [];
  class Element {
    children = []; style = {}; dataset = {}; listeners = {}; attributes = {};
    classes = new Set();
    classList = { add: value => this.classes.add(value), remove: value => this.classes.delete(value), contains: value => this.classes.has(value) }; value = '';
    paused = true; currentTime = 0; duration = NaN; volume = 1;
    pause() { this.paused = true; this.emit('pause'); }
    playCount = 0; loadCount = 0;
    play() { this.paused = false; this.playCount++; this.emit('play'); return Promise.resolve(); }
    load() { this.loadCount++; this.currentTime = 0; this.duration = NaN; this.emit('emptied'); this.emit('loadstart'); }
    emit(event) { this.listeners[event]?.({ target: this }); documentListeners[event]?.({ target: this }); }
    focus() { this.focused = true; }
    getBoundingClientRect() {
      if (this.id === 'hero-block') {
        const top = (options.cardBaseTop ?? 100) + (parseFloat(elements.get('intro-top-spacer')?.style.height) || 0);
        const height = options.cardHeight ?? 400;
        return { top, height, bottom: top + height };
      }
      return { top: 0, bottom: parseFloat(this.style.height) || 0, height: parseFloat(this.style.height) || 0 };
    }
    animate(keyframes, timing) {
      let resolveFinished;
      const animation = { target: this, keyframes, timing, cancelled: false, finished: new Promise(resolve => { resolveFinished = resolve; }), cancel() { this.cancelled = true; }, async finish() { resolveFinished(); await this.finished; await Promise.resolve(); } };
      animations.push(animation); return animation;
    }
    scrollIntoView(options) { this.scrolled = true; this.scrollOptions = options; this.scrollCount = (this.scrollCount || 0) + 1; }
    resetCount = 0;
    reset() { this.resetCount++; }
    matches(selector) { return selector.split(',').some(tag => tag.trim().toUpperCase() === this.tagName); }
    set innerHTML(value) { this.value = value; this.children = []; }
    get innerHTML() { return this.value + this.children.map(c => c.innerHTML).join(''); }
    set textContent(value) { this.innerHTML = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); this.text = value; }
    get textContent() { return this.text; }
    querySelectorAll(selector) { return selector === 'button' ? this.children.filter(child => child.tagName === 'BUTTON') : []; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    appendChild(child) { this.children.push(child); }
    addEventListener(event, callback) { this.listeners[event] = callback; }
  }
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) {
      const element = new Element();
      element.id = id;
      if (options.noAnimate) element.animate = undefined;
      const markup = html.match(new RegExp('<[^>]+id="' + id + '"[^>]*>'))?.[0] || '';
      element.hidden = /\bhidden\b/.test(markup);
      element.disabled = /\bdisabled\b/.test(markup);
      if (id === 'featured-audio') { element.tagName = 'AUDIO'; media.push(element); }
      elements.set(id, element);
    }
    return elements.get(id);
  };
  const categories = [...html.matchAll(/data-category="([^"]+)"/g)].map(match => match[1]);
  const buttons = [...new Set(categories)].map(category => { const b = new Element(); b.dataset.category = category; return b; });
  const media = [];
  const documentListeners = {};
  const windowListeners = {};
  const browserWindow = { innerHeight: options.innerHeight ?? 800, scrollY: options.scrollY || 0, location: { hash: options.hash || '', pathname: '/', search: options.search || '' }, history: { state: options.historyState || null, calls: 0, replaceState(state, title, url) { this.state = state; this.calls++; if (url !== undefined) { this.lastURL = url; browserWindow.location.hash = url.includes('#') ? '#' + url.split('#')[1] : ''; } } }, scrollCalls: [], scrollTo(value) { this.scrollCalls.push(value); this.scrollY = value.top; }, addEventListener(event, callback) { windowListeners[event] = callback; }, removeEventListener(event) { delete windowListeners[event]; }, requestAnimationFrame(fn) { fn(); }, matchMedia() { return { matches: !!options.reducedMotion }; } };
  const addMedia = (tagName = 'AUDIO') => { const element = new Element(); element.tagName = tagName; media.push(element); return element; };
  get('site-content').textContent = payload;
  const requests = [];
  const context = vm.createContext({
    document: {
      timeline: options.noTimeline ? undefined : { currentTime: 1234 },
      getElementById: get,
      querySelectorAll: selector => selector === '.filter-btn' ? buttons : /audio|video/.test(selector) ? media : [],
      createElement: tag => { const element = new Element(); element.tagName = tag.toUpperCase(); return element; },
      addEventListener: (event, callback) => { documentListeners[event] = callback; },
    },
    window: browserWindow,
    console,
    FormData: class { constructor(form) { this.form = form; } },
    fetch: (...args) => { requests.push(args[0]); return fetchImpl(...args); },
  });
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  vm.runInContext(script, context);
  return { get, buttons, requests, context, documentListeners, windowListeners, browserWindow, media, addMedia, animations, async finishAnimations() { await Promise.all(animations.map(animation => animation.finish())); await Promise.resolve(); await Promise.resolve(); } };
}

function escapeHtml(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

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
  for (const button of buttons.filter(button => button.dataset.category !== 'all')) {
    button.listeners.click();
    const expected = data.projects.filter(p => (p.category || 'games') === button.dataset.category).sort((a,b) => (Number(a.order)||999)-(Number(b.order)||999));
    const cards = get('projects-container').children;
    assert.equal(cards.length, expected.length);
    count += cards.length;
    expected.forEach((p, i) => {
      for (const value of [p.title, p.image, p.audio, p.link_url].filter(Boolean)) assert.ok(cards[i].innerHTML.includes(escapeHtml(value)), value);
      if (p.audio) assert.ok(cards[i].innerHTML.includes(`data-play-url="${escapeHtml(p.audio)}"`));
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

test('music selector lists all ordered track titles independently of catalog filters', async t => {
  const { data, html } = await built(t);
  const app = client(html, JSON.stringify(data));
  const expected = data.projects.filter(p => p.audio).sort((a,b) => (Number(a.order)||999)-(Number(b.order)||999));
  const tracks = app.get('selected-container').children;
  assert.equal(tracks.length, expected.length);
  expected.forEach((project, index) => {
    assert.ok(tracks[index].innerHTML.includes(escapeHtml(project.audio_title || project.title)));
    assert.equal(tracks[index].attributes['aria-label'], 'Слушать: ' + (project.audio_title || project.title));
    assert.ok(tracks[index].innerHTML.includes('track-duration'));
    assert.equal(tracks[index].tagName, 'BUTTON');
    assert.equal(tracks[index].attributes['aria-controls'], 'featured-audio');
  });
  assert.equal(app.get('featured-audio').src, expected[0].audio);
  assert.equal(app.get('featured-audio').playCount, 0);
  assert.equal(tracks[0].attributes['aria-current'], 'true');
  app.buttons.find(button => button.dataset.category === 'concerts').listeners.click();
  assert.equal(app.get('selected-container').children.length, expected.length);
});

test('all catalog filter and repeated category changes maintain accessible selection', async t => {
  const { data, html } = await built(t);
  const app = client(html, JSON.stringify(data));
  assert.equal(app.get('projects-container').children.length, data.projects.length);
  for (const category of ['games', 'concerts', 'concerts', 'multimedia', 'all', 'games', 'all']) {
    const button = app.buttons.find(button => button.dataset.category === category);
    assert.ok(button, category);
    button.listeners.click();
    const expected = category === 'all' ? data.projects : data.projects.filter(p => (p.category || 'games') === category);
    assert.equal(app.get('projects-container').children.length, expected.length);
    for (const other of app.buttons) assert.equal(other.attributes['aria-pressed'], String(other === button));
  }
  assert.deepEqual(app.requests, []);
});

test('portfolio folder cards provide escaped accessible links without audio players', async t => {
  const { data, html } = await built(t);
  const sounds = [
    { title: 'Озвучка <пример>', description: 'Примеры озвучки', url: 'https://drive.google.com/drive/folders/voice123' },
    { title: 'Звуки', description: 'Звуковые материалы', url: 'https://drive.google.com/drive/folders/sound123' },
  ];
  const app = client(html, JSON.stringify({ ...data, sounds }));
  const cards = app.get('sound-container').children;
  assert.equal(cards.length, 2);
  sounds.forEach((sound, index) => {
    const markup = cards[index].innerHTML;
    assert.ok(markup.includes(escapeHtml(sound.title)));
    assert.ok(markup.includes(`href="${sound.url}"`));
    assert.ok(markup.includes('target="_blank" rel="noopener noreferrer"'));
    assert.ok(markup.includes('Открыть папку на Google Диске'));
    assert.ok(!markup.includes('<audio'));
    assert.ok(!markup.includes('<пример>'));
  });
  assert.deepEqual(app.requests, []);
});

test('playing native audio or video pauses every other player, including repeated changes', async t => {
  const { data, html } = await built(t);
  const app = client(html, JSON.stringify(data));
  const first = app.addMedia(), second = app.addMedia(), video = app.addMedia('VIDEO');
  for (const target of [first, second, second, video, first]) {
    app.media.forEach(media => { media.paused = false; });
    app.documentListeners.play({ target });
    app.media.forEach(media => assert.equal(media.paused, media !== target));
  }
  app.media.forEach(media => { media.paused = false; });
  app.documentListeners.play({ target: { tagName: 'BUTTON' } });
  assert.ok(app.media.every(media => !media.paused));
});

test('sound collections have explicit empty and corrupt states', async t => {
  const { data, html } = await built(t);
  const empty = client(html, JSON.stringify({ ...data, sounds: [] }));
  assert.match(empty.get('sound-container').innerHTML, /Ссылки на портфолио скоро появятся/);
  const corrupt = client(html, JSON.stringify({ ...data, sounds: null }));
  assert.equal(corrupt.get('sound-container').children[0].attributes.role, 'alert');
});

test('contact submission prevents duplicates and recovers cleanly from failure to success', async t => {
  const { data, html } = await built(t);
  let resolveRequest;
  const app = client(html, JSON.stringify(data), () => new Promise(resolve => { resolveRequest = resolve; }));
  const form = app.get('contact-form'), submit = app.get('submit-btn'), status = app.get('form-status');
  const event = { preventDefault() {} };
  const first = form.listeners.submit(event);
  assert.equal(submit.disabled, true);
  await form.listeners.submit(event);
  assert.equal(app.requests.length, 1);
  resolveRequest({ ok: false });
  await first;
  assert.equal(submit.disabled, false);
  assert.equal(form.resetCount, 0);
  assert.equal(status.style.color, '#ff6b6b');
  const retry = form.listeners.submit(event);
  assert.equal(app.requests.length, 2);
  resolveRequest({ ok: true });
  await retry;
  assert.equal(status.style.color, '');
  assert.equal(status.className, 'form-status success');
  assert.equal(form.resetCount, 1);
  assert.equal(submit.disabled, false);
});

test('unified music player supports title selection, wrapping previous/next and native status changes', async t => {
  const { data, html } = await built(t);
  const app = client(html, JSON.stringify(data));
  const tracks = app.get('selected-container').children;
  const audio = app.get('featured-audio');
  const expected = data.projects.filter(p => p.audio).sort((a,b) => (Number(a.order)||999)-(Number(b.order)||999));
  const otherAudio = app.addMedia();
  otherAudio.paused = false;
  app.get('prev-track').listeners.click();
  assert.equal(audio.src, expected.at(-1).audio);
  assert.equal(otherAudio.paused, true);
  app.get('next-track').listeners.click();
  assert.equal(audio.src, expected[0].audio);
  for (const index of [2, 2, 4, 1]) {
    const loads = audio.loadCount;
    const oldSource = audio.src;
    tracks[index].listeners.click();
    assert.equal(audio.src, expected[index].audio);
    assert.equal(audio.loadCount, loads + (oldSource === audio.src ? 0 : 1));
    assert.equal(app.get('featured-title').textContent, expected[index].audio_title || expected[index].title);
    tracks.forEach((button, i) => assert.equal(button.attributes['aria-current'], String(i === index)));
  }
  audio.emit('waiting');
  assert.equal(app.get('featured-status').textContent, 'Загрузка…');
  audio.emit('playing');
  assert.equal(app.get('featured-status').textContent, '');
  audio.emit('error');
  assert.match(app.get('featured-status').textContent, /Не удалось загрузить/);
  tracks[0].listeners.click();
  audio.emit('playing');
  assert.equal(app.get('featured-status').textContent, '');
  audio.emit('ended');
  assert.equal(app.get('featured-status').textContent, 'Композиция завершена');
});

test('catalog listening actions reuse unified audio and focus its controls', async t => {
  const { data, html } = await built(t);
  const app = client(html, JSON.stringify(data));
  const project = data.projects.find(p => p.category === 'concerts');
  app.documentListeners.click({ target: { closest: selector => selector === '[data-play-url]' ? { dataset: { playUrl: project.audio } } : null } });
  assert.equal(app.get('featured-audio').src, project.audio);
  assert.equal(app.get('player-toggle').focused, true);
  assert.notEqual(app.get('portfolio-start').scrolled, true);
  assert.equal(app.get('player-dock').hidden, false);
  assert.equal(app.get('featured-title').textContent, project.audio_title || project.title);
});

test('empty music disables transport without requesting playback', async t => {
  const { data, html } = await built(t);
  const app = client(html, JSON.stringify({ ...data, projects: [] }));
  assert.equal(app.get('prev-track').disabled, true);
  assert.equal(app.get('next-track').disabled, true);
  assert.equal(app.get('featured-audio').hidden, true);
  app.get('next-track').listeners.click();
  assert.equal(app.get('featured-audio').playCount, 0);
});

test('rapid track changes ignore stale playback rejection and show current failure', async t => {
  const { data, html } = await built(t);
  const app = client(html, JSON.stringify(data));
  const audio = app.get('featured-audio');
  const tracks = app.get('selected-container').children;
  const failures = [];
  audio.play = () => new Promise((resolve, reject) => failures.push(reject));
  tracks[1].listeners.click();
  tracks[2].listeners.click();
  failures[0](new Error('Interrupted by newer track'));
  await Promise.resolve();
  assert.equal(app.get('featured-status').textContent, 'Загрузка…');
  failures[1](new Error('Current media cannot play'));
  await Promise.resolve();
  assert.match(app.get('featured-status').textContent, /Не удалось начать воспроизведение/);
});

test('floating dock starts hidden and opens, pauses, resumes, closes and reopens from track controls', async t => {
  const { data, html } = await built(t);
  const app = client(html, JSON.stringify(data));
  const audio = app.get('featured-audio'), dock = app.get('player-dock'), toggle = app.get('player-toggle');
  const tracks = app.get('selected-container').children;
  assert.equal(dock.hidden, true);
  assert.equal(audio.hidden, true);
  assert.equal(audio.playCount, 0);
  assert.doesNotMatch(html.match(/<audio[^>]*id="featured-audio"[^>]*>/)[0], /\bcontrols\b/);
  tracks[1].listeners.click();
  assert.equal(dock.hidden, false);
  assert.equal(app.get('page-body').classList.contains('player-open'), true);
  assert.equal(audio.paused, false);
  assert.equal(toggle.attributes['aria-label'], 'Приостановить');
  toggle.listeners.click();
  assert.equal(audio.paused, true);
  assert.equal(toggle.attributes['aria-label'], 'Воспроизвести');
  toggle.listeners.click();
  assert.equal(audio.paused, false);
  app.get('player-close').listeners.click();
  assert.equal(dock.hidden, true);
  assert.equal(audio.paused, true);
  assert.equal(app.get('page-body').classList.contains('player-open'), false);
  assert.equal(tracks[1].focused, true);
  tracks[4].listeners.click();
  assert.equal(dock.hidden, false);
  assert.equal(audio.paused, false);
  app.get('player-close').listeners.click();
  assert.equal(tracks[4].focused, true);
});

test('dock seek and volume reflect native media values and handle unavailable duration', async t => {
  const { data, html } = await built(t);
  const app = client(html, JSON.stringify(data));
  const audio = app.get('featured-audio'), seek = app.get('player-seek'), volume = app.get('player-volume');
  assert.equal(seek.disabled, true);
  audio.duration = 125; audio.currentTime = 25;
  audio.emit('loadedmetadata');
  assert.equal(seek.disabled, false);
  assert.equal(seek.value, 20);
  assert.equal(app.get('player-current').textContent, '0:25');
  assert.equal(app.get('player-duration').textContent, '2:05');
  assert.equal(seek.attributes['aria-valuetext'], '0:25 из 2:05');
  seek.value = 60; seek.listeners.input();
  assert.equal(audio.currentTime, 75);
  assert.equal(app.get('player-current').textContent, '1:15');
  assert.equal(app.get('player-duration').textContent, '2:05');
  for (const [value, expected] of [['0.4', 0.4], ['0', 0], ['1', 1], ['2', 1], ['-1', 0]]) {
    volume.listeners.input({ target: { value } });
    assert.equal(audio.volume, expected);
  }
  audio.duration = Infinity; audio.emit('durationchange');
  assert.equal(seek.disabled, true);
  const current = audio.currentTime;
  seek.value = 30; seek.listeners.input();
  assert.equal(audio.currentTime, current);
});

test('closing dock invalidates in-flight playback errors and restores catalog trigger focus', async t => {
  const { data, html } = await built(t);
  const app = client(html, JSON.stringify(data));
  const audio = app.get('featured-audio');
  let rejectPlay;
  audio.play = () => new Promise((resolve, reject) => { rejectPlay = reject; });
  const trigger = { dataset: { playUrl: data.projects[0].audio }, focus() { this.focused = true; } };
  app.documentListeners.click({ target: { closest: selector => selector === '[data-play-url]' ? trigger : null } });
  app.get('player-close').listeners.click();
  rejectPlay(new Error('Interrupted by close'));
  await Promise.resolve();
  assert.equal(app.get('player-dock').hidden, true);
  assert.equal(app.get('featured-status').textContent, '');
  assert.equal(trigger.focused, true);
});


test('profile and tools share one hero card before the music section', async t => {
  const { html } = await built(t);
  const hero = html.match(/<header class="hero-card"[\s\S]*?<\/header>/)[0];
  assert.ok(hero.includes('id="author-avatar"'));
  assert.ok(hero.includes('id="author-bio"'));
  assert.ok(hero.includes('class="hero-tools"'));
  assert.ok(hero.includes('id="tools-list"'));
  assert.equal((html.match(/id="tools-list"/g) || []).length, 1);
  assert.ok(html.indexOf('id="tools-list"') < html.indexOf('id="selected-title"'));
  assert.ok(!html.includes('<section class="tools-card"'));
});

test('intro starts hero-only via JS but leaves main visible in no-JS markup', async t => {
  const { data, html } = await built(t);
  assert.doesNotMatch(html.match(/<main[^>]*id="portfolio-start"[^>]*>/)[0], /\bhidden\b/);
  assert.match(html.match(/<button[^>]*id="intro-arrow"[^>]*>/)[0], /\bhidden\b/);
  const app = client(html, JSON.stringify(data));
  assert.equal(app.get('portfolio-start').hidden, true);
  assert.equal(app.get('hero-section').classList.contains('intro-layout'), true);
  assert.equal(app.get('intro-arrow').hidden, false);
  app.get('intro-arrow').listeners.click();
  assert.equal(app.get('portfolio-start').hidden, false);
  assert.equal(app.get('portfolio-start').focused, true);
  assert.notEqual(app.get('portfolio-start').scrolled, true);
  assert.equal(app.get('hero-section').classList.contains('intro-layout'), true);
  assert.equal(app.get('intro-arrow').disabled, true);
  assert.equal(app.get('intro-arrow').attributes['aria-hidden'], 'true');
  assert.equal(app.get('intro-arrow').attributes.tabindex, '-1');
  assert.equal(app.browserWindow.history.state?.portfolioRevealed, undefined);
  app.windowListeners.wheel({ deltaY: 120 });
  app.windowListeners.keydown({ key: 'PageDown' });
  assert.equal(app.browserWindow.history.calls, 0);
  assert.equal(app.get('portfolio-start').scrollCount, undefined);
});

test('downward scrolling and keys reveal once without hijacking form, media or modifier gestures', async t => {
  const { data, html } = await built(t);
  for (const key of ['ArrowDown', 'PageDown', 'End', ' ']) {
    const app = client(html, JSON.stringify(data));
    app.windowListeners.keydown({ key, target: { closest: () => ({}) } });
    assert.equal(app.get('portfolio-start').hidden, true);
    app.windowListeners.keydown({ key, ctrlKey: true });
    assert.equal(app.get('portfolio-start').hidden, true);
    app.windowListeners.keydown({ key });
    assert.equal(app.get('portfolio-start').hidden, false);
    assert.equal(app.browserWindow.history.calls, 0);
  }
  const app = client(html, JSON.stringify(data));
  for (const event of [{ deltaY: -10 }, { deltaY: 10, target: { closest: () => ({}) } }, { deltaY: 10, ctrlKey: true }, { deltaY: 10, metaKey: true }]) {
    app.windowListeners.wheel(event);
    assert.equal(app.get('portfolio-start').hidden, true);
  }
  app.windowListeners.keydown({ key: 'ArrowUp' });
  assert.equal(app.get('portfolio-start').hidden, true);
  app.windowListeners.wheel({ deltaY: 10 });
  assert.equal(app.get('portfolio-start').hidden, false);
});

test('touch reveal requires a single-finger upward gesture and respects cancellation', async t => {
  const { data, html } = await built(t);
  const app = client(html, JSON.stringify(data));
  for (const gesture of [
    { touches: [{ clientY: 200 }], end: 180 },
    { touches: [{ clientY: 200 }], end: 240 },
    { touches: [{ clientY: 200 }, { clientY: 210 }], end: 100 },
    { touches: [{ clientY: 200 }], end: 100, target: { closest: () => ({}) } },
  ]) {
    app.windowListeners.touchstart(gesture);
    app.windowListeners.touchend({ changedTouches: [{ clientY: gesture.end }] });
    assert.equal(app.get('portfolio-start').hidden, true);
  }
  app.windowListeners.touchstart({ touches: [{ clientY: 200 }] });
  app.windowListeners.touchcancel();
  app.windowListeners.touchend({ changedTouches: [{ clientY: 100 }] });
  assert.equal(app.get('portfolio-start').hidden, true);
  app.windowListeners.touchstart({ touches: [{ clientY: 200 }] });
  app.windowListeners.touchend({ changedTouches: [{ clientY: 100 }] });
  assert.equal(app.get('portfolio-start').hidden, false);
});

test('only known explicit section hashes bypass intro, not unknown hashes or restored scroll', async t => {
  const { data, html } = await built(t);
  for (const hash of ['#portfolio-start', '#sound-design', '#publications', '#contact-section']) {
    const app = client(html, JSON.stringify(data), undefined, { hash });
    assert.equal(app.get('portfolio-start').hidden, false);
    assert.equal(app.animations.length, 0);
    assert.equal(app.browserWindow.history.calls, 0);
  }
  for (const hash of ['', '#hero-section', '#unknown']) {
    const app = client(html, JSON.stringify(data), undefined, { hash, scrollY: 120 });
    assert.equal(app.get('portfolio-start').hidden, true);
    assert.equal(app.browserWindow.scrollY, 0);
    assert.equal(app.browserWindow.history.scrollRestoration, 'manual');
  }
  for (const event of ['hashchange', 'popstate', 'pageshow']) {
    const app = client(html, JSON.stringify(data));
    app.browserWindow.location.hash = '#contact-section';
    app.windowListeners[event]();
    assert.equal(app.get('portfolio-start').hidden, false);
    app.browserWindow.location.hash = '#hero-section';
    app.windowListeners[event]();
    assert.equal(app.get('portfolio-start').hidden, false);
    assert.equal(app.browserWindow.history.calls, 0);
  }
});

test('section anchor clicks reveal content while hero anchors do not', async t => {
  const { data, html } = await built(t);
  const app = client(html, JSON.stringify(data));
  const clickAnchor = href => app.documentListeners.click({ target: { closest: selector => selector.startsWith('a[') ? { getAttribute: () => href } : null } });
  clickAnchor('#hero-section');
  assert.equal(app.get('portfolio-start').hidden, true);
  clickAnchor('#portfolio-start');
  assert.equal(app.get('portfolio-start').hidden, false);
});


test('paired spacers center hero initially and move it upward with synchronized layout animation', async t => {
  const { data, html } = await built(t);
  const app = client(html, JSON.stringify(data));
  const hero = app.get('hero-section'), spacer = app.get('intro-spacer'), main = app.get('portfolio-start');
  const before = [...hero.classes];
  assert.equal(spacer.style.height, '200px');
  let prevented = 0;
  app.windowListeners.wheel({ deltaY: 120, preventDefault() { prevented++; } });
  assert.equal(prevented, 1);
  assert.equal(app.animations.length, 2);
  const animation = app.animations[0];
  assert.equal(animation.target, spacer);
  assert.equal(JSON.stringify(animation.keyframes), JSON.stringify([{ height: '200px' }, { height: '32px' }]));
  assert.equal(animation.timing.duration, 1100);
  assert.equal(animation.timing.fill, 'forwards');
  const topAnimation = app.animations[1];
  assert.equal(topAnimation.target, app.get('intro-top-spacer'));
  assert.equal(JSON.stringify(topAnimation.keyframes), JSON.stringify([{ height: '100px' }, { height: '0px' }]));
  assert.equal(JSON.stringify(topAnimation.timing), JSON.stringify(animation.timing));
  assert.equal(animation.startTime, 1234);
  assert.equal(topAnimation.startTime, 1234);
  const initialCard = app.get('hero-block').getBoundingClientRect();
  assert.equal(initialCard.top + initialCard.height / 2, app.browserWindow.innerHeight / 2);
  assert.equal(spacer.style.height, '200px');
  assert.deepEqual([...hero.classes], before);
  assert.equal(main.scrolled, undefined);
  assert.equal(main.hidden, false);
  assert.equal(app.get('page-body').style.overflowAnchor, 'none');
  app.windowListeners.wheel({ deltaY: 300, preventDefault() { prevented++; } });
  app.windowListeners.keydown({ key: 'PageDown', preventDefault() { prevented++; } });
  assert.equal(prevented, 1);
  assert.equal(app.animations.length, 2);
  await app.finishAnimations();
  assert.equal(spacer.style.height, '32px');
  assert.equal(animation.cancelled, true);
  assert.equal(topAnimation.cancelled, true);
  assert.equal(app.get('intro-top-spacer').style.height, '0px');
  assert.equal(app.get('hero-block').getBoundingClientRect().top, 100);
  assert.equal(app.get('hero-block').getBoundingClientRect().height, initialCard.height);
  assert.equal(app.get('page-body').style.overflowAnchor, '');
  app.windowListeners.wheel({ deltaY: 120, preventDefault() { prevented++; } });
  app.windowListeners.keydown({ key: 'PageDown', preventDefault() { prevented++; } });
  app.get('intro-arrow').listeners.click();
  assert.equal(prevented, 1);
  assert.deepEqual([...hero.classes], before);
  assert.equal(main.scrolled, undefined);
  assert.equal(app.browserWindow.history.calls, 0);
  assert.equal(app.animations.length, 2);
  assert.doesNotMatch(html, /introHero\.classList\.remove/);
});

test('arrow reveals without scrollIntoView and reduced-motion or unsupported animation collapses immediately', async t => {
  const { data, html } = await built(t);
  for (const options of [{}, { reducedMotion: true }, { noAnimate: true }]) {
    const app = client(html, JSON.stringify(data), undefined, options);
    app.get('intro-arrow').listeners.click();
    assert.equal(app.get('portfolio-start').scrolled, undefined);
    assert.equal(app.get('portfolio-start').focused, true);
    if (options.reducedMotion || options.noAnimate) {
      assert.equal(app.animations.length, 0);
      assert.equal(app.get('intro-spacer').style.height, '32px');
    } else {
      assert.equal(app.animations.length, 2);
      await app.finishAnimations();
      assert.equal(app.get('intro-spacer').style.height, '32px');
    }
    app.get('intro-arrow').listeners.click();
    assert.equal(app.get('portfolio-start').scrollCount, undefined);
    assert.equal(app.browserWindow.history.calls, 0);
  }
});

test('spacer resizes before reveal only and restored navigation ends in-flight animation', async t => {
  const { data, html } = await built(t);
  const app = client(html, JSON.stringify(data), undefined, { innerHeight: 500, cardHeight: 400, cardBaseTop: 100 });
  assert.equal(app.get('intro-spacer').style.height, '160px');
  app.browserWindow.innerHeight = 1000;
  app.windowListeners.resize();
  assert.equal(app.get('intro-spacer').style.height, '300px');
  app.get('intro-arrow').listeners.click();
  app.browserWindow.innerHeight = 700;
  app.windowListeners.resize();
  assert.equal(app.get('intro-spacer').style.height, '300px');
  app.browserWindow.location.hash = '#contact-section';
  app.windowListeners.hashchange();
  assert.equal(app.get('intro-spacer').style.height, '32px');
  assert.equal(app.animations[0].cancelled, true);
  await app.finishAnimations();
  assert.equal(app.get('intro-spacer').style.height, '32px');
  const restored = client(html, JSON.stringify(data), undefined, { hash: '#contact-section' });
  assert.equal(restored.animations.length, 0);
  assert.equal(restored.get('intro-spacer').style.height, '32px');
});

test('touchmove reveals without cancelling native swipe and pagehide safely finishes it', async t => {
  const { data, html } = await built(t);
  const app = client(html, JSON.stringify(data));
  let prevented = 0;
  app.windowListeners.touchstart({ touches: [{ clientY: 300 }] });
  app.windowListeners.touchmove({ touches: [{ clientY: 250 }], preventDefault() { prevented++; } });
  assert.equal(prevented, 0);
  assert.equal(app.animations.length, 2);
  app.windowListeners.touchmove({ touches: [{ clientY: 220 }], preventDefault() { prevented++; } });
  assert.equal(prevented, 0);
  app.windowListeners.pagehide();
  assert.equal(app.get('intro-spacer').style.height, '32px');
  assert.equal(app.animations[0].cancelled, true);
  app.windowListeners.touchmove({ touches: [{ clientY: 180 }], preventDefault() { prevented++; } });
  assert.equal(prevented, 0);
});

test('waveform SVG renders verified sample peaks and progress follows accessible native seek', async t => {
  const { data, html } = await built(t);
  const first = [...data.projects].sort((a,b) => (Number(a.order)||999)-(Number(b.order)||999)).find(p => p.audio);
  const app = client(html, JSON.stringify({ ...data, waveforms: { [first.audio]: { peaks: [0, .25, .5, 1], duration: 120, sha256: 'fixture' } } }));
  const base = app.get('waveform-base'), played = app.get('waveform-played'), audio = app.get('featured-audio'), seek = app.get('player-seek');
  assert.equal(app.get('waveform-track').classList.contains('no-waveform'), false);
  assert.equal(base.innerHTML, played.innerHTML);
  assert.equal((base.innerHTML.match(/<rect /g) || []).length, 4);
  assert.ok(base.innerHTML.includes('viewBox="0 0 12 80"'));
  for (const height of [1, 19, 38, 76]) assert.ok(base.innerHTML.includes(`height="${height}"`));
  assert.ok(base.innerHTML.includes('aria-hidden="true"'));
  assert.equal(played.style.clipPath, 'inset(0 100% 0 0)');
  audio.duration = 120; audio.currentTime = 30; audio.emit('timeupdate');
  assert.equal(played.style.clipPath, 'inset(0 75% 0 0)');
  seek.value = 75; seek.listeners.input();
  assert.equal(audio.currentTime, 90);
  assert.equal(played.style.clipPath, 'inset(0 25% 0 0)');
  assert.equal(seek.attributes['aria-valuetext'], '1:30 из 2:00');
  assert.match(html, /<input[^>]*id="player-seek"[^>]*type="range"|<input[^>]*type="range"[^>]*id="player-seek"/);
});

test('missing or invalid peaks fall back to ordinary seek without fabricated waveform', async t => {
  const { data, html } = await built(t);
  const first = [...data.projects].sort((a,b) => (Number(a.order)||999)-(Number(b.order)||999)).find(p => p.audio);
  for (const peaks of [undefined, [], [1], [0, 1.01], [-.1, .4], ['<script>', .5], [null, .3], Array(1001).fill(.5)]) {
    const app = client(html, JSON.stringify({ ...data, waveforms: { [first.audio]: { peaks } } }));
    assert.equal(app.get('waveform-track').classList.contains('no-waveform'), true);
    assert.equal(app.get('waveform-base').innerHTML, '');
    assert.equal(app.get('waveform-played').innerHTML, '');
    const audio = app.get('featured-audio'), seek = app.get('player-seek');
    audio.duration = 100; audio.emit('loadedmetadata');
    assert.equal(seek.disabled, false);
    seek.value = 40; seek.listeners.input();
    assert.equal(audio.currentTime, 40);
  }
});

test('switching tracks replaces waveform and clears stale visualization when next track lacks peaks', async t => {
  const { data, html } = await built(t);
  const projects = [...data.projects].sort((a,b) => (Number(a.order)||999)-(Number(b.order)||999)).filter(p => p.audio);
  const app = client(html, JSON.stringify({ ...data, waveforms: {
    [projects[0].audio]: { peaks: [.1, .7] },
    [projects[2].audio]: { peaks: [.2, .8, .3] },
  } }));
  const buttons = app.get('selected-container').children;
  buttons[1].listeners.click();
  assert.equal(app.get('waveform-track').classList.contains('no-waveform'), true);
  assert.equal(app.get('waveform-base').innerHTML, '');
  buttons[2].listeners.click();
  assert.equal(app.get('waveform-track').classList.contains('no-waveform'), false);
  assert.equal((app.get('waveform-base').innerHTML.match(/<rect /g) || []).length, 3);
  assert.equal(app.get('waveform-played').style.clipPath, 'inset(0 100% 0 0)');
  assert.equal(app.get('player-current').textContent, '0:00');
});

test('bottom player identifies artist and contains no artwork or social buttons', async t => {
  const { data, html } = await built(t);
  const app = client(html, JSON.stringify(data));
  assert.equal(app.get('player-artist').textContent, data.profile.name);
  const dock = html.match(/<aside id="player-dock"[\s\S]*?<\/aside>/)[0];
  assert.doesNotMatch(dock, /<img\b|social-btn|social-links|t\.me|vk\.ru|soundcloud\.com/);
  assert.ok(dock.includes('id="waveform-track"'));
  assert.ok(dock.includes('id="player-current"'));
  assert.ok(dock.includes('id="player-duration"'));
});

test('Listen reveals without persisting hash and later scrolls deliberately after transition', async t => {
  const { data, html } = await built(t);
  const app = client(html, JSON.stringify(data));
  let prevented = 0;
  const event = { target: { closest: selector => selector.startsWith('a[') ? { getAttribute: () => '#portfolio-start' } : null }, preventDefault() { prevented++; } };
  app.documentListeners.click(event);
  assert.equal(prevented, 1);
  assert.equal(app.animations.length, 2);
  assert.equal(app.get('portfolio-start').scrolled, undefined);
  app.documentListeners.click(event);
  assert.equal(prevented, 2);
  assert.equal(app.animations.length, 2);
  await app.finishAnimations();
  app.documentListeners.click(event);
  assert.equal(prevented, 3);
  assert.equal(app.get('portfolio-start').scrolled, true);
  assert.equal(app.get('portfolio-start').scrollOptions.behavior, 'smooth');
  assert.equal(app.browserWindow.location.hash, '');
});

test('tall mobile hero clamps top spacing to zero while a fitting card centers after resize', async t => {
  const { data, html } = await built(t);
  const tall = client(html, JSON.stringify(data), undefined, { innerHeight: 650, cardHeight: 720, cardBaseTop: 90 });
  assert.equal(tall.get('intro-top-spacer').style.height, '0px');
  assert.equal(tall.get('hero-block').getBoundingClientRect().top, 90);
  assert.equal(tall.get('intro-spacer').style.height, '160px');
  const app = client(html, JSON.stringify(data));
  app.browserWindow.innerHeight = 1000;
  app.windowListeners.resize();
  assert.equal(app.get('intro-top-spacer').style.height, '200px');
  const card = app.get('hero-block').getBoundingClientRect();
  assert.equal(card.top + card.height / 2, 500);
  app.windowListeners.resize();
  assert.equal(app.get('intro-top-spacer').style.height, '200px');
  app.get('intro-arrow').listeners.click();
  await app.finishAnimations();
  assert.equal(app.get('hero-block').getBoundingClientRect().top, 100);
});

test('paired reveal waits for both animations and works without a document timeline', async t => {
  const { data, html } = await built(t);
  const app = client(html, JSON.stringify(data), undefined, { noTimeline: true });
  app.get('intro-arrow').listeners.click();
  assert.equal(app.animations.length, 2);
  assert.equal(app.animations[0].startTime, undefined);
  await app.animations[0].finish();
  assert.equal(app.animations[0].cancelled, false);
  assert.equal(app.animations[1].cancelled, false);
  assert.equal(app.get('intro-top-spacer').style.height, '100px');
  await app.finishAnimations();
  assert.ok(app.animations.every(animation => animation.cancelled));
  assert.equal(app.get('intro-top-spacer').style.height, '0px');
  assert.equal(app.get('intro-spacer').style.height, '32px');
});

test('root reload clears legacy reveal flag without losing unrelated history and resets stale scroll', async t => {
  const { data, html } = await built(t);
  const app = client(html, JSON.stringify(data), undefined, { historyState: { portfolioRevealed: true, keep: 123 }, scrollY: 800 });
  assert.equal(app.get('portfolio-start').hidden, true);
  assert.equal(app.browserWindow.history.state.portfolioRevealed, undefined);
  assert.equal(app.browserWindow.history.state.keep, 123);
  assert.equal(app.browserWindow.history.calls, 1);
  assert.equal(app.browserWindow.scrollY, 0);
  assert.equal(app.browserWindow.scrollCalls[0].behavior, 'instant');
  app.browserWindow.scrollY = 500;
  app.windowListeners.pageshow({ persisted: false });
  assert.equal(app.browserWindow.scrollY, 0);
  assert.equal(app.get('portfolio-start').hidden, true);
  assert.equal(app.get('intro-top-spacer').style.height, '100px');
  app.get('intro-arrow').listeners.click();
  await app.finishAnimations();
  assert.equal(app.browserWindow.history.calls, 1);
  assert.equal(app.browserWindow.history.state.portfolioRevealed, undefined);
});

test('legacy Listen hash is cleaned only alongside legacy marker and preserves query', async t => {
  const { data, html } = await built(t);
  const app = client(html, JSON.stringify(data), undefined, { hash: '#portfolio-start', search: '?ref=test', historyState: { portfolioRevealed: true, keep: 7 } });
  assert.equal(app.browserWindow.location.hash, '');
  assert.equal(app.browserWindow.history.lastURL, '/?ref=test');
  assert.equal(app.browserWindow.history.state.keep, 7);
  assert.equal(app.get('portfolio-start').hidden, true);
  const explicit = client(html, JSON.stringify(data), undefined, { hash: '#portfolio-start' });
  assert.equal(explicit.browserWindow.location.hash, '#portfolio-start');
  assert.equal(explicit.get('portfolio-start').hidden, false);
  assert.equal(explicit.browserWindow.history.calls, 0);
});

test('late first pageshow cannot finish in-flight reveal and BFCache preserves live state', async t => {
  const { data, html } = await built(t);
  const app = client(html, JSON.stringify(data));
  app.get('intro-arrow').listeners.click();
  const scrollCalls = app.browserWindow.scrollCalls.length;
  app.windowListeners.pageshow({ persisted: false });
  assert.ok(app.animations.every(animation => !animation.cancelled));
  assert.equal(app.get('intro-top-spacer').style.height, '100px');
  assert.equal(app.browserWindow.scrollCalls.length, scrollCalls);
  await app.finishAnimations();
  app.browserWindow.scrollY = 350;
  app.windowListeners.pageshow({ persisted: true });
  assert.equal(app.browserWindow.scrollY, 350);
  assert.equal(app.get('portfolio-start').hidden, false);
  assert.equal(app.get('intro-top-spacer').style.height, '0px');
  const closed = client(html, JSON.stringify(data));
  closed.windowListeners.pageshow({ persisted: true });
  assert.equal(closed.get('portfolio-start').hidden, true);
  assert.equal(closed.animations.length, 0);
});

test('player toggle uses scalable play and pause SVG while preserving accessible labels', async t => {
  const { data, html } = await built(t);
  const app = client(html, JSON.stringify(data));
  const toggle = app.get('player-toggle');
  app.get('selected-container').children[0].listeners.click();
  assert.equal(toggle.attributes['aria-label'], 'Приостановить');
  assert.match(toggle.innerHTML, /<svg\b/);
  assert.equal((toggle.innerHTML.match(/<rect\b/g) || []).length, 2);
  toggle.listeners.click();
  assert.equal(toggle.attributes['aria-label'], 'Воспроизвести');
  assert.match(toggle.innerHTML, /<svg\b/);
  assert.match(toggle.innerHTML, /<path\b/);
  assert.doesNotMatch(toggle.innerHTML, /▶|Ⅱ/);
});


test('scroll inputs stay native immediately after the triggering gesture while reveal is unfinished', async t => {
  const { data, html } = await built(t);
  for (const trigger of ['wheel','keydown']) {
    const app = client(html, JSON.stringify(data));
    const event = extra => ({ defaultPrevented:false, preventDefault() { this.defaultPrevented = true; }, ...extra });
    const first = event(trigger === 'wheel' ? { deltaY:120 } : { key:'PageDown' });
    app.windowListeners[trigger](first);
    assert.equal(first.defaultPrevented, true);
    assert.equal(app.animations.length, 2);
    const initialScrollCalls = app.browserWindow.scrollCalls.length;
    for (const [kind, extra] of [['wheel',{deltaY:250}],['wheel',{deltaY:-120}],['keydown',{key:'PageDown',repeat:true}],['keydown',{key:'ArrowDown',repeat:true}]]) {
      const subsequent = event(extra); app.windowListeners[kind](subsequent);
      assert.equal(subsequent.defaultPrevented, false);
    }
    app.windowListeners.touchstart({touches:[{clientY:300}]});
    const swipe = event({touches:[{clientY:200}]}); app.windowListeners.touchmove(swipe);
    assert.equal(swipe.defaultPrevented, false);
    assert.equal(app.animations.length, 2);
    assert.equal(app.animations.some(animation => animation.cancelled), false);
    assert.equal(app.browserWindow.scrollCalls.length, initialScrollCalls);
  }
});
