import { net, protocol } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const APP_SCHEME = 'app';

/** Must run before app.whenReady(). Serves dist/renderer as app://-/ with a secure, fetch-capable origin. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  ]);
}

/** Must run after app.whenReady(). */
export function installAppProtocol(rendererDir: string): void {
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const target = path.normalize(path.join(rendererDir, rel));
    if (!target.startsWith(rendererDir)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(target).toString());
  });
}
