import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Settings, AiProviderId } from '@shared/settings';
import type { ExplainRequest } from '@shared/api';
import { DEFAULT_STYLES, DEFAULT_CONTEXT_RULES, KNOBS, PLACEHOLDERS, resolveStyles, type ExplanationStyle, type StyleId, type StyleOverride, type ScriptShape, type Personality, type Length, type AnswerType } from '@shared/styles';
import { buildStyledPrompt } from '@core/ai/prompts';
import { Tip } from '../ui/Tip';

/**
 * Settings → AI → Explanation styles: the learner picks, edits, copies, hides and creates the styles the AI
 * teaches in, edits the shared context rules, and can preview the exact prompt that will be sent.
 *
 * Every change is persisted through patchSettings → IPC. Patches carry only the fields that changed
 * (the main process deep-merges them), so two quick edits never overwrite each other. Text fields are
 * debounced 300 ms and flushed on blur and on unmount.
 */

export interface ModelChoice { provider: AiProviderId; id: string; name: string }

/** A nested partial of settings.ai; `null` for a style removes the learner's override (or the learner-made style). */
export type AiPatch = { [K in keyof Settings['ai']]?: K extends 'styles' ? Partial<Record<StyleId, StyleOverride | null>> : Settings['ai'][K] };

export const PLACEHOLDER_MEANINGS: Record<(typeof PLACEHOLDERS)[number], string> = {
  word: 'the word or phrase being explained',
  sentence: 'the sentence it is in',
  before: 'the text before the sentence',
  after: 'the text after the sentence',
  title: 'the book title',
  chapter: 'the chapter name',
  level: 'your English level',
  dict: 'the dictionary hint (sound, Chinese meaning, level)',
  native: 'your first language (Chinese)',
};

const SHAPE_FIELDS: { key: keyof ScriptShape; label: string; tip: string }[] = [
  { key: 'wordBefore', label: 'Say the word before', tip: 'How many times the voice says the word before the explanation' },
  { key: 'wordAfter', label: 'Say the word after', tip: 'How many times the voice says the word after the explanation' },
  { key: 'sentenceAfterWord', label: 'Sentence after a word', tip: 'After a word is explained, read its sentence this many times' },
  { key: 'sentenceBefore', label: 'Sentence before', tip: 'When a sentence is explained, read it this many times first' },
  { key: 'sentenceAfter', label: 'Sentence after', tip: 'When a sentence is explained, read it this many times afterwards' },
];

const KNOB_TIPS: Record<Personality | Length | AnswerType, string> = {
  warm: 'Encouraging, uses "you" and "we", praises one thing you already know',
  strict: 'Straight to the point, no small talk, ends with one thing to remember',
  peer: 'A relaxed classmate reading the same book with you',
  short: 'About fifty words: the meaning here and one reason it matters',
  normal: 'About a minute of speaking: meaning, role in the context, one example',
  long: 'Up to two minutes: meaning, context, sound or structure, example, a nearby line',
  explain: 'Only explains; never asks you questions',
  quiz: 'Explains, then asks one short question, waits, then gives the answer',
  example: 'Explains, then gives one new everyday sentence of its own',
};

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for unit tests)

/** "Teacher Style" -> "teacher-style"; empty -> "style". */
export function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/g, '');
  return s || 'style';
}

/** The first free learner-made id for a name: my-<slug>-1, my-<slug>-2, ... */
export function nextStyleId(name: string, existing: readonly string[]): string {
  const base = `my-${slugify(name)}`;
  for (let n = 1; ; n++) {
    const id = `${base}-${n}`;
    if (!existing.includes(id)) return id;
  }
}

/** The override that makes a full, independent copy of a style as a learner-made one. */
export function duplicateOverride(style: ExplanationStyle): StyleOverride {
  return {
    userMade: true, hidden: false,
    name: `${style.name} (copy)`, description: style.description, basis: `Your own style, copied from ${style.name}.`,
    wordPrompt: style.wordPrompt, sentencePrompt: style.sentencePrompt, shape: { ...style.shape },
    provider: style.provider, model: style.model, maxTokens: style.maxTokens,
    personality: style.personality, length: style.length, answerType: style.answerType,
  };
}

/** The override for a brand-new learner-made style; its prompts come from the custom style's defaults. */
export function newStyleOverride(): StyleOverride {
  return { userMade: true, hidden: false, name: 'My new style', description: 'Your own style.', basis: 'Your own style. Edit anything below.' };
}

export function isBuiltin(id: StyleId): boolean { return DEFAULT_STYLES.some((d) => d.id === id); }

/** A sample explanation request for the prompt preview. */
export function sampleRequest(kind: 'word' | 'sentence'): ExplainRequest {
  const sentence = 'Mr. Darcy remained sanguine about the weather.';
  return {
    kind, target: kind === 'word' ? 'sanguine' : sentence, sentence,
    before: 'The letter arrived the next morning. It contained a single, perplexing sentence. Elizabeth read it twice before folding it away.',
    after: 'The committee\'s deliberations were protracted and acrimonious, but a consensus emerged. The children went home.',
    book: { title: 'Pride and Prejudice', chapter: 'Chapter 3' },
    dict: kind === 'word' ? { ipa: 'ˈsæŋɡwɪn', zh: '乐观的', level: 'C1' } : null,
    position: { chapter: 2, paragraph: 4, sentence: 1 }, history: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Debounced text fields

/** Local draft of a text value, committed `delay` ms after the last keystroke, on blur and on unmount. */
function useDebouncedText(value: string, commit: (v: string) => void, delay = 300): { draft: string; change: (v: string) => void; flush: () => void } {
  const [draft, setDraft] = useState(value);
  const timer = useRef<number | null>(null);
  const pending = useRef<string | null>(null);
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => { if (pending.current === null) setDraft(value); }, [value]);
  const flush = useCallback(() => {
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    if (pending.current !== null) { const v = pending.current; pending.current = null; commitRef.current(v); }
  }, []);
  useEffect(() => flush, [flush]);
  const change = useCallback((v: string) => {
    setDraft(v);
    pending.current = v;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, delay);
  }, [flush, delay]);
  return { draft, change, flush };
}

function DebouncedTextarea({ value, onCommit, className, testId, title, rows }: { value: string; onCommit: (v: string) => void; className?: string; testId?: string; title?: string; rows?: number }): JSX.Element {
  const { draft, change, flush } = useDebouncedText(value, onCommit);
  return <textarea className={className} value={draft} onChange={(e) => change(e.target.value)} onBlur={flush} data-testid={testId} title={title} rows={rows} spellCheck={false} />;
}

function DebouncedInput({ value, onCommit, testId, title, placeholder }: { value: string; onCommit: (v: string) => void; testId?: string; title?: string; placeholder?: string }): JSX.Element {
  const { draft, change, flush } = useDebouncedText(value, onCommit);
  return <input type="text" value={draft} onChange={(e) => change(e.target.value)} onBlur={flush} data-testid={testId} title={title} placeholder={placeholder} />;
}

// ---------------------------------------------------------------------------------------------

function Segmented<T extends string>({ options, value, onChange, testPrefix, label }: { options: { id: T; label: string; tip: string }[]; value: T; onChange: (v: T) => void; testPrefix: string; label: string }): JSX.Element {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <Tip key={o.id} text={o.tip} wrap below>
          <button type="button" className={o.id === value ? 'on' : ''} role="radio" aria-checked={o.id === value} onClick={() => onChange(o.id)} data-testid={`${testPrefix}-${o.id}`}>{o.label}</button>
        </Tip>
      ))}
    </div>
  );
}

export function StylesEditor({ settings, patch, models }: { settings: Settings; patch: (p: Partial<Settings>) => void; models: ModelChoice[] }): JSX.Element {
  const ai = settings.ai;
  const styles = useMemo(() => resolveStyles(ai.styles), [ai.styles]);
  const [selectedId, setSelectedId] = useState<StyleId>(ai.activeStyle);
  const selected = styles.find((s) => s.id === selectedId) ?? styles.find((s) => s.id === ai.activeStyle) ?? styles[0];
  const visible = styles.filter((s) => !s.hidden);
  const hidden = styles.filter((s) => s.hidden);
  const builtin = isBuiltin(selected.id);

  const patchAi = useCallback((p: AiPatch) => patch({ ai: p } as unknown as Partial<Settings>), [patch]);
  const patchStyle = useCallback((id: StyleId, o: StyleOverride) => patchAi({ styles: { [id]: o } }), [patchAi]);
  const edit = (o: StyleOverride) => patchStyle(selected.id, o);

  const use = (id: StyleId) => patchAi({ activeStyle: id });
  const duplicate = () => {
    const id = nextStyleId(selected.name, styles.map((s) => s.id));
    patchStyle(id, duplicateOverride(selected));
    setSelectedId(id);
  };
  const create = () => {
    const id = nextStyleId('style', styles.map((s) => s.id));
    patchStyle(id, newStyleOverride());
    setSelectedId(id);
  };
  const hide = () => {
    const other = visible.find((s) => s.id !== selected.id) ?? styles[0];
    patchAi({ styles: { [selected.id]: { hidden: true } }, ...(ai.activeStyle === selected.id ? { activeStyle: other.id } : {}) });
    setSelectedId(other.id);
  };
  const restore = (id: StyleId) => { patchStyle(id, { hidden: false }); setSelectedId(id); };
  const remove = () => {
    const other = ai.activeStyle === selected.id ? (visible.find((s) => s.id !== selected.id) ?? styles[0]).id : ai.activeStyle;
    patchAi({ styles: { [selected.id]: null }, ...(ai.activeStyle === selected.id ? { activeStyle: other } : {}) });
    setSelectedId(other);
  };
  const reset = () => patchAi({ styles: { [selected.id]: selected.hidden ? { hidden: true } : null } });

  const setShape = (key: keyof ScriptShape, raw: string) => {
    const n = Math.max(0, Math.min(9, Math.round(Number(raw))));
    if (Number.isNaN(n)) return;
    edit({ shape: { ...selected.shape, [key]: n } });
  };
  const modelValue = selected.provider && selected.model ? `${selected.provider}:${selected.model}` : '';
  const defaultModelName = models.find((m) => m.provider === ai.provider && m.id === (ai.provider === 'anthropic' ? ai.anthropicModel : ai.openaiModel))?.name ?? (ai.provider === 'anthropic' ? ai.anthropicModel : ai.openaiModel);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewKind, setPreviewKind] = useState<'word' | 'sentence'>('word');
  const preview = useMemo(() => previewOpen ? buildStyledPrompt(sampleRequest(previewKind), { style: selected, contextRules: ai.contextRules, level: settings.learnerLevel, native: 'Chinese' }) : null, [previewOpen, previewKind, selected, ai.contextRules, settings.learnerLevel]);

  return (
    <div className="styles-editor" data-testid="styles-editor">
      <h3>Explanation styles</h3>
      <div className="field">
        <label>How the AI teaches a word or a sentence</label>
        <div className="style-grid" role="listbox" aria-label="Explanation styles">
          {visible.map((s) => (
            <div key={s.id} className={`style-card${s.id === selected.id ? ' selected' : ''}${s.id === ai.activeStyle ? ' in-use' : ''}`} role="option" aria-selected={s.id === selected.id} tabIndex={0}
              onClick={() => setSelectedId(s.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedId(s.id); } }} data-testid={`style-card-${s.id}`}>
              <span className="name"><span>{s.name}</span>{s.id === ai.activeStyle && <span className="badge on" data-testid="style-active-badge">Active</span>}{s.userMade && s.id !== ai.activeStyle && <span className="badge">Yours</span>}</span>
              <span className="desc">{s.description}</span>
              <span className="basis">{s.basis}</span>
            </div>
          ))}
        </div>
        <div className="hint">Click a style to see and edit it below. The <b>Active</b> style is the one used when a word or sentence is explained. Every style's text can be changed; built-in styles can always be reset.</div>
      </div>
      {hidden.length > 0 && (
        <details className="hidden-styles" data-testid="hidden-styles">
          <summary>Hidden styles ({hidden.length}) — restore</summary>
          <div className="row" style={{ marginTop: 8 }}>
            {hidden.map((s) => (
              <Tip key={s.id} text="Show this style in the list again" below>
                <button onClick={() => restore(s.id)} data-testid={`style-restore-${s.id}`}>{s.name} ↺</button>
              </Tip>
            ))}
          </div>
        </details>
      )}

      <div className="card" data-testid="style-editor">
        <div className="row style-actions">
          <Tip text="Explain words and sentences with this style from now on" below><button className="primary" onClick={() => use(selected.id)} disabled={ai.activeStyle === selected.id} data-testid="style-use">{ai.activeStyle === selected.id ? 'In use' : 'Use this style'}</button></Tip>
          <Tip text="Make your own copy of this style that you can change freely" below><button onClick={duplicate} data-testid="style-duplicate">Duplicate</button></Tip>
          {builtin
            ? <Tip text="Take this style out of the list; you can restore it any time" below><button onClick={hide} disabled={visible.length < 2 || selected.hidden} data-testid="style-hide">Hide</button></Tip>
            : <Tip text="Delete this style of yours for good" below><button onClick={remove} data-testid="style-delete">Delete</button></Tip>}
          <span style={{ flex: 1 }} />
          <Tip text="Start a new style of your own from the custom defaults" below align="end"><button onClick={create} data-testid="style-new">+ New style</button></Tip>
        </div>

        <div key={selected.id} className="style-fields">
          <div className="row" style={{ gap: 18, alignItems: 'flex-start' }}>
            <div className="field" style={{ flex: 1, minWidth: 220 }}>
              <label>Name</label>
              <DebouncedInput value={selected.name} onCommit={(name) => edit({ name })} testId="style-name" title="The name shown in the list of styles" />
            </div>
            <div className="field" style={{ flex: 2, minWidth: 260 }}>
              <label>One-line description</label>
              <DebouncedInput value={selected.description} onCommit={(description) => edit({ description })} testId="style-description" title="One line under the name in the list of styles" placeholder="What this style does, in one line" />
            </div>
          </div>

          <div className="row knobs" style={{ gap: 18, alignItems: 'flex-start' }}>
            <div className="field"><label>Personality</label>
              <Segmented label="Personality" testPrefix="knob-personality" value={selected.personality} onChange={(personality) => edit({ personality })}
                options={(Object.keys(KNOBS.personality) as Personality[]).map((id) => ({ id, label: KNOBS.personality[id].label, tip: KNOB_TIPS[id] }))} /></div>
            <div className="field"><label>Length</label>
              <Segmented label="Length" testPrefix="knob-length" value={selected.length} onChange={(length) => edit({ length })}
                options={(Object.keys(KNOBS.length) as Length[]).map((id) => ({ id, label: KNOBS.length[id].label, tip: KNOB_TIPS[id] }))} /></div>
            <div className="field"><label>Answer type</label>
              <Segmented label="Answer type" testPrefix="knob-answer" value={selected.answerType} onChange={(answerType) => edit({ answerType })}
                options={(Object.keys(KNOBS.answerType) as AnswerType[]).map((id) => ({ id, label: KNOBS.answerType[id].label, tip: KNOB_TIPS[id] }))} /></div>
          </div>
          <div className="hint">Each choice adds one sentence to the prompt. Open <b>Preview</b> below to read them.</div>

          <div className="field">
            <label><Tip text="Sent when a word or a phrase is explained; the context rules and the book text go with it" wrap below align="start"><span>Word prompt</span></Tip></label>
            <DebouncedTextarea className="prompt" value={selected.wordPrompt} onCommit={(wordPrompt) => edit({ wordPrompt })} testId="style-word-prompt" title="What the AI is asked to do for a word or a phrase" />
          </div>
          <div className="field">
            <label><Tip text="Sent when a whole sentence is explained" wrap below align="start"><span>Sentence prompt</span></Tip></label>
            <DebouncedTextarea className="prompt" value={selected.sentencePrompt} onCommit={(sentencePrompt) => edit({ sentencePrompt })} testId="style-sentence-prompt" title="What the AI is asked to do for a sentence" />
          </div>
          <div className="placeholder-legend" aria-label="Placeholders you can use">
            <span className="lead">You can write these in a prompt:</span>
            {PLACEHOLDERS.map((p) => <span key={p}><code>{`{{${p}}}`}</code> {PLACEHOLDER_MEANINGS[p]}</span>)}
            <span><code>[PAUSE]</code> on its own line in the reply: the voice pauses and waits for you</span>
          </div>
          {builtin && (
            <div className="hint">
              <a href="#" onClick={(e) => { e.preventDefault(); reset(); }} data-testid="style-reset" title="Put back the built-in name, prompts, knobs, script shape and model of this style">Reset this style to default</a>
            </div>
          )}

          <div className="field">
            <label>What the voice says around the explanation</label>
            <div className="shape-row">
              {SHAPE_FIELDS.map((f) => (
                <div className="field" key={f.key}>
                  <label>{f.label}</label>
                  <Tip text={f.tip} wrap below align="start"><input type="number" min={0} max={9} value={selected.shape[f.key]} onChange={(e) => setShape(f.key, e.target.value)} data-testid={`shape-${f.key}`} /></Tip>
                </div>
              ))}
            </div>
            <div className="hint">Times. For a word: say the word, explain, say the word again, then read its sentence. For a sentence: read it, explain, read it again.</div>
          </div>

          <div className="row" style={{ gap: 18, alignItems: 'flex-start' }}>
            <div className="field">
              <label>AI model for this style</label>
              <Tip text="A cheaper or smarter model just for this style; the default is the one chosen above" wrap below align="start">
                <select value={modelValue} onChange={(e) => { const [provider, ...rest] = e.target.value.split(':'); const id = rest.join(':'); edit(provider && id ? { provider: provider as AiProviderId, model: id } : { provider: null, model: null }); }} data-testid="style-model">
                  <option value="">Use the default model ({defaultModelName})</option>
                  {models.map((m) => <option key={`${m.provider}:${m.id}`} value={`${m.provider}:${m.id}`}>{m.name}</option>)}
                </select>
              </Tip>
            </div>
            <details className="advanced">
              <summary>Advanced</summary>
              <div className="field" style={{ marginTop: 8 }}>
                <label>Longest reply (tokens)</label>
                <Tip text="A hard stop on the length of the reply; the length knob above already tells the AI how long to talk" wrap below align="start">
                  <input type="number" min={100} max={4000} step={50} value={selected.maxTokens} onChange={(e) => { const n = Number(e.target.value); if (!Number.isNaN(n) && n > 0) edit({ maxTokens: n }); }} data-testid="style-max-tokens" style={{ width: 110 }} />
                </Tip>
              </div>
            </details>
          </div>
        </div>

        <div className="field prompt-preview">
          <div className="row">
            <Tip text="See the exact text that will be sent to the AI, for a sample sentence" wrap below align="start"><button onClick={(e) => { setPreviewOpen((o) => !o); e.currentTarget.blur(); }} data-testid="style-preview" aria-expanded={previewOpen}>{previewOpen ? 'Hide preview' : 'Preview the prompt'}</button></Tip>
            {previewOpen && (
              <div className="seg" role="radiogroup" aria-label="Preview for">
                <Tip text="Preview the prompt for a word" below><button className={previewKind === 'word' ? 'on' : ''} onClick={() => setPreviewKind('word')} data-testid="preview-word">A word</button></Tip>
                <Tip text="Preview the prompt for a sentence" below><button className={previewKind === 'sentence' ? 'on' : ''} onClick={() => setPreviewKind('sentence')} data-testid="preview-sentence">A sentence</button></Tip>
              </div>
            )}
          </div>
          {preview && (
            <div className="preview-box" data-testid="preview-box">
              <div className="hint">Sample: the word <b>sanguine</b> in <i>Pride and Prejudice</i>. The real prompt uses your book, {ai.contextWordsBefore} words before and {ai.contextWordsAfter} words after the sentence. Up to {preview.maxTokens} tokens of reply.</div>
              <div className="preview-label">System (the context rules)</div>
              <pre data-testid="preview-system">{preview.system}</pre>
              <div className="preview-label">User (the book text and this style's prompt)</div>
              <pre data-testid="preview-user">{preview.user}</pre>
            </div>
          )}
        </div>
      </div>

      <h3>Context rules</h3>
      <div className="card" data-testid="context-rules-card">
        <div className="field">
          <label><Tip text="Sent with every style as the system prompt: who the AI is, how to read the passage, how to speak" wrap below align="start"><span>Rules shared by every style</span></Tip></label>
          <DebouncedTextarea className="prompt rules" value={ai.contextRules} onCommit={(contextRules) => patchAi({ contextRules })} testId="context-rules" title="The shared rules sent with every explanation" />
          <div className="hint">These rules go with every explanation, before the style's own prompt. <a href="#" onClick={(e) => { e.preventDefault(); patchAi({ contextRules: DEFAULT_CONTEXT_RULES }); }} data-testid="context-reset">Reset to default</a></div>
        </div>
        <div className="row" style={{ gap: 18, alignItems: 'flex-start' }}>
          <div className="field">
            <label>Words of text before the sentence</label>
            <Tip text="How much of the book before the sentence the AI reads; more context costs a little more" wrap below align="start"><input type="number" min={0} max={3000} step={50} value={ai.contextWordsBefore} onChange={(e) => { const n = Number(e.target.value); if (!Number.isNaN(n) && n >= 0) patchAi({ contextWordsBefore: Math.round(n) }); }} data-testid="context-before" style={{ width: 110 }} /></Tip>
          </div>
          <div className="field">
            <label>Words of text after</label>
            <Tip text="How much of the book after the sentence the AI reads" wrap below align="start"><input type="number" min={0} max={3000} step={50} value={ai.contextWordsAfter} onChange={(e) => { const n = Number(e.target.value); if (!Number.isNaN(n) && n >= 0) patchAi({ contextWordsAfter: Math.round(n) }); }} data-testid="context-after" style={{ width: 110 }} /></Tip>
          </div>
          <div className="field" style={{ flex: 1, minWidth: 240 }}>
            <label>Scene picture</label>
            <Tip text="Draws the scene the Picture style describes" wrap below align="start">
              <label className="row" style={{ gap: 8, fontWeight: 400 }}>
                <input type="checkbox" checked={ai.generateScenePicture} onChange={(e) => patchAi({ generateScenePicture: e.target.checked })} data-testid="scene-picture" /> Also make a picture of the scene
              </label>
            </Tip>
            <div className="hint">Picture style only; uses your OpenAI key, about 1 to 4 cents per picture.</div>
          </div>
        </div>
        <div className="hint">Defaults: 500 words before, 200 after.</div>
      </div>
    </div>
  );
}
