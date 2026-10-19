import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_SETTINGS, migrateSettings, isDarkTheme } from '@shared/settings';
import type { Settings } from '@shared/settings';
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/dream-read-settings-test' }, safeStorage: { isEncryptionAvailable: () => false } }));
import { deepMerge } from '../../src/main/settings';

/** A settings.json written by the first version (ReadAlong): no Dream Read fields, theme 'dark'. */
const STORED_V1 = {
  version: 1, onboarded: true, learnerLevel: 'C1', nativeLanguage: 'zh',
  ai: { provider: 'openai', anthropicModel: 'claude-opus-5-5', openaiModel: 'gpt-5.4-mini', instructions: 'Be brief.', explanationLength: 'short', speakChinese: false, dailyWarnUsd: 2, monthlyStopUsd: 20 },
  voice: { engine: 'webspeech', voiceId: 'Daniel', explainEngine: null, explainVoiceId: null, rate: 1.2, pauseBetweenSentencesMs: 300 },
  listen: { autoExplainWords: true, autoExplainPhrases: false, firstOccurrencePerChapterOnly: true, maxStopsPer10Min: 5, wordRepeats: 2, sentenceRepeatsAfterWord: 1, sentenceRepeatsForPhrase: 2, lastSecondsWindow: 40, tapHighlightCancels: false },
  appearance: {
    theme: 'dark', layout: 'scroll', fontFamily: 'sans', fontSizePx: 24, lineHeight: 1.8, marginPx: 64, bandEnabled: false, bandHeightPct: 25,
    highlightsDark: { unknown: '#111111', learning: '#222222', sentence: '#333333', word: '#444444', marked: '#555555' },
    highlightsLight: { unknown: '#aaaaaa', learning: '#bbbbbb', sentence: '#cccccc', word: '#dddddd', marked: '#eeeeee' },
    underlineOnly: true,
  },
  shortcuts: { playPause: 'KeyP' },
};

function load(stored: object): Settings {
  // same steps as getSettings() in src/main/settings.ts
  return migrateSettings(deepMerge(structuredClone(DEFAULT_SETTINGS), migrateSettings(structuredClone(stored) as never)));
}

describe('settings merge and migration', () => {
  it('fills in every Dream Read appearance field for a v1 settings file and keeps the learner\'s values', () => {
    const s = load(STORED_V1);
    expect(s.appearance.subtitleSizePx).toBe(DEFAULT_SETTINGS.appearance.subtitleSizePx);
    expect(s.appearance.explainSizePx).toBe(DEFAULT_SETTINGS.appearance.explainSizePx);
    expect(s.appearance.uiScale).toBe(1);
    expect(s.appearance.maxLineChars).toBe(70);
    expect(s.appearance.listenMaxLineChars).toBe(90);
    expect(s.appearance.showTips).toBe(true);
    // the learner's own values survive
    expect(s.appearance.fontSizePx).toBe(24);
    expect(s.appearance.lineHeight).toBe(1.8);
    expect(s.appearance.layout).toBe('scroll');
    expect(s.appearance.underlineOnly).toBe(true);
    expect(s.appearance.highlightsDark.unknown).toBe('#111111');
    expect(s.learnerLevel).toBe('C1');
    expect(s.ai.provider).toBe('openai');
    expect(s.listen.lastSecondsWindow).toBe(40);
    // nested objects merge, so shortcuts that were not stored keep their defaults
    expect(s.shortcuts.playPause).toBe('KeyP');
    expect(s.shortcuts.nextSentence).toBe('ArrowRight');
    // fields other versions added are present too
    expect(s.ai.activeStyle).toBe(DEFAULT_SETTINGS.ai.activeStyle);
    expect(s.listen.pauseAfterExplainMs).toBe(DEFAULT_SETTINGS.listen.pauseAfterExplainMs);
  });
  it('reads the old theme "dark" as "night" and leaves the other ids alone', () => {
    expect(load(STORED_V1).appearance.theme).toBe('night');
    for (const theme of ['night', 'sepia', 'light', 'grey', 'system'] as const) expect(load({ appearance: { theme } }).appearance.theme).toBe(theme);
    expect(migrateSettings({ appearance: { theme: 'dark' } }).appearance.theme).toBe('night');
    expect(migrateSettings({} as { appearance?: { theme?: string } }).appearance).toBeUndefined();
  });
  it('every new field round-trips through a settings:set style patch', () => {
    const base = load(STORED_V1);
    const patch: Partial<Settings> = { appearance: { ...base.appearance, theme: 'grey', subtitleSizePx: 28, explainSizePx: 17, uiScale: 1.2, maxLineChars: 60, listenMaxLineChars: 110, showTips: false } };
    const next = migrateSettings(deepMerge(base, migrateSettings(patch)));
    expect(next.appearance).toMatchObject({ theme: 'grey', subtitleSizePx: 28, explainSizePx: 17, uiScale: 1.2, maxLineChars: 60, listenMaxLineChars: 110, showTips: false });
    // a JSON round-trip (what the store writes and reads) keeps them
    const again = load(JSON.parse(JSON.stringify(next)));
    expect(again.appearance).toEqual(next.appearance);
  });
  it('DEFAULT_SETTINGS use night and the dark highlight palette applies to night and grey only', () => {
    expect(DEFAULT_SETTINGS.appearance.theme).toBe('night');
    expect(isDarkTheme('night')).toBe(true);
    expect(isDarkTheme('grey')).toBe(true);
    expect(isDarkTheme('sepia')).toBe(false);
    expect(isDarkTheme('light')).toBe(false);
  });
});
