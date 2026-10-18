import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const userData = vi.hoisted(() => { const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); return fs.mkdtempSync(path.join(os.tmpdir(), 'readalong-ai-test-')); });
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, BrowserWindow: class {}, safeStorage: { isEncryptionAvailable: () => false }, app: { getPath: () => userData } }));
import { estimateUsd, classifyError, periodStarts } from '../../src/main/ai';

describe('AI main helpers', () => {
  it('prices models by prefix and charges cached tokens at the cache rate', () => {
    expect(estimateUsd('claude-opus-5-5-20260601', 1_000_000, 0, 0)).toBeCloseTo(4);
    expect(estimateUsd('claude-opus-5-5', 1_000_000, 0, 1_000_000)).toBeCloseTo(0.2);
    expect(estimateUsd('gpt-5-mini-2026-01-01', 0, 1_000_000, 0)).toBeCloseTo(2);
  });
  it('classifies provider errors the learner can act on', () => {
    expect(classifyError(Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' })).code).toBe('cancelled');
    expect(classifyError({ status: 400, message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.' }).code).toBe('spend_limit');
    expect(classifyError({ status: 429, message: 'You exceeded your current quota, please check your plan and billing details.' }).code).toBe('spend_limit');
    expect(classifyError({ status: 529, message: 'Overloaded' }).code).toBe('rate_limit');
    expect(classifyError({ status: 401, message: 'invalid x-api-key' }).code).toBe('auth');
    expect(classifyError(new TypeError('fetch failed')).code).toBe('network');
  });
  it('measures the daily and monthly budget from local midnight', () => {
    const { day, month } = periodStarts();
    const d = new Date(day), m = new Date(month), now = new Date();
    expect([d.getHours(), d.getMinutes(), d.getDate(), d.getMonth()]).toEqual([0, 0, now.getDate(), now.getMonth()]);
    expect([m.getHours(), m.getDate(), m.getMonth()]).toEqual([0, 1, now.getMonth()]);
    expect(day <= now.toISOString()).toBe(true);
    expect(fs.existsSync(userData) || os.platform() === 'win32' || path.isAbsolute(userData)).toBe(true);
  });
});
