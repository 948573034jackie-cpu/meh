# Voice tutor research (Electron, macOS 13+, Intel + Apple Silicon) — Oct 2026

Cost basis: 3 h/day ≈ 5,400 min/month open session; user speaks ≈ 2,200 min, tutor ≈ 2,160 min ≈ 2M TTS characters. OpenAI, Deepgram, ElevenLabs, Cartesia, AssemblyAI and Azure pricing pages were unreachable from this sandbox; those figures are from 2026 secondary sources — re-check before committing.

## A. Speech-to-text

### Local (no Python)
| Engine | Node/Electron packaging | Notes |
|---|---|---|
| **sherpa-onnx** (`sherpa-onnx-node` 1.13.8) | N-API addon, prebuilt `sherpa-onnx-darwin-x64` and `-darwin-arm64` optional deps; dylibs must be found via `DYLD_LIBRARY_PATH` or unpacked from asar (`asarUnpack`) | One addon covers streaming Zipformer, Whisper, **Moonshine v2 (tiny/base, 2026-02 release)**, **Parakeet TDT 0.6B v2/v3 int8** (with hotwords), **Silero VAD**, and a **keyword spotter** — plus Kokoro TTS. Best single dependency for both Mac architectures. https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/master/nodejs-addon-examples/README.md |
| whisper.cpp | `whisper-cpp-node` 0.2.12 (prebuilt **darwin-arm64 only**, Metal, macOS 13.3+); `smart-whisper` 0.8.1 (Metal on Apple Silicon, BYO lib on Intel); upstream `addon.node` is cmake-js, "works in node and electron" | Electron ABI rebuild needed except prebuilt. tiny/base weak on accents; large too slow on Intel. https://cdn.jsdelivr.net/npm/whisper-cpp-node@0.2.12/README.md , https://classic.yarnpkg.com/en/package/smart-whisper |
| Moonshine | `@moonshine-ai/moonshine-js` 0.1.29 (ONNX Runtime Web + vad-web in the renderer, streaming mode) or via sherpa-onnx | Vendor numbers: Tiny Streaming 12.0% WER vs Whisper Tiny 12.8%, 34 ms vs 277 ms on M1; Small Streaming 7.8% WER. Good CPU choice for Intel. https://moonshine-voice.readthedocs.io/en/latest/moonshine-vs-whisper/ , https://dev.moonshine.ai/js |
| Parakeet TDT 0.6B v3 (ONNX) | via sherpa-onnx (offline model, pair with Silero VAD) | ~9–10% avg WER (int8), ~1.9% on clean English; one aggregator reports 9.2% on accented calls vs 15% for Whisper large-v3. Model ≈1 GB int8; fine on M-series, borderline on older Intel. https://arxiv.org/pdf/2604.14493 , https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx |
| Vosk | `vosk` npm uses ffi-napi (fragile in Electron); `vosk-lib` has mac x64+arm64 libs | Kaldi-era accuracy, worst on accents; skip. https://www.npmjs.com/package/vosk-lib |
| Apple SFSpeechRecognizer | Swift CLI helper spawned from main (stdio JSON). `requiresOnDeviceRecognition` macOS 10.15+, en-US on-device, ~1-min per-request cap (restart tasks); SpeechAnalyzer is macOS 26 / Apple Silicon only | Free, but no custom vocab on-device, no accent figures; helper needs `NSSpeechRecognitionUsageDescription` and signing. https://developer.apple.com/documentation/speech/sfspeechrecognizer.md , https://devstreaming-cdn.apple.com/videos/wwdc/2019/256p7m9z4yst71ai/256/256_advances_in_speech_recognition.pdf |
| Web Speech `webkitSpeechRecognition` | **Does not work in Electron**: it calls Google servers, which block non-Chrome shells | https://github.com/jrichardsz/electron-speech |

**VAD:** Silero VAD v5 via `@ricky0123/vad-web` 0.0.31 (onnxruntime-web, 512-sample frames @16 kHz) in the renderer, or sherpa-onnx's Silero in main. https://docs.vad.ricky0123.com/user-guide/browser/

### Cloud STT (streaming)
- **OpenAI** `gpt-4o-transcribe` ≈ $0.006/min, `gpt-4o-mini-transcribe` ≈ $0.003/min (billed on audio submitted, so VAD-gate it); Realtime-transcription WebSocket session with `server_vad`/`semantic_vad`; `gpt-realtime-whisper` $0.017/min. https://costgoat.com/pricing/openai-transcription , https://developers.openai.com/api/docs/guides/realtime-vad
- **Deepgram Nova-3** streaming $0.0077/min list (promo $0.0048), **Flux** (STT + end-of-turn events, cuts 200–600 ms) ≈ $0.008/min; sub-300 ms; $200 free credit. https://www.costbench.com/software/ai-transcription-apis/deepgram/ , https://www.happyrobot.ai/hub/deepgram-pricing
- **AssemblyAI Universal-Streaming** $0.15/h ($0.0025/min, billed on socket-open time), ~300 ms p50. https://flexprice.io/pricing-index/assemblyai
- **Google STT v2** (chirp_3) $0.016/min, 60 free min/month; not competitive. https://cloud.google.com/speech-to-text/pricing

## B. Full real-time options
- **OpenAI Realtime** (`gpt-realtime-2.1` $32/$64 per 1M audio tokens in/out, cached $0.40; `gpt-realtime-2.1-mini` $10/$20, cached $0.30). WebRTC from the renderer with a 1-minute ephemeral key; `turn_detection: server_vad | semantic_vad` with `interrupt_response: true` gives built-in barge-in. Real cost ≈ $0.06–0.11/min flagship, $0.02–0.05/min mini → **$110–270/month (mini) or $320–590/month (flagship)** at 5,400 min. Old `gpt-realtime`/`-mini` retire 2027-01-20. https://www.forasoft.com/blog/article/openai-realtime-api-pricing , https://www.marktechpost.com/2026/07/06/openai-gpt-realtime-2-1-mini-reasoning-realtime-api/
- **Gemini Live** (`gemini-2.5-flash-native-audio`, 3.1 Flash Live, 3.8 Live): **free tier exists** (rate-limited, ~3 concurrent sessions historically, ~10–15 min session cap/reconnect); paid $3/1M audio in, $12/1M audio out ≈ $0.005 + $0.018/min. Browser WebSocket with ephemeral token (v1alpha), server-side VAD barge-in. ≈ **$60–90/month paid**, $0 on free tier. https://ai.google.dev/gemini-api/docs/pricing , https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket , https://firebase.google.com/docs/ai-logic/live-api/limits-and-specs
- **Pipeline** VAD → STT → Claude/GPT stream → streaming TTS: 450–800 ms to first audio in the lab (VAD 50 + STT 150 + LLM TTFT 400 + TTS 150 + net 50); field p50 is 1.1–1.7 s, dominated by end-of-utterance silence wait (300–800 ms). Interruption = VAD `onSpeechStart` → stop playback, abort LLM/TTS streams. Claude Haiku 4.5 TTFT ≈ 0.6–0.8 s; feed TTS sentence-by-sentence. https://smallest.ai/blog/designing-voice-assistants-stt-llm-tts-tools-and-latency-budget , https://altersquare.medium.com/voice-agent-latency-where-the-2-3-second-delay-actually-lives-in-the-pipeline-and-how-to-reduce-it-50d54c2bd211 , https://artificialanalysis.ai/models/claude-4-5-haiku/providers

## C. Text-to-speech
| TTS | Price | Streaming / first byte | Word timestamps |
|---|---|---|---|
| **Kokoro-82M** local (`kokoro-js` 1.2.1 WASM/WebGPU; or sherpa-onnx Kokoro, x64+arm64) | $0 | Sentence-level, faster than real-time on M-series; slow on old Intel | No (sentence-chunk only) |
| **Edge TTS** (`msedge-tts` 2.1.0, unofficial) | $0 | WebSocket, ~300 ms; must run in main process (browser path blocked); cloud IPs blocked; can break any time | Yes (word boundary events) https://gittrend.io/repo/rany2/edge-tts |
| OpenAI `gpt-4o-mini-tts` | $0.60/1M text tokens + $12/1M audio tokens ≈ $0.015/min (~$0.012/1k chars) | HTTP chunked streaming (pcm/wav fastest); no input streaming | No https://community.openai.com/t/understanding-gpt-4o-mini-tts-pricing-input-characters-cost/1151816 |
| ElevenLabs Flash v2.5 | ~$50/1M chars (0.5 credit/char); free 10k credits/mo | WebSocket `stream-input`, ~75 ms model / ~200 ms measured | Yes (`alignment` char timestamps) https://humannessindex.vapi.ai/models/elevenlabs-flash-v2-5 |
| Google Chirp 3 HD / Neural2 / WaveNet | $30 / $16 / $4 per 1M; **free 1M / 1M / 4M chars per month** | Chirp 3 HD only: bidirectional `StreamingSynthesize` (PCM/Opus) | `<mark>` timepoints on batch; not on streaming https://cloud.google.com/text-to-speech/pricing |
| Azure Neural | $15/1M, **free 500k/mo**; HD <300 ms | SDK streaming | Yes (WordBoundary) on standard neural, **not HD** https://learn.microsoft.com/fi-fi/azure/ai-services/speech-service/high-definition-voices |
| Cartesia Sonic 3.x | ~1 credit/char, free 20k/mo (non-commercial), $5/$49/$299 plans ≈ $40–49/1M | WebSocket, ~40–90 ms TTFB | Yes (`add_timestamps` → word + phoneme) https://docs.cartesia.ai/api-reference/tts/websocket |
| Inworld TTS-1.5 Mini / TTS-2 Flash | $5 / $15 per 1M | ~120 ms p50 / sub-200 ms | Yes https://docs.inworld.ai/stt/resources/billing |
| Gemini 2.5 Flash TTS / 3.8 Flash-Lite TTS | $10 / $6 per 1M audio tokens (free tier in AI Studio) | Not low-latency streaming | No https://cloud.google.com/text-to-speech/pricing |

## Recommendations

**(1) Default free path (~$0 + LLM):** Renderer: Silero VAD (`@ricky0123/vad-web`) gates the mic. Main: `sherpa-onnx-node` running **Moonshine v2 tiny/base** (Intel + M-series) or **Parakeet TDT 0.6B v3 int8** on Apple Silicon for accent robustness; ship both darwin packages, `asarUnpack` the dylibs. TTS: **Kokoro** via the same addon; optional **Edge TTS** toggle (word boundaries, but unofficial). LLM: user's Claude key, Haiku 4.5 ≈ **$10–20/month** at 300 turns/day with prompt caching. Turn latency ≈ 1.0–1.5 s; no audio leaves the machine. A billing-enabled GCP project adds **4M WaveNet + 1M Neural2 + 1M Chirp 3 HD free chars/month**, covering 2M chars/month at $0.

**(2) Best paid path (~$75–110/month):** Pipeline, not speech-to-speech — keeps Claude as tutor, yields transcripts for the keyword logic, costs a third of Realtime-mini. STT: **Deepgram Flux** (end-of-turn built in, $43/mo) or **gpt-4o-mini-transcribe over the Realtime transcription socket with `semantic_vad`** ($7–13/mo). TTS: **Cartesia Sonic** ($49 Startup, word timestamps for highlighting) or **Inworld TTS-2 Flash** ($30) or Chirp 3 HD streaming ($30 after free 1M). LLM: Haiku/Sonnet 4.5 ($15–50). Target 600–900 ms to first audio. If the user wants OpenAI end-to-end, `gpt-realtime-2.1-mini` over WebRTC is the simplest build but **$110–270/month**; Gemini Live is $60–90 paid or free on the rate-limited tier, but then Gemini is the tutor.

## Voice-command detection ("I know" / "I don't know" / "bye bye")
1. **Fast path on every partial transcript** (streaming STT partials every ~100–300 ms; with Moonshine/Parakeet, on each VAD segment end). Never wait for the LLM.
2. **Normalise**: lowercase, strip punctuation, collapse whitespace, "dont"→"don't", drop fillers ("um", "uh", "okay").
3. **Grammar**: tiny phrase list per intent with Mandarin-L1 accent variants (final-consonant drop, th→s/d, v→w):
   - KNOW: `i know`, `i knew`, `i no`, `i now`, `i know it`, `yes i know`
   - DONT_KNOW: `i don't know`, `i dont know`, `i don no`, `i do not know`, `don't know`, `no idea`, `i'm not sure`
   - BYE: `bye bye`, `bye`, `goodbye`, `bai bai`, `by by`, `see you`
   Check DONT_KNOW before KNOW (substring collision).
4. **Fuzzy match**: Levenshtein ratio (`fastest-levenshtein`) on the whole utterance plus Double-Metaphone equality (`talisman`). Accept if `utterance.length ≤ phrase.length + 6` AND (ratio ≥ 0.80 OR phonetic match). Reject if > 6 words — that's conversation, send to the LLM.
5. **Confidence threshold**: STT word confidence ≥ 0.6 where available (Deepgram/AssemblyAI/Parakeet; Moonshine/Whisper lack it, so require ratio ≥ 0.85), and two agreeing partials or a final before firing. Once per VAD segment; 1 s debounce.
6. **Optional audio-level boost**: sherpa-onnx's streaming Zipformer keyword spotter (3.3M params, keywords in a text file, per-keyword threshold/boost, no retraining) runs in parallel on raw audio (~50 ms), confirmed by the STT text. https://huggingface.co/openEuler/sherpa-kws
7. Add the phrases to the STT hotword/bias list (Parakeet hotwords in sherpa-onnx, Deepgram `keyterm`, OpenAI `prompt`).
