import { readdir, readFile, mkdir, rm, cp, writeFile, realpath } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { generateWaveform } from './waveforms.mjs';
import { fileURLToPath } from 'node:url';

export const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const marker = '<script id="site-content" type="application/json">null</script>';

async function readObject(path) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected a JSON object: ${path}`);
  }
  return value;
}


// Reuse committed peaks only for matching audio bytes. New/replaced CMS uploads
// are decoded automatically at ordinary build time with the pinned npm binary.
// Generated data is embedded in HTML, never written back into source content.
async function verifiedWaveforms(source, projects) {
  let records = {};
  try { records = await readObject(join(source, 'settings/waveforms.json')); }
  catch { /* Cache is optional; decode current local uploads instead. */ }
  const verified = {};
  const attempted = new Set();
  const uploadRoot = resolve(source, 'uploads') + sep;
  let realUploadRoot;
  try { realUploadRoot = (await realpath(resolve(source, 'uploads'))) + sep; }
  catch { return verified; }
  for (const project of projects) {
    const url = project.audio || project.audio_url || project.media_url || project.track || '';
    if (typeof url !== 'string' || !url.startsWith('/uploads/') || attempted.has(url)) continue;
    const path = resolve(source, url.slice(1));
    if (!path.startsWith(uploadRoot)) continue;
    attempted.add(url);
    let bytes;
    try {
      if (!(await realpath(path)).startsWith(realUploadRoot)) continue;
      bytes = await readFile(path);
    }
    catch { continue; }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const record = records[url];
    if (record && typeof record === 'object' && !Array.isArray(record) &&
        record.sha256 === sha256 &&
        Number.isFinite(record.duration) && record.duration > 0 &&
        Array.isArray(record.peaks) && record.peaks.length === 220 &&
        record.peaks.every(peak => Number.isFinite(peak) && peak >= 0 && peak <= 1)) {
      verified[url] = { sha256:record.sha256, duration:record.duration, peaks:record.peaks };
      continue;
    }
    try { verified[url] = await generateWaveform(path, sha256); }
    catch (error) {
      // A broken/unsupported/oversized recording keeps the site deployable. The
      // client displays an honest progress-only fallback, never cached old peaks.
      const reason = error.killed ? 'decoder timeout/output limit' : 'audio could not be decoded';
      console.warn(`[waveform] ${url}: ${reason}; showing playback progress without a waveform.`);
    }
  }
  return verified;
}

export async function build(source = root, output = join(source, 'dist')) {
  async function collection(folder) {
    // GitHub Contents previously returned files alphabetically. Keep tie order.
    const names = (await readdir(join(source, folder))).filter(n => n.endsWith('.json')).sort();
    return Promise.all(names.map(async name => {
      const value = await readObject(join(source, folder, name));
      if (typeof value.title !== 'string' || !value.title.trim()) {
        throw new Error(`Missing title: ${folder}/${name}`);
      }
      return value;
    }));
  }
  const content = {
    profile: await readObject(join(source, 'settings/profile.json')),
    projects: await collection('projects'),
    posts: await collection('posts'),
    sounds: (await readObject(join(source, 'settings/sounds.json'))).items,
  };
  content.waveforms = await verifiedWaveforms(source, content.projects);
  if (!Array.isArray(content.sounds) || content.sounds.some(sound => !sound.title || typeof sound.url !== 'string' || !/^https:\/\/drive\.google\.com\/drive\/folders\/[A-Za-z0-9_-]+(?:[?#].*)?$/.test(sound.url))) {
    throw new Error('Invalid portfolio folder links');
  }
  if (typeof content.profile.name !== 'string' || !content.profile.name.trim()) {
    throw new Error('Missing profile name');
  }
  const template = await readFile(join(source, 'index.html'), 'utf8');
  if (template.split(marker).length !== 2) throw new Error('Expected exactly one site-content marker');
  // Prevent user-authored text (including </script>) from breaking out of the JSON block.
  const json = JSON.stringify(content).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const html = template.replace(marker, () => marker.replace('>null<', () => `>${json}<`));
  // Validate everything before touching a previous successful local build.
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const name of await readdir(source)) {
    if (name.startsWith('.') || ['dist', 'scripts', 'tests', 'node_modules', 'package.json', 'package-lock.json', 'netlify.toml', 'README.md', 'index.html'].includes(name)) continue;
    await cp(join(source, name), join(output, name), { recursive: true });
  }
  await writeFile(join(output, 'index.html'), html);
  return content;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const data = await build();
  console.log(`Built profile, ${data.projects.length} projects, ${data.posts.length} posts, ${data.sounds.length} portfolio folders into dist/`);
}
