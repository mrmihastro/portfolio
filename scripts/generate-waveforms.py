#!/usr/bin/env python3
"""Regenerate verified waveform peaks from project audio.

Optional cache refresh: `python3 scripts/generate-waveforms.py`. Requires ffmpeg
+ ffprobe on the author's machine. Ordinary builds automatically decode new or
replaced local audio with the pinned ffmpeg-static npm binary, so this script is
not required for CMS changes. External/invalid audio uses honest progress fallback.
Each of 220 bars is the maximum absolute decoded mono amplitude in its time bin,
normalized by the recording's maximum peak (not random or decorative data).
"""
import array
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BARS = 220
SAMPLE_RATE = 8000

def generate():
    sources = set()
    for path in sorted((ROOT / 'projects').glob('*.json')):
        project = json.loads(path.read_text())
        url = project.get('audio') or project.get('audio_url') or project.get('media_url') or project.get('track') or ''
        if isinstance(url, str) and url.startswith('/uploads/'):
            local = (ROOT / url.lstrip('/')).resolve()
            if local.is_relative_to((ROOT / 'uploads').resolve()) and local.is_file():
                sources.add(url)
    records = {}
    for url in sorted(sources):
        path = ROOT / url.lstrip('/')
        duration = float(subprocess.check_output([
            'ffprobe', '-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1', str(path)
        ]))
        pcm = subprocess.check_output([
            'ffmpeg', '-v', 'error', '-i', str(path), '-vn', '-ac', '1',
            '-ar', str(SAMPLE_RATE), '-f', 's16le', '-acodec', 'pcm_s16le', '-'
        ])
        samples = array.array('h')
        samples.frombytes(pcm)
        if sys.byteorder != 'little':
            samples.byteswap()
        if not samples or duration <= 0:
            raise ValueError(f'No decoded audio in {url}')
        count = len(samples)
        peaks = [max((abs(v) for v in samples[i * count // BARS:(i + 1) * count // BARS]), default=0)
                 for i in range(BARS)]
        maximum = max(peaks) or 1
        records[url] = {
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'duration': round(duration, 4),
            'peaks': [round(value / maximum, 4) for value in peaks],
        }
        print(f'{path.name}: {duration:.2f}s, {BARS} measured peaks')
    destination = ROOT / 'settings/waveforms.json'
    temporary = destination.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(records, ensure_ascii=False, separators=(',', ':')) + '\n')
    temporary.replace(destination)
    print(f'Wrote {len(records)} records to {destination.relative_to(ROOT)}')

if __name__ == '__main__':
    generate()
