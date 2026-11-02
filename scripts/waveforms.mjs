import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';

const execFileAsync = promisify(execFile);
const sampleRate = 8000;
const bins = 220;

// The pinned npm package installs the platform decoder. Nothing depends on an
// undocumented executable in Netlify's image, and media cannot open network URLs.
export async function generateWaveform(path, sha256) {
  if (!ffmpegPath) throw new Error('No ffmpeg-static binary for this build platform');
  const { stdout } = await execFileAsync(ffmpegPath, [
    '-nostdin', '-v', 'error', '-threads', '1', '-protocol_whitelist', 'file,pipe',
    '-i', path, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(sampleRate),
    '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1',
  ], { encoding:'buffer', timeout:30000, maxBuffer:64 * 1024 * 1024, windowsHide:true });
  const count = Math.floor(stdout.length / 2);
  if (!count) throw new Error('Decoded audio is empty');
  const peaks = Array.from({ length:bins }, (_, index) => {
    const start = Math.floor(index * count / bins);
    const end = Math.floor((index + 1) * count / bins);
    let peak = 0;
    for (let position = start; position < end; position++) peak = Math.max(peak, Math.abs(stdout.readInt16LE(position * 2)));
    return peak;
  });
  const maximum = Math.max(...peaks) || 1;
  return { sha256, duration:count / sampleRate, peaks:peaks.map(value => Number((value / maximum).toFixed(4))) };
}
