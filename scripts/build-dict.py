#!/usr/bin/env python3
"""Build the offline learner dictionary shipped with ReadAlong.

Inputs (download first, see scripts/fetch-dict-sources.sh):
  ecdict.csv      skywind3000/ECDICT (MIT repo)            word, phonetic, translation, tag, bnc, frq, exchange, collins, oxford
  en_UK.txt       open-dict-data/ipa-dict (GPL-3 derived)  British IPA
  cefrj.csv       CEFR-J Wordlist 1.5 (free with citation) headword,pos,CEFR  (A1-B2)
  octanove.csv    Octanove Vocabulary Profile C1/C2 (CC BY-SA 4.0)
  lemma.en.txt    ECDICT lemma database (research/educational use)

Output: resources/dict/dict.json.gz
  { "w": { word: {i: ipa, t: zh, g: tags, f: frq, b: bnc, c: collins, o: oxford, l: level, s: level_source} },
    "f": { inflected_form: lemma } }
"""
import csv, re, json, gzip, collections, sys, os

src = sys.argv[1] if len(sys.argv) > 1 else '.'
out = sys.argv[2] if len(sys.argv) > 2 else 'resources/dict/dict.json.gz'
csv.field_size_limit(10 ** 9)
P = lambda n: os.path.join(src, n)
LV = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']
WORD = re.compile(r"[a-z][a-z'\-]*")
PHRASE = re.compile(r"[a-z][a-z'\- ]*[a-z]")

# --- British IPA ---------------------------------------------------------
uk = {}
for line in open(P('en_UK.txt'), encoding='utf-8'):
    if '\t' not in line:
        continue
    w, ipa = line.rstrip('\n').split('\t', 1)
    uk[w] = ipa.split(',')[0].strip()

def norm_phon(p):
    if not p:
        return ''
    p = p.split('. ')[0] if '. ' in p else p
    p = (p.replace('ә', 'ə').replace(':', 'ː').replace("'", 'ˈ').replace(',', 'ˌ')
           .replace('ɒː', 'ɔː').replace('^', 'ʌ').replace('є', 'ɛ').replace('ε', 'ɛ').replace('ˊ', 'ˈ'))
    return '/' + p.strip('/ ') + '/'

# --- CEFR lists ------------------------------------------------------------
cefr = {}
def add_cefr(path, source):
    with open(path, newline='', encoding='utf-8') as f:
        for row in csv.DictReader(f):
            lv = (row.get('CEFR') or '').strip()
            if lv not in LV:
                continue
            for hw in row['headword'].split('/'):
                hw = hw.strip().lower()
                if not hw:
                    continue
                cur = cefr.get(hw)
                if cur is None or LV.index(lv) < LV.index(cur[0]):
                    cefr[hw] = (lv, source)
add_cefr(P('cefrj.csv'), 'cefrj')
add_cefr(P('octanove.csv'), 'oct')

# --- level estimation for words outside the CEFR lists ----------------------
ORDER = ['zk', 'gk', 'cet4', 'cet6', 'ky', 'ielts', 'toefl', 'gre']
TAG_LEVEL = {'zk': 'A2', 'gk': 'B1', 'cet4': 'B1', 'cet6': 'B2', 'ky': 'B2', 'ielts': 'B2', 'toefl': 'C1', 'gre': 'C1'}

def rank_of(row):
    rs = [int(r) for r in (row['frq'], row['bnc']) if r and r != '0']
    return min(rs) if rs else 0

def estimate_level(row):
    tags = row['tag'].split()
    rank = rank_of(row)
    lv = None
    if tags:
        first = min(tags, key=lambda t: ORDER.index(t) if t in ORDER else 99)
        lv = TAG_LEVEL.get(first)
    if rank:
        if rank <= 600: fl = 'A1'
        elif rank <= 2000: fl = 'A2'
        elif rank <= 4500: fl = 'B1'
        elif rank <= 9000: fl = 'B2'
        elif rank <= 18000: fl = 'C1'
        else: fl = 'C2'
        lv = fl if lv is None or LV.index(fl) < LV.index(lv) else lv
    if row['oxford'] == '1' and (lv is None or LV.index(lv) > LV.index('B1')):
        lv = 'B1'
    if lv is None:
        col = int(row['collins'] or 0)
        lv = 'C2' if col == 0 else ('B2' if col >= 3 else 'C1')
    return lv

entries, forms, rows = {}, {}, {}
with open(P('ecdict.csv'), newline='', encoding='utf-8') as f:
    for row in csv.DictReader(f):
        w = row['word']
        is_word = bool(WORD.fullmatch(w))
        is_phrase = (not is_word) and (' ' in w) and bool(PHRASE.fullmatch(w)) and len(w) <= 40
        if not (is_word or is_phrase):
            continue
        signal = rank_of(row) or row['tag'] or row['oxford'] == '1' or (row['collins'] not in ('', '0'))
        exch = row['exchange'] or ''
        m = re.search(r'(?:^|/)0:([a-z][a-z\'\-]*)', exch)
        if is_word and m and m.group(1) != w:
            forms.setdefault(w, m.group(1))
        if not signal and w not in cefr:
            continue
        rows[w] = row
        if is_word:
            for part in exch.split('/'):
                if ':' in part:
                    k, v = part.split(':', 1)
                    if k in ('p', 'd', 'i', '3', 's', 'r', 't') and v and v != w and WORD.fullmatch(v):
                        forms.setdefault(v, w)

for w, row in rows.items():
    tr = row['translation'].replace('\\n', '\n')
    tr = '\n'.join(tr.split('\n')[:4])
    if w in cefr:
        lv, s = cefr[w]
    else:
        lv, s = estimate_level(row), 'est'
    entries[w] = {
        'i': uk.get(w) or norm_phon(row['phonetic']) if ' ' not in w else '',
        't': tr,
        'g': row['tag'],
        'f': int(row['frq'] or 0),
        'b': int(row['bnc'] or 0),
        'c': int(row['collins'] or 0),
        'o': 1 if row['oxford'] == '1' else 0,
        'l': lv,
        's': s,
    }

# CEFR headwords missing from ECDICT still get a level entry (no gloss)
for hw, (lv, s) in cefr.items():
    if hw not in entries and WORD.fullmatch(hw):
        entries[hw] = {'i': uk.get(hw, ''), 't': '', 'g': '', 'f': 0, 'b': 0, 'c': 0, 'o': 0, 'l': lv, 's': s}

# lemma database: forms -> lemma (only when the lemma is a dictionary entry)
for line in open(P('lemma.en.txt'), encoding='utf-8'):
    if line.startswith(';') or '->' not in line:
        continue
    head, tail = line.split('->', 1)
    lemma = head.split('/')[0].strip()
    if lemma not in entries or not WORD.fullmatch(lemma):
        continue
    for form in tail.strip().split(','):
        form = form.strip()
        if form and form != lemma and WORD.fullmatch(form) and form not in entries:
            forms.setdefault(form, lemma)

forms = {k: v for k, v in forms.items() if v in entries}
raw = json.dumps({'w': entries, 'f': forms}, ensure_ascii=False, separators=(',', ':'))
os.makedirs(os.path.dirname(out), exist_ok=True)
with gzip.open(out, 'wb', compresslevel=9) as g:
    g.write(raw.encode('utf-8'))
words = sum(1 for k in entries if ' ' not in k)
phrases = len(entries) - words
lv = collections.Counter(e['l'] for e in entries.values())
srcs = collections.Counter(e['s'] for e in entries.values())
print(f'words={words} phrases={phrases} forms={len(forms)} levels={dict(sorted(lv.items()))} sources={dict(srcs)} json={len(raw)/1e6:.1f}MB gz={os.path.getsize(out)/1e6:.1f}MB')
