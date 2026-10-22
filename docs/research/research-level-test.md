# In-app vocabulary level test: research summary and recommended design

## 1. Established tests

| Test | Format | Guessing control | Output |
|---|---|---|---|
| Nation VST (Nation & Beglar 2007) | 4-option MC, 140 items = 10 per 1k-family band x 14 (BNC) | none; MC guessing inflates scores and 10 items/band is too few (Gyllstad, Vilkaite & Schmitt 2015) | families = correct x 100 |
| Updated VLT (Webb, Sasao & Ballance 2017) | matching, 30 items per level, 1k-5k | none | per-level mastery: 29/30 at 1k-3k, 24/30 at 4k-5k; only per-level scores are meaningful |
| X_Lex / Y_Lex (Meara & Milton 2003); DIALANG VSPT | yes/no checklist, 1k bands to 5k (Y_Lex 5k-10k), pseudowords | X_Lex: real word +50 (max 5,000), accepted pseudoword -250; DIALANG reports 0-100, not CEFR-linked | lemma score |
| Test Your Vocab; Brysbaert et al. 2016 | yes/no, frequency-ranked, two-step (broad sweep then narrowed band); Brysbaert: 70 words + 30 Wuggy nonwords, ~4 min | hits minus false alarms | lemmas; adult native ~42,000 lemmas = ~11,100 families |
| Cambridge/Oxford placement | adaptive reading/use-of-English, 20-40 min | IRT | CEFR via 0-100 |

Yes/no corrections compared by Huibregtse, Admiraal & Meara (2002): h-f; cfg = (h-f)/(1-f); delta-m; Isdt. None is clearly superior (Mochida & Harrington 2006; Stubbe 2012), so keep the correction simple.

## 2. Size-to-CEFR mapping (receptive)

| CEFR | Milton 2009/2010, X_Lex lemmas in first 5k | Nation, word families | App dictionary: median COCA `frq` of CEFR-J/Octanove words |
|---|---|---|---|
| A1 | <1,500 | ~1,000 | 1,060 |
| A2 | 1,500-2,500 | 1,000-2,000 | 2,400 |
| B1 | 2,500-3,250 | 2,000-3,000 | 3,900 |
| B2 | 3,250-3,750 | ~4,000 | 6,900 |
| C1 | 3,750-4,500 | 5,000-6,000 | 12,000 |
| C2 | 4,500-5,000 | 7,000-9,000 (8-9k = 98% coverage for unassisted reading, Nation 2006) | 17,200 |

Milton's scale saturates at 5,000 (X_Lex samples only to 5k); use it for A2-B1 and Nation's for B2-C2. CEFR-J 1.5 tags 7,799 entries (A1 1,164 / A2 1,411 / B1 2,446 / B2 2,778); Octanove adds C1 1,111 / C2 1,025. ECDICT has ~42k rows with `frq`, ~45k with `bnc`.

## 3. Recommended format (4-6 min)

- **Format:** yes/no checklist ("I know this" / "I don't"), one word per screen. Budget 3 s/item for an L2 learner: 100 items ≈ 5 min.
- **Items:** 100 = 80 real + 20 pseudowords (20%; X_Lex uses 1/6, Brysbaert 30%).
- **Bands by COCA `frq` (fallback `bnc`):** 1-2k, 2-3k, 3-4k, 4-5k, 5-7k, 7-10k, 10-14k, 14-20k. Two fixed-length stages so re-runs are comparable:
  - Stage 1 (40 real + 10 pseudo): 5 words per band, random order; provisional size S1.
  - Stage 2 (40 real + 10 pseudo): 40 words from the three bands around S1 (for a B2 learner roughly 4-5k, 5-7k, 7-10k) to sharpen the boundary.
- **Pseudowords:** legal non-words built Wuggy-style by swapping a syllable of a 3-8k word (*plenture*, *dastrict*); not in the dictionary; vetted pool of ~300, never repeated for one learner.
- **Scoring per band b:** h_b = yes-rate on real words, f = overall pseudoword yes-rate; k_b = max(0, (h_b - f)/(1 - f)) (cfg). Shrink k_b toward a logistic curve fitted across bands (monotone decreasing in rank) with Beta(1,1) pseudo-counts so 5-item bands cannot swing wildly.
- **Size:** V = sum over bands k_b x band width (lemmas); families ≈ V/1.6 for the first 10k (Brysbaert's 3.8 lemma/family ratio describes a 42k native vocabulary and would over-penalise). Report both, rounded to 250.
- **CEFR:** from families using Nation's scale (A2 <2,000; B1 2,000-3,500; B2 3,500-5,000; C1 5,000-7,000; C2 >7,000); cross-check with CEFR-tagged items: award a level only if k ≥ 0.8 on its CEFR-J words (VLT-style mastery, relaxed because yes/no is self-report).
- **Confidence:** bootstrap the 80 real items (1,000 resamples) for an 80% interval on V; if it spans one level show "B2", otherwise "B2 (B1-C1)". If f > 0.3 (6+ of 20 pseudowords) show "unreliable, retake" instead of a number.
- **Re-run:** store the seed; each run draws fresh items from the pools.

## 4. Item-selection rules

1. Candidate: `frq` > 0, single lowercase alphabetic token, length 3-12, base form (per `exchange`), content POS (n/v/adj/adv), not a proper noun.
2. Exclude abbreviations, swear words, transparent derivations of a lower-band word (*quickly* if *quick* is lower), loans familiar to Chinese speakers (*kungfu*), and words seen in the learner's reading in the last 30 days.
3. Stratify each band by POS (≥40% nouns, ≥25% verbs) and by `collins`/`oxford` flags so items are not all textbook words.
4. Prefer CEFR-J/Octanove-tagged words (~8,800 lemmas) so the CEFR cross-check has data in every band.

## 5. Updating from daily "I know / I don't know" taps

Keep a Beta posterior (alpha_b, beta_b) per band, initialised from the test (alpha = 1 + k_b n_b, beta = 1 + (1-k_b) n_b). Each tap on a word of band b is one observation with weight w = 0.5 (reader taps are noisier; count a word once): "know" adds w to alpha_b, "don't know" or a lookup adds w to beta_b. Decay alpha and beta by 0.98 per week so recent evidence dominates and the level can drift upward. Recompute V and CEFR nightly with the section-3 formula; surface a change only when the 80% interval moves a whole band. Elo alternative (Pelanek): d = log(rank), theta += K(y - sigmoid(theta - d)), K = 0.1; the Beta model is easier to explain and shows band detail, so prefer it. Offer a retake every 8-12 weeks and reset the Betas from it (n = 80).

## Sources

- Nation VST specs: https://www.wgtn.ac.nz/lals/resources/paul-nations-resources/vocabulary-tests/the-vocabulary-size-test/Vocabulary-Size-Test-information-and-specifications.pdf
- Nation, vocabulary and the CEFR: https://wgtn.ac.nz/lals/resources/paul-nations-resources/vocabulary-lists/vocabulary-cefr-and-word-family-size/vocabulary-and-the-cefr-docx
- Nation 2006: https://www.wgtn.ac.nz/__data/assets/pdf_file/0018/1626120/2006-How-large-a-vocab.pdf
- Webb, Sasao & Ballance 2017: https://www.jbe-platform.com/content/journals/10.1075/itl.168.1.02web ; form B: https://edu.uwo.ca/about/faculty-profiles/stuart-webb/_docs/nvlt-version-b.pdf
- Milton & Alexiou: https://www.enl.auth.gr/gala/14th/Papers/English%20papers/Milton&Alexiou.pdf
- Meara 1991: https://lognostics.co.uk/vlibrary/meara1991.doc
- Huibregtse et al. 2002: https://journals.sagepub.com/doi/10.1191/0265532202lt229oa
- Stubbe 2012: https://journals.sagepub.com/doi/10.1177/0265532211433033 ; Stubbe & Stewart: https://teval.jalt.org/sites/default/files/SRB-16-2-Full.pdf
- Gyllstad et al. 2015: https://eprints.nottingham.ac.uk/32284
- Brysbaert et al. 2016: https://www.frontiersin.org/articles/10.3389/fpsyg.2016.01116/full
- DIALANG: https://en.wikipedia.org/wiki/DIALANG ; Alderson & Huhta 2005: https://journals.sagepub.com/doi/10.1191/0265532205lt310oa
- Test Your Vocab: http://testyourvocab.com/details.php
- CEFR-J / Octanove: https://github.com/openlanguageprofiles/olp-en-cefrj
- Cambridge placement CAT: https://www.cambridgeenglish.org/Images/735983-cest-general-adaptive-testing.pdf
- Pelanek, Elo learner models: https://www.fi.muni.cz/~xpelanek/publications/CAE-elo.pdf

Caveat: Milton & Alexiou, Meara 1991, Nation's CEFR page, Test Your Vocab and Brysbaert 2016 were unreachable through the session proxy; their figures come from search excerpts and secondary citations and should be spot-checked before use in product copy.
