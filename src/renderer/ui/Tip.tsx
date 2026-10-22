import React from 'react';

/**
 * A quiet tooltip for the main buttons: "tap anything to see how it works". Wraps its child and shows `text`
 * on hover or keyboard focus. Hidden app-wide when Settings → Reading look → Tips is off (html[data-tips="0"],
 * set by applyAppearance from appearance.showTips). Memoized: a tip around a static child is not rendered again with
 * the reader.
 */
export const Tip = React.memo(function Tip({ text, children, below, wrap, align }: { text: string; children: React.ReactNode; below?: boolean; wrap?: boolean; /** keep the tip inside the window near an edge: 'start' hangs right from the button, 'end' hangs left */ align?: 'start' | 'end' }): JSX.Element {
  return (
    <span className="tip-wrap">
      {children}
      <span className={`tip${below ? ' below' : ''}${wrap ? ' wrap' : ''}${align ? ` ${align}` : ''}`} role="tooltip">{text}</span>
    </span>
  );
});
