/**
 * What is sent to Claude. Claude Haiku 5.5 thinks before it answers unless it is told not to: for the tutor's short
 * answers thinking is off (and no room is kept for it); the bigger models refuse that setting, so they never get it.
 * And the "explain the last N seconds" request of I Know Book speaks of a book, not of a paused video.
 * The requests go to a made-up server on this computer (no AI service, no key).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { anthropicParams, thinkingOff, runCompletion, runExplain } from '../src/bg';
import { partPromptFor, BOOK_PART_PROMPT, BOOK_ALWAYS_RULES, type RuleRequest } from '../src/level-rule';
import { PART_PROMPT, ALWAYS_RULES } from '../src/teacher-text';

const prompt = { system: 'You explain one word.', user: 'The word: meticulous', maxTokens: 420 };

describe('the request for Claude (the pure builder)', () => {
  it('Claude Haiku 5.5: thinking off, effort low, no 1000 tokens of room for thinking (a small margin)', () => {
    const p = anthropicParams('claude-haiku-5-5', prompt);
    expect(p.thinking).toEqual({ type: 'disabled' });
    expect(p.output_config).toEqual({ effort: 'low' });
    expect(p.max_tokens).toBeGreaterThan(420);
    expect(p.max_tokens).toBeLessThanOrEqual(420 + 300);
    expect(p.model).toBe('claude-haiku-5-5');
    expect(p.system).toEqual([{ type: 'text', text: 'You explain one word.', cache_control: { type: 'ephemeral' } }]);
    expect(p.messages).toEqual([{ role: 'user', content: 'The word: meticulous' }]);
  });
  it('Opus 5.5, Sonnet 5.5 and Fable refuse "thinking: disabled" (HTTP 400): the field is not sent, the room stays', () => {
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-fable-5-2', 'claude-opus-5', 'claude-sonnet-5']) {
      const p = anthropicParams(model, prompt);
      expect('thinking' in p, model).toBe(false);
      expect(p.max_tokens, model).toBe(1420);
      expect(p.output_config, model).toEqual({ effort: 'low' });
      expect(thinkingOff(model), model).toBe(false);
    }
  });
  it('only the Haiku 5 family: not the old Haiku 4.5, not another maker\'s model', () => {
    expect(thinkingOff('claude-haiku-5-5')).toBe(true);
    expect(thinkingOff('claude-haiku-4-5')).toBe(false);
    expect(thinkingOff('gpt-5.6-luna')).toBe(false);
    expect('thinking' in anthropicParams('claude-haiku-4-5', prompt)).toBe(false);
  });
});

// ---- over the wire: a made-up Claude on this computer ------------------------------------------------------------
interface Seen { path: string; body: { model: string; max_tokens: number; thinking?: unknown; output_config?: unknown; stream?: boolean; system: { text: string }[]; messages: { content: string }[] } }
const seen: Seen[] = [];
let server: http.Server;
let stored: Record<string, unknown> = {};

const sse = (res: http.ServerResponse, model: string, text: string) => {
  const ev = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  ev('message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } });
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
  ev('content_block_stop', { index: 0 });
  ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } });
  ev('message_stop', {});
  res.end();
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Seen['body'];
      seen.push({ path: req.url ?? '', body });
      sse(res, body.model, 'Very careful.');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});
beforeEach(() => {
  seen.length = 0;
  stored = { drKeys: { anthropic: 'test-key-not-real' }, drTestBaseUrls: { anthropic: `http://127.0.0.1:${(server.address() as AddressInfo).port}` } };
  (globalThis as unknown as { chrome: unknown }).chrome = { storage: { local: {
    get: async (k: string) => (k in stored ? { [k]: JSON.parse(JSON.stringify(stored[k])) } : {}),
    set: async (o: Record<string, unknown>) => { Object.assign(stored, JSON.parse(JSON.stringify(o))); },
    remove: async (keys: string[]) => { for (const k of keys) delete stored[k]; },
  } } };
});

describe('the request as the server gets it', () => {
  it('the meaning on the card and the analysis (the cheap model, Haiku): "thinking": {"type": "disabled"} is in the request', async () => {
    const r = await runCompletion({ system: 'Give the Chinese meaning.', user: 'meticulous', maxTokens: 60 }, new AbortController().signal);
    expect(r.text).toBe('Very careful.');
    expect(seen).toHaveLength(1);
    expect(seen[0].body.model).toBe('claude-haiku-5-5');
    expect(seen[0].body.thinking).toEqual({ type: 'disabled' });
    expect(seen[0].body.output_config).toEqual({ effort: 'low' });
    expect(seen[0].body.stream).toBe(true);
    // (no 1000 tokens for thinking on top of the job's own limit)
    expect(seen[0].body.max_tokens).toBeLessThan(2000);
    const a = await runCompletion({ system: 'Find the phrases.', user: 'text', maxTokens: 3000 }, new AbortController().signal, undefined, true);
    expect(a.text).toBe('Very careful.');
    expect(seen[1].body.thinking).toEqual({ type: 'disabled' });
    expect(seen[1].body.max_tokens).toBeLessThanOrEqual(3300);
  });
  it('a learner who chose Sonnet 5.5 for these jobs: no "thinking" field at all (it would be refused)', async () => {
    stored.drSettings = { ai: { hintsModel: 'claude-sonnet-5-5' } };
    await runCompletion({ system: 'Give the Chinese meaning.', user: 'meticulous', maxTokens: 60 }, new AbortController().signal);
    expect(seen[0].body.model).toBe('claude-sonnet-5-5');
    expect('thinking' in seen[0].body).toBe(false);
    expect(seen[0].body.max_tokens).toBe(2500);
  });
  const passage = (more: Partial<RuleRequest> & { seconds?: number }): RuleRequest => ({
    kind: 'passage', target: 'It was a dark night. She ran for $5 and a dream.', sentence: 'It was a dark night. She ran for $5 and a dream.', before: '', after: '',
    book: { title: 'A Small Book', chapter: 'One' }, history: [], levelCheap: true, ...more,
  } as RuleRequest);
  it('I Know Book, "explain what I just read" (fromBook): Haiku with thinking off, and the words are a book\'s', async () => {
    const out: string[] = [];
    const r = await runExplain(passage({ fromBook: true, seconds: 20 }), new AbortController().signal, (t) => out.push(t));
    expect(r.text).toBe('Very careful.');
    expect(out.join('')).toBe('Very careful.');
    const b = seen[0].body;
    expect(b.model).toBe('claude-haiku-5-5');
    expect(b.thinking).toEqual({ type: 'disabled' });
    const user = b.messages[0].content, system = b.system[0].text;
    expect(user).toContain('the part of the book the learner just read / heard');
    expect(user).toContain('about 20 seconds');
    expect(user).toContain('It was a dark night. She ran for $5 and a dream.');
    expect(user).not.toMatch(/video/i);
    expect(user).not.toMatch(/\{\{(part|seconds)\}\}/);
    // the rules that are always there: the book's words too, nothing "from the video itself"
    expect(system).toContain('say the original words from the book exactly as they are');
    expect(system).not.toMatch(/from the video/i);
  });
  it('the YouTube tutor\'s request is as it was: the paused video, the sentences heard from the video itself', async () => {
    await runExplain(passage({}), new AbortController().signal, () => undefined);
    const user = seen[0].body.messages[0].content, system = seen[0].body.system[0].text;
    expect(user).toContain('The learner just paused the video.');
    expect(user).toContain('(the learner hears it from the video itself)');
    expect(user).toContain('about 30 seconds');
    expect(system).toContain('the learner then hears it from the video itself');
  });
});

describe('the part prompt: a video or a book', () => {
  it('fromBook: the book\'s wording; the same steps as the video\'s prompt', () => {
    const p = partPromptFor({ target: 'One. Two.', seconds: 10, fromBook: true }, PART_PROMPT);
    expect(p.startsWith('The learner is reading a book, or listening to it read aloud, and asked for help. This is the part of the book the learner just read / heard, in complete sentences (about 10 seconds):\nOne. Two.\n')).toBe(true);
    expect(p).not.toMatch(/video|paused/i);
    expect(p).not.toMatch(/hears it from/i);
    expect(p).toContain('{{level}}'); // (filled in later, with the learner's level, like the video's)
    for (const step of ['Then go through it sentence by sentence, in order.', 'Then break it down:', 'Never use headings, titles, numbers, lists or labels']) {
      expect(BOOK_PART_PROMPT).toContain(step);
      expect(PART_PROMPT).toContain(step);
    }
  });
  it('without the flag (or with anything but true): the video\'s prompt, word for word', () => {
    const want = PART_PROMPT.replace('{{part}}', 'One. Two.').replace('{{seconds}}', '30');
    expect(partPromptFor({ target: 'One. Two.' }, PART_PROMPT)).toBe(want);
    expect(partPromptFor({ target: 'One. Two.', fromBook: false }, PART_PROMPT)).toBe(want);
    expect(partPromptFor({ target: 'One. Two.', fromBook: 'yes' as unknown as boolean }, PART_PROMPT)).toBe(want);
  });
  it('a "$" in the book\'s text stays as it is', () => {
    expect(partPromptFor({ target: 'It cost $& and $1.', fromBook: true }, PART_PROMPT)).toContain('\nIt cost $& and $1.\n');
  });
  it('the always rules of a book say nothing of a video; the video\'s are untouched', () => {
    expect(BOOK_ALWAYS_RULES).not.toMatch(/video/i);
    expect(BOOK_ALWAYS_RULES).toContain('Work out from this part of the book what they meant.');
    expect(ALWAYS_RULES).toContain('from the video itself');
  });
});
