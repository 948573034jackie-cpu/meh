import React from 'react';
import { useApp } from '../state/store';

// Placeholder; the full settings UI is implemented in the settings step.
export function SettingsView(): JSX.Element {
  const settings = useApp((s) => s.settings);
  return (
    <div className="library" data-testid="settings">
      <h1>Settings</h1>
      <p className="muted">Level: {settings.learnerLevel} · Theme: {settings.appearance.theme}</p>
      <button className="primary" onClick={() => useApp.getState().patchSettings({ onboarded: true }).then(() => useApp.getState().setView('library'))} data-testid="finish-onboarding">Continue</button>
    </div>
  );
}
