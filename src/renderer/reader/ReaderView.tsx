import React from 'react';
import type { Book } from '@core/model';

// Placeholder until the reader is implemented: renders plain paragraphs.
export function ReaderView({ book }: { book: Book }): JSX.Element {
  return (
    <div className="library" data-testid="reader">
      {book.chapters.map((ch) => (
        <div key={ch.index}>
          <h2>{ch.title}</h2>
          {ch.paragraphs.map((p) => <p key={p.index}>{p.text}</p>)}
        </div>
      ))}
    </div>
  );
}
