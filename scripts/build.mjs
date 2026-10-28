import { readdir, readFile, mkdir, rm, cp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
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
  };
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
  console.log(`Built profile, ${data.projects.length} projects, ${data.posts.length} posts into dist/`);
}
