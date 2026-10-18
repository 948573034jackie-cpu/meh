#!/usr/bin/env bash
# Downloads the open data used by scripts/build-dict.py into the given directory (default: .dict-src).
set -euo pipefail
DIR="${1:-.dict-src}"; mkdir -p "$DIR"; cd "$DIR"
curl -sS -L -o ecdict.csv   https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv
curl -sS -L -o lemma.en.txt https://raw.githubusercontent.com/skywind3000/ECDICT/master/lemma.en.txt
curl -sS -L -o en_UK.txt    https://raw.githubusercontent.com/open-dict-data/ipa-dict/master/data/en_UK.txt
curl -sS -L -o cefrj.csv    https://raw.githubusercontent.com/openlanguageprofiles/olp-en-cefrj/master/cefrj-vocabulary-profile-1.5.csv
curl -sS -L -o octanove.csv https://raw.githubusercontent.com/openlanguageprofiles/olp-en-cefrj/master/octanove-vocabulary-profile-c1c2-1.0.csv
ls -la
