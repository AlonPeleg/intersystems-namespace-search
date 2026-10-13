// One IRIS login per server, reused: the session cookies the server sends back on the first request are kept and sent
// instead of the username and password on the next requests (the way the InterSystems ObjectScript extension does it).
// When the server no longer knows the session (it timed out, or was ended) it answers 401: the cookies are dropped and
// that request is sent once more with the username and password, which starts a new session.
//
// Used by the server-side search and by Open Document's direct listing. Requests that go through the isfs folders
// already use the InterSystems extension's own session. Kept in memory only: a VS Code restart logs in again.

import type { IncomingHttpHeaders } from 'http';

const jars = new Map<string, Map<string, string>>();          // server + login -> cookie name -> value
let logFn: ((line: string) => void) | undefined;

export function setSessionLog(fn: (line: string) => void) { logFn = fn; }

/** Which jar a request belongs to: the server's address and the exact login (a changed password is a new jar). */
export function sessionKey(baseUrl: string, authHeader: string | undefined): string {
    let origin = baseUrl;
    try {
        const u = new URL(baseUrl);
        const i = u.pathname.toLowerCase().indexOf('/api/atelier');
        origin = `${u.protocol}//${u.host}${i >= 0 ? u.pathname.slice(0, i) : ''}`;
    } catch { /* not a URL: use it as given */ }
    return `${origin}|${authHeader ?? ''}`;
}

/** Headers that identify the request: the session cookies when there is a session, else the username and password. */
export function authHeaders(key: string, authHeader: string | undefined): { headers: Record<string, string>; usedSession: boolean } {
    const jar = jars.get(key);
    if (jar && jar.size > 0) {
        return { headers: { Cookie: [...jar].map(([n, v]) => `${n}=${v}`).join('; ') }, usedSession: true };
    }
    return { headers: authHeader ? { Authorization: authHeader } : {}, usedSession: false };
}

/** Keeps the cookies a response set (name=value only; attributes such as Path and expiry are not needed here). */
export function rememberCookies(key: string, headers: IncomingHttpHeaders, usedSession: boolean) {
    const set = headers['set-cookie'];
    if (!set || set.length === 0) return;
    let jar = jars.get(key);
    const fresh = !jar || jar.size === 0;
    if (!jar) { jar = new Map(); jars.set(key, jar); }
    for (const line of set) {
        const first = line.split(';')[0];
        const eq = first.indexOf('=');
        if (eq <= 0) continue;
        const name = first.slice(0, eq).trim();
        const value = first.slice(eq + 1).trim();
        if (value === '' || /expires=thu, 01 jan 1970/i.test(line) || /max-age=0\b/i.test(line)) jar.delete(name);
        else jar.set(name, value);
    }
    if (fresh && !usedSession && jar.size > 0) logFn?.(`  Logged in to ${key.split('|')[0]}; the session is reused for the next requests.`);
}

/** Drops a server's session (it was rejected, or the password changed). */
export function forgetSession(key: string) {
    if (jars.delete(key)) logFn?.(`  Session for ${key.split('|')[0]} ended; logging in again.`);
}

/** Drops every session (after a stored password is added or removed). */
export function forgetAllSessions() { jars.clear(); }
