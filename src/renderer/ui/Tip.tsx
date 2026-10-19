import React from 'react';

/**
 * A quiet tooltip for the main buttons: "tap anything to see how it works". Wraps its child and shows `text`
 * on hover or keyboard focus. Hidden app-wide when Settings → Reading look → Tips is off (html[data-tips="0"],
 * set by applyAppearance from appearance.showTips).
 */
export function Tip({ text, children, below, wrap }: { text: string; children: React.ReactNode; below?: boolean; wrap?: boolean }): JSX.Element {
  return (
    <span className="tip-wrap">
      {children}
      <span className={`tip${below ? ' below' : ''}${wrap ? ' wrap' : ''}`} role="tooltip">{text}</span>
    </span>
  );
}
