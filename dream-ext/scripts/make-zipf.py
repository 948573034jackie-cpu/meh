#!/usr/bin/env python3
"""Makes youtube-to-claude/dream/zipf.json.gz: how common each single word of the dictionary is (wordfreq's Zipf scale,
7 = "the", 3 = rare), for My tutor's stop score. Run it once with wordfreq installed (pip install wordfreq); the result
is committed, so the extension needs no Python. Format: {"27": "word word ...", ...}, the key being Zipf x 10."""
import gzip, json, os, re
from wordfreq import zipf_frequency

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../youtube-to-claude/dream')
with gzip.open(os.path.join(out, 'dict.json.gz'), 'rt', encoding='utf-8') as f:
    words = json.load(f)['w']
groups = {}
for w in words:
    if not re.fullmatch(r"[a-z][a-z'-]*", w):
        continue
    z = zipf_frequency(w, 'en')
    if z > 0:
        groups.setdefault(str(round(z * 10)), []).append(w)
data = {k: ' '.join(sorted(v)) for k, v in sorted(groups.items(), key=lambda kv: int(kv[0]))}
with gzip.GzipFile(os.path.join(out, 'zipf.json.gz'), 'wb', mtime=0) as g:
    g.write(json.dumps(data, separators=(',', ':')).encode('utf-8'))
print('words:', sum(len(v) for v in groups.values()))
