/** My Vocabulary page (dream/vocab.html): every word the tutor explained, CSV download, progress per CEFR level.
 *  The page itself is vocab-view.ts (I Know Book shows the same part in its Words tab). In the iPhone app this page
 *  is I Know's Words tab: its "Settings" link opens the Settings tab (in Chrome it opens options.html, as before). */
import { mountVocab } from './vocab-view';
import { inApp, appPost } from './native-bridge';

mountVocab(document.querySelector('main') as HTMLElement, inApp() ? { onSettings: () => void appPost({ kind: 'showTab', tab: 'settings' }) } : {});
