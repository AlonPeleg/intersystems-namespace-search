import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { registerGoTo } from './goto';
import { registerDocPicker } from './docPicker';

interface MatchResult {
    fileName: string;
    line: number;
    column: number;
    lineText: string;
    uri: string;
}

// Defaults used when the corresponding setting (see package.json) is unset.
// Every one of these fs calls is a network round-trip to the IRIS server via
// ISFS, so concurrency and pause mostly trade search speed against load
// placed on that server - raise them if your server can take it, lower them
// if searches start erroring out under load.
const DEFAULT_DIR_CONCURRENCY = 6;
const DEFAULT_FILE_CONCURRENCY = 8;
const DEFAULT_PAUSE_BETWEEN_READS_MS = 0;

interface SearchTuning {
    dirConcurrency: number;
    fileConcurrency: number;
    pauseBetweenReadsMs: number;
}

function getSearchTuning(): SearchTuning {
    const cfg = vscode.workspace.getConfiguration('isfsNamespaceSearch');
    const clampInt = (value: unknown, fallback: number, min: number) => {
        const n = typeof value === 'number' ? Math.floor(value) : NaN;
        return Number.isFinite(n) && n >= min ? n : fallback;
    };
    return {
        dirConcurrency: clampInt(cfg.get('dirConcurrency'), DEFAULT_DIR_CONCURRENCY, 1),
        fileConcurrency: clampInt(cfg.get('fileConcurrency'), DEFAULT_FILE_CONCURRENCY, 1),
        pauseBetweenReadsMs: clampInt(cfg.get('pauseBetweenReadsMs'), DEFAULT_PAUSE_BETWEEN_READS_MS, 0)
    };
}

// Dedupes concurrent/duplicate directory listings for the same folder within
// a single search run - e.g. when two file masks resolve into overlapping
// package subtrees, each folder gets listed once instead of once per mask.
type DirCache = Map<string, Promise<[string, vscode.FileType][]>>;

async function readDirCached(
    cache: DirCache,
    uri: vscode.Uri,
    pauseMs: number,
    _token: vscode.CancellationToken
): Promise<[string, vscode.FileType][]> {
    const key = uri.toString();
    let pending = cache.get(key);
    if (!pending) {
        pending = (async () => {
            if (pauseMs > 0) await sleep(pauseMs);
            return vscode.workspace.fs.readDirectory(uri);
        })();
        cache.set(key, pending);
    }
    try {
        return await pending;
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// Server-side search (Atelier "action/search")
//
// Studio's Find in Files is fast because it runs entirely inside the IRIS
// process, iterating the class/routine storage where it already lives - no
// per-file network fetch. That same server-side search is reachable remotely
// via the Atelier REST API (IRIS/Cache 2017.2+): a single
//   GET /api/atelier/v2/{namespace}/action/search?query=...&documents=...
// does the whole namespace-wide search in one round trip and hands back
// matches as JSON, instead of this extension listing every folder and
// downloading every candidate file to grep locally (see
// executeThrottledSearch's fallback path below, which is what runs when any
// part of this isn't available).
//
// vscode.workspace.fs has no hook for a custom server action like this, so
// it's called directly over HTTP here, reusing the connection the user
// already established by opening the namespace via the InterSystems
// extension's "Edit in Namespace" - not a separate, newly-entered one.
// ---------------------------------------------------------------------------

// A visible log of every step of the server-side search attempt (connection
// resolution, the request made, the response shape received) - the fallback
// to the local scan is otherwise silent from the user's side, since its own
// "Resolving target paths..." status message overwrites the one line of
// status text almost immediately. Open it from View -> Output, then pick
// "ISFS Namespace Search" from the dropdown in the top-right of that panel.
let output: vscode.OutputChannel | undefined;
function log(message: string) {
    output?.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

interface ServerConnectionInfo {
    scheme: 'http' | 'https';
    host: string;
    port: number;
    pathPrefix: string;
    ns: string;
    authHeader: string;
}

// Resolved connections are cached per namespace folder for the life of the
// extension host, since re-resolving on every keystroke/search would add
// back exactly the kind of overhead this whole feature exists to remove.
// Cleared whenever the InterSystems extension reports the underlying
// connection changed (see activate()).
const connectionCache = new Map<string, ServerConnectionInfo | undefined>();

// isfs(-readonly) workspace folders are addressed as isfs://<serverName>:<namespace>/...
function parseIsfsAuthority(uri: vscode.Uri): { serverName: string; ns: string } | undefined {
    const authority = uri.authority || '';
    const sep = authority.indexOf(':');
    if (sep <= 0) return undefined;
    const serverName = decodeURIComponent(authority.substring(0, sep));
    const ns = decodeURIComponent(authority.substring(sep + 1));
    if (!serverName || !ns) return undefined;
    return { serverName, ns };
}

async function activateExtensionExports(extensionId: string): Promise<any | undefined> {
    const ext = vscode.extensions.getExtension(extensionId);
    if (!ext) return undefined;
    try {
        return ext.isActive ? ext.exports : await ext.activate();
    } catch {
        return undefined;
    }
}

// Reuses the InterSystems ObjectScript extension's already-authenticated
// connection for this namespace folder (via its exported serverForUri/
// asyncServerForUri API) for both the network address and credentials -
// rather than asking the user to configure a server connection a second
// time for this extension. Returns undefined for anything this can't
// resolve (extension missing, connection not yet established, unexpected
// API shape, ...); callers treat that as "fall back to the local
// file-by-file scan," never as a hard error.
async function resolveServerConnectionUncached(folderUri: vscode.Uri): Promise<ServerConnectionInfo | undefined> {
    log(`Resolving server connection for folder "${folderUri.toString()}" (authority="${folderUri.authority}")`);

    const objectScriptApi = await activateExtensionExports('intersystems-community.vscode-objectscript');
    if (!objectScriptApi) {
        log(`  FAILED: intersystems-community.vscode-objectscript extension not found or failed to activate.`);
        return undefined;
    }

    let serverForUri: any;
    try {
        serverForUri = objectScriptApi.asyncServerForUri
            ? await objectScriptApi.asyncServerForUri(folderUri)
            : objectScriptApi.serverForUri?.(folderUri);
    } catch (e: any) {
        log(`  FAILED: serverForUri/asyncServerForUri threw: ${e?.message || e}`);
        return undefined;
    }
    if (!serverForUri) {
        log(`  FAILED: serverForUri/asyncServerForUri returned nothing for this folder.`);
        return undefined;
    }
    // Confirmed shape (from real-world logging): this installed version of
    // vscode-objectscript flattens scheme/host/port/pathPrefix/namespace and
    // username/password directly onto the result - no nested "auth" object,
    // no separate Server Manager lookup needed to get the network address.
    log(`  serverForUri keys: [${Object.keys(serverForUri).join(', ')}] serverName="${serverForUri.serverName}" active=${serverForUri.active} scheme=${serverForUri.scheme} host=${serverForUri.host} port=${serverForUri.port} namespace=${serverForUri.namespace} apiVersion=${serverForUri.apiVersion} hasUsername=${!!serverForUri.username} hasPassword=${!!serverForUri.password}`);

    if (!serverForUri.host || !serverForUri.port) {
        log(`  FAILED: no usable host/port on the resolved connection.`);
        return undefined;
    }

    const ns: string | undefined = serverForUri.namespace || parseIsfsAuthority(folderUri)?.ns;
    if (!ns) {
        log(`  FAILED: could not determine the namespace (neither serverForUri.namespace nor the folder's authority had it).`);
        return undefined;
    }

    // Confirmed against three real servers side-by-side, same query/mask,
    // same underlying files: a server reporting apiVersion=8 (modern IRIS)
    // returned all 4 matching files, while two independent servers both
    // reporting apiVersion=3 returned only 1 file and 0 files respectively -
    // silently, with a clean HTTP 200 and no error. That means action/search
    // on at least that older Atelier API version can't be trusted to find
    // every match, and there's no way to distinguish "genuinely 0/partial
    // matches" from "this server version under-reports" from the response
    // alone. So below a configurable minimum apiVersion, skip server-side
    // search for that connection entirely and let it fall back to the local
    // scan, which reads every file directly and isn't subject to this gap.
    const minApiVersion = vscode.workspace.getConfiguration('isfsNamespaceSearch').get<number>('serverSideSearchMinApiVersion', 4);
    if (typeof serverForUri.apiVersion === 'number' && serverForUri.apiVersion < minApiVersion) {
        log(`  FAILED: server reports Atelier apiVersion=${serverForUri.apiVersion}, below the configured minimum of ${minApiVersion} (isfsNamespaceSearch.serverSideSearchMinApiVersion). Older Atelier search implementations have been observed to silently omit documents that do contain the searched text. Falling back to the local scan for this server so results stay correct. Lower this setting only if you've specifically confirmed server-side search is reliable on this server version.`);
        return undefined;
    }

    let authHeader: string | undefined;
    if (serverForUri.username && serverForUri.password) {
        authHeader = 'Basic ' + Buffer.from(`${serverForUri.username}:${serverForUri.password}`).toString('base64');
        log(`  Built Basic auth header from username/password on the resolved connection.`);
    } else if (serverForUri.auth?.httpAuthorizationHeader) {
        // Some vscode-objectscript versions nest credentials under `auth`
        // instead - keep this as a fallback for those.
        authHeader = serverForUri.auth.httpAuthorizationHeader;
        log(`  Used auth.httpAuthorizationHeader from the resolved connection.`);
    }

    if (!authHeader) {
        log(`  FAILED: no username/password (or auth.httpAuthorizationHeader) on the resolved connection.`);
        return undefined;
    }

    let pathPrefix: string = serverForUri.pathPrefix || '';
    if (pathPrefix.length && !pathPrefix.startsWith('/')) pathPrefix = '/' + pathPrefix;

    log(`  RESOLVED: ${serverForUri.scheme || 'https'}://${serverForUri.host}:${serverForUri.port}${pathPrefix} ns=${ns}`);

    return {
        scheme: serverForUri.scheme === 'http' ? 'http' : 'https',
        host: serverForUri.host,
        port: serverForUri.port,
        pathPrefix,
        ns,
        authHeader
    };
}

async function resolveServerConnection(folderUri: vscode.Uri): Promise<ServerConnectionInfo | undefined> {
    const key = folderUri.toString();
    if (connectionCache.has(key)) return connectionCache.get(key);
    const resolved = await resolveServerConnectionUncached(folderUri);
    connectionCache.set(key, resolved);
    return resolved;
}

// Shared by both search paths so a query behaves identically whether it's
// answered by the server or by the local fallback scan.
function buildQueryRegexSource(query: string, useWildcards: boolean): string {
    return useWildcards
        ? query
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.')
        : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The Atelier search result gives a document's dotted server-side name
// (e.g. "Tafnit.App.Portfolio.Offer.cls") rather than a file path; ISFS maps
// package structure to folder structure, so everything but the final
// extension becomes a path segment.
function docNameToRelativePath(docName: string): string {
    const lastDot = docName.lastIndexOf('.');
    if (lastDot <= 0) return docName;
    const ext = docName.substring(lastDot);
    const namePart = docName.substring(0, lastDot);
    return namePart.replace(/\./g, '/') + ext;
}

function escapeRegExpLiteral(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Confirmed against a real response: a match came back as
// {"member":"checkCustomers","line":23,...}, and the server's own "console"
// log for that exact same search read
// "Tafnit.App.VirtualMortgage.utils.cls(checkCustomers+23): ...". That's
// standard M label+offset notation - "line" is an offset from the START OF
// THE MEMBER (method/query/trigger/XData block in a .cls, or a label in a
// .mac/.int), not an absolute line number from the top of the file. To
// recover the real source line, find where that member/label is declared in
// the document's own text and add the offset to it.
function findMemberDeclarationLineIndex(sourceLines: string[], member: string, isRoutineFile: boolean): number | null {
    if (!member) return null;
    const escaped = escapeRegExpLiteral(member);

    if (isRoutineFile) {
        // .mac/.int: a label starts in column 1 (no leading whitespace),
        // followed by an argument list, whitespace, a comment, or end of line.
        const labelRegex = new RegExp(`^${escaped}(?:\\(|\\s|;|$)`);
        for (let i = 0; i < sourceLines.length; i++) {
            if (labelRegex.test(sourceLines[i])) return i;
        }
        return null;
    }

    // .cls: the member is declared as "<Keyword> <Name>..." where Keyword is
    // one of UDL's member types. Case-insensitive on the keyword, exact case
    // on the member name (ObjectScript identifiers are case-sensitive).
    const memberRegex = new RegExp(
        `^\\s*(ClassMethod|ClientMethod|Method|Parameter|Property|Query|Relationship|XData|Trigger|Index|ForeignKey|Storage|Projection)\\s+${escaped}\\b`,
        'i'
    );
    for (let i = 0; i < sourceLines.length; i++) {
        if (memberRegex.test(sourceLines[i])) return i;
    }
    return null;
}

function httpGetJson(
    urlString: string,
    headers: Record<string, string>,
    allowSelfSigned: boolean,
    token: vscode.CancellationToken
): Promise<any> {
    return new Promise((resolve, reject) => {
        let settled = false;
        let parsedUrl: URL;
        try {
            parsedUrl = new URL(urlString);
        } catch (e: any) {
            reject(e);
            return;
        }

        const lib = parsedUrl.protocol === 'http:' ? http : https;
        const options: any = { headers };
        if (lib === https && allowSelfSigned) options.rejectUnauthorized = false;

        const req = lib.get(parsedUrl, options, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(chunk as Buffer));
            res.on('end', () => {
                if (settled) return;
                settled = true;
                const body = Buffer.concat(chunks).toString('utf8');
                const status = res.statusCode || 0;
                log(`  HTTP ${status} response, ${body.length} bytes.`);
                if (status < 200 || status >= 300) {
                    log(`  Response body (truncated): ${body.slice(0, 500)}`);
                    reject(new Error(`HTTP ${status}: ${body.slice(0, 300)}`));
                    return;
                }
                try {
                    resolve(body ? JSON.parse(body) : {});
                } catch (e: any) {
                    log(`  Body wasn't valid JSON (truncated): ${body.slice(0, 500)}`);
                    reject(new Error(`Invalid JSON response: ${e.message}`));
                }
            });
        });

        req.on('error', (err) => {
            if (settled) return;
            settled = true;
            log(`  Request error: ${err.message}`);
            reject(err);
        });

        const cancelListener = token.onCancellationRequested(() => {
            if (settled) return;
            settled = true;
            req.destroy();
            reject(new Error('Search cancelled'));
        });
        req.on('close', () => cancelListener.dispose());
    });
}

interface ServerSearchGroup {
    fileName: string;
    uri: vscode.Uri;
    matches: MatchResult[];
}

// Runs the whole namespace search as one HTTP request. `masks` are passed
// straight through as the API's "documents" mask list (the same comma-
// separated, wildcarded, dot-package syntax already typed into the File
// Mask / Package field - Atelier understands it natively, so there's no
// client-side path-resolution step to do here at all).
async function runServerSideSearch(
    rootFolderUri: vscode.Uri,
    connection: ServerConnectionInfo,
    masks: string[],
    query: string,
    useWildcards: boolean,
    max: number,
    allowSelfSigned: boolean,
    token: vscode.CancellationToken
): Promise<ServerSearchGroup[]> {
    const documents = masks.map(m => m.trim()).filter(Boolean).join(',');
    if (!documents) return [];

    // Only actually translate to a regex when the query has wildcard
    // characters to translate - same intent as this extension's "Use
    // wildcards" checkbox. A plain query like "$zaccessor.Offer.getByList"
    // goes to the server as a literal (regex=0) search, the same way Studio's
    // own Find in Files runs a query with no wildcards typed into it: as a
    // plain substring match, not a regex. This sidesteps guessing at this
    // server's regex-engine syntax (an earlier attempt prepended "(?i)" for
    // case-insensitivity, which this engine evidently doesn't support - it
    // came back with a clean, empty result instead of an error) for the
    // common case of searching for an exact name.
    const patternSource = buildQueryRegexSource(query, useWildcards);
    const hasWildcardChars = /[*?]/.test(query);
    const sendAsRegex = useWildcards && hasWildcardChars;
    // A confirmed real-world case: a literal (regex=0) search for
    // "$zaccessor.Offer.getByList" found it fine as a substring of a longer
    // line, but the equivalent regex "\$zaccessor\..*\.getByList" (regex=1)
    // found nothing across a broader scope that provably contains that exact
    // text - meaning this server's regex mode matches the WHOLE line, not a
    // substring within it. Wrapping with .* on both ends restores "contains"
    // behavior regardless of which style a given server uses (harmless if a
    // server already does substring matching, since .*pattern.* still
    // matches everywhere pattern alone would).
    const serverRegexQuery = `.*${patternSource}.*`;

    log(`  Query mode: ${sendAsRegex ? 'regex' : 'literal'} (useWildcards=${useWildcards}, query has * or ? = ${hasWildcardChars})`);

    const params = new URLSearchParams({
        query: sendAsRegex ? serverRegexQuery : query,
        documents,
        regex: sendAsRegex ? '1' : '0',
        sys: '0',
        // Studio's Find in Files (and this extension's own local-scan
        // fallback, which never filtered by document type at all) includes
        // generated documents like the .int a routine's .mac compiles to -
        // excluding them here was silently dropping half of every routine's
        // hits.
        gen: '1',
        max: String(max)
    });

    const url = `${connection.scheme}://${connection.host}:${connection.port}${connection.pathPrefix}/api/atelier/v2/${encodeURIComponent(connection.ns)}/action/search?${params.toString()}`;

    log(`Requesting: ${url}`);

    const json = await httpGetJson(url, { Authorization: connection.authHeader, Accept: 'application/json' }, allowSelfSigned, token);

    log(`Response top-level keys: [${Object.keys(json || {}).join(', ')}]`);

    const errors = json?.status?.errors;
    if (Array.isArray(errors) && errors.length) {
        const msg = errors.map((e: any) => e?.error || e?.message || String(e)).join('; ');
        log(`  Server reported error(s): ${msg}`);
        throw new Error(msg);
    }

    const rawResults: any[] = json?.result?.content ?? json?.result ?? [];
    if (!Array.isArray(rawResults)) {
        log(`  Unexpected shape - json.result: ${JSON.stringify(json?.result).slice(0, 500)}`);
        throw new Error('Unexpected response shape from action/search');
    }

    log(`  ${rawResults.length} raw document result(s) from server.`);
    if (rawResults.length > 0) {
        log(`  Sample document result keys: [${Object.keys(rawResults[0] || {}).join(', ')}] -> ${JSON.stringify(rawResults[0]).slice(0, 500)}`);
    }

    const groups: ServerSearchGroup[] = [];
    // Re-run the same pattern against just the handful of lines the server
    // already told us matched, purely to recover a column offset (and split
    // out every occurrence on a line) - the search API reports which lines
    // matched, not where on them. This is local string work over a few dozen
    // short strings, not a new round trip, so it doesn't reintroduce the cost
    // this feature is meant to remove.
    const lineRegex = new RegExp(patternSource, 'gi');

    for (const docResult of rawResults) {
        const docName: string | undefined = docResult?.doc ?? docResult?.document ?? docResult?.name;
        const rawMatches: any[] = docResult?.matches ?? docResult?.result ?? [];
        if (!docName || !Array.isArray(rawMatches) || rawMatches.length === 0) continue;

        const relativePath = docNameToRelativePath(docName);
        const fileUri = vscode.Uri.joinPath(rootFolderUri, relativePath);
        const fileName = relativePath.split('/').pop() || docName;

        // Only a match that's inside a named member/label needs the
        // label+offset correction above - fetch this document's own source
        // once (not per-match) and only when something here actually
        // requires it, so files with no member-tagged matches (or servers
        // that don't send "member" at all) never pay for an extra read.
        const needsMemberResolution = rawMatches.some((m: any) => typeof m?.member === 'string' && m.member);
        let sourceLines: string[] | null = null;
        if (needsMemberResolution) {
            try {
                const fileBytes = await vscode.workspace.fs.readFile(fileUri);
                sourceLines = new TextDecoder('utf-8').decode(fileBytes).split(/\r?\n/);
            } catch (e: any) {
                log(`  Could not read ${fileName} to resolve member-relative line numbers (${e.message}) - falling back to the server's raw line numbers for this file, which will be wrong for any match inside a method/label.`);
            }
        }
        const isRoutineFile = /\.(mac|int)$/i.test(fileName);
        const declLineCache = new Map<string, number | null>();

        const matches: MatchResult[] = [];
        for (const m of rawMatches) {
            const rawLine = m?.line ?? m?.linenumber ?? m?.lineNumber;
            const text: string = typeof m?.text === 'string' ? m.text : (typeof m?.content === 'string' ? m.content : '');
            // Confirmed from a real response: line numbers come back as a
            // string (e.g. "128"), not a number - the original strict
            // `typeof === 'number'` check silently dropped every match.
            const lineNum = typeof rawLine === 'number' ? rawLine : parseInt(String(rawLine ?? ''), 10);
            if (!Number.isFinite(lineNum)) continue;
            // The API's `line` is 0-based, matching this extension's own
            // 0-based Position handling elsewhere. When the match is tagged
            // with a member, `line` is relative to that member's own
            // declaration line (see findMemberDeclarationLineIndex) rather
            // than the top of the file, and needs that line added in.
            let lineIdx = lineNum;
            const member: string | undefined = typeof m?.member === 'string' ? m.member : undefined;
            if (member && sourceLines) {
                let declLineIdx: number | null;
                if (declLineCache.has(member)) {
                    declLineIdx = declLineCache.get(member)!;
                } else {
                    declLineIdx = findMemberDeclarationLineIndex(sourceLines, member, isRoutineFile);
                    declLineCache.set(member, declLineIdx);
                    if (declLineIdx === null) {
                        log(`  Could not locate declaration of member "${member}" in ${fileName} - using the server's raw line number as-is for this match, which is likely wrong if the match is actually inside that member.`);
                    }
                }
                if (declLineIdx !== null) {
                    // Confirmed against a real server response: counting
                    // exactly `lineNum` lines down from the "ClassMethod
                    // Name(...)" declaration line itself landed 1 line short
                    // of the true match, for more than one match in the same
                    // method. So for a .cls, the M label+offset anchor isn't
                    // the declaration line - it's one line after it (the
                    // opening "{", for the common case where it's on its own
                    // line). Routine files (.mac/.int) use a real M label,
                    // where offset 0 IS the label line itself, so they don't
                    // get this adjustment.
                    lineIdx = declLineIdx + lineNum + (isRoutineFile ? 0 : 1);
                }
            }

            lineRegex.lastIndex = 0;
            let foundOnLine = false;
            let exec: RegExpExecArray | null;
            while ((exec = lineRegex.exec(text)) !== null) {
                foundOnLine = true;
                matches.push({ fileName, line: lineIdx, column: exec.index, lineText: text.trim(), uri: fileUri.toString() });
                if (exec.index === lineRegex.lastIndex) lineRegex.lastIndex++;
            }
            if (!foundOnLine) {
                // Couldn't re-locate the match in the returned text (e.g. it
                // only held the matched fragment, not the whole line) - still
                // surface it rather than silently dropping a real match.
                matches.push({ fileName, line: lineIdx, column: 0, lineText: text.trim(), uri: fileUri.toString() });
            }
        }

        if (matches.length) groups.push({ fileName, uri: fileUri, matches });
    }

    // The server sent back document entries but none of them normalized into
    // a usable group - almost certainly means the field names guessed above
    // (doc/document/name, matches/result, line/text) don't match what this
    // particular server version actually returns, not that there are
    // genuinely zero matches. Treat that as a failure so the caller falls
    // back to the local scan instead of reporting a false "0 matches found."
    if (rawResults.length > 0 && groups.length === 0) {
        log(`  FAILED: got ${rawResults.length} document result(s) but none normalized into a usable group - field names above likely don't match this server's response shape.`);
        throw new Error('Response received but its shape was not recognized');
    }

    log(`  Normalized to ${groups.length} file group(s), ${groups.reduce((n, g) => n + g.matches.length, 0)} match(es) total.`);
    return groups;
}

export function activate(context: vscode.ExtensionContext) {
    output = vscode.window.createOutputChannel('ISFS Namespace Search');
    context.subscriptions.push(output);

    const provider = new ISFSSearchWebviewProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('isfsNamespaceSearchView', provider, {
            webviewOptions: {
                retainContextWhenHidden: true
            }
        })
    );

    // Studio-style Go To (Ctrl+Alt+G) - separate module, doesn't touch search.
    registerGoTo(context, log);

    // Open InterSystems Document with a Tree <-> Flat toggle - separate module.
    registerDocPicker(context, log);

    // The cached connection info (credentials included) is only valid until
    // the InterSystems extension's own connection state changes - e.g. the
    // user reconnects or edits server settings - so drop it then rather than
    // risk searching with stale credentials until the extension host restarts.
    activateExtensionExports('intersystems-community.vscode-objectscript').then((api) => {
        if (api?.onDidChangeConnection) {
            context.subscriptions.push(api.onDidChangeConnection(() => connectionCache.clear()));
        }
    });
}

export function deactivate() {}

interface NamespaceDescriptor {
    id: string;
    label: string;
}

function getIsfsWorkspaceFolders(): vscode.WorkspaceFolder[] {
    return (
        vscode.workspace.workspaceFolders?.filter(
            f => f.uri.scheme === 'isfs' || f.uri.scheme === 'isfs-readonly'
        ) ?? []
    );
}

function getIsfsNamespaces(): NamespaceDescriptor[] {
    return getIsfsWorkspaceFolders().map(f => ({ id: f.uri.toString(), label: f.name }));
}

class ISFSSearchWebviewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    // One search can now run per namespace tab at a time, so cancellation is
    // tracked per namespace instead of a single shared token.
    private _cancellationTokenSources = new Map<string, vscode.CancellationTokenSource>();

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        const workspaceFoldersListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
            this.postNamespaceList();
        });
        webviewView.onDidDispose(() => {
            workspaceFoldersListener.dispose();
            this.cancelAllSearches();
        });

        // Whenever the view becomes visible again - whether the user clicks
        // its activity bar icon or triggers it via a keyboard shortcut such
        // as "workbench.view.extension.isfsNamespaceSearchContainer" - put
        // the cursor straight into the search box so they can start typing
        // right away.
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.focusQueryInput();
            }
        });

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'ready': {
                    this.postNamespaceList();
                    this.focusQueryInput();
                    break;
                }
                case 'startSearch': {
                    const namespaceId: string | undefined = data.namespaceId;
                    if (!namespaceId) break;
                    this.cancelSearchForNamespace(namespaceId);
                    const source = new vscode.CancellationTokenSource();
                    this._cancellationTokenSources.set(namespaceId, source);
                    const useWildcards = data.useWildcards !== false;
                    this.executeThrottledSearch(data.query, data.masks, namespaceId, useWildcards, source);
                    break;
                }
                case 'stopSearch': {
                    if (data.namespaceId) this.cancelSearchForNamespace(data.namespaceId);
                    break;
                }
                case 'openMatch': {
                    const uri = vscode.Uri.parse(data.uri);
                    const doc = await vscode.workspace.openTextDocument(uri);
                    const editor = await vscode.window.showTextDocument(doc, { preview: true });
                    const pos = new vscode.Position(data.line, data.column);
                    editor.selection = new vscode.Selection(pos, pos);
                    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                    break;
                }
            }
        });
    }

    private cancelSearchForNamespace(namespaceId: string) {
        const source = this._cancellationTokenSources.get(namespaceId);
        if (source) {
            source.cancel();
            source.dispose();
            this._cancellationTokenSources.delete(namespaceId);
        }
    }

    private cancelAllSearches() {
        for (const source of this._cancellationTokenSources.values()) {
            source.cancel();
            source.dispose();
        }
        this._cancellationTokenSources.clear();
    }

    private postNamespaceList() {
        if (!this._view) return;
        this._view.webview.postMessage({ type: 'namespaceList', namespaces: getIsfsNamespaces() });
    }

    private focusQueryInput() {
        if (!this._view) return;
        this._view.webview.postMessage({ type: 'focusQuery' });
    }

    private async executeThrottledSearch(
        query: string,
        masks: string[],
        namespaceId: string,
        useWildcards: boolean,
        source: vscode.CancellationTokenSource
    ) {
        if (!this._view) return;
        const token = source.token;

        const isfsFolders = getIsfsWorkspaceFolders();
        const folder = isfsFolders.find(f => f.uri.toString() === namespaceId);

        if (!folder) {
            this._view.webview.postMessage({
                type: 'error',
                namespaceId,
                message: 'Selected namespace is no longer available. Please choose another namespace.'
            });
            this.postNamespaceList();
            this.forgetSearchIfCurrent(namespaceId, source);
            return;
        }

        // With wildcards on, '*' and '?' in the search text act as wildcards,
        // same as in the file mask field: '*' matches any run of characters
        // (e.g. "$zaccessor.*.getByList" matches "$zaccessor.Offer.getByList"),
        // '?' matches exactly one character. Everything else is escaped so
        // it's matched literally. With wildcards off, '*' and '?' are escaped
        // too, so code containing a literal '*' (e.g. $P(test,"*",1)) can
        // still be searched for as-is.
        const patternSource = buildQueryRegexSource(query, useWildcards);
        const searchRegex = new RegExp(patternSource, 'gi');

        this._view.webview.postMessage({
            type: 'searchStarted',
            namespaceId,
            query,
            mask: masks.join(',')
        });

        const cfg = vscode.workspace.getConfiguration('isfsNamespaceSearch');
        const useServerSide = cfg.get('useServerSideSearch') !== false;

        if (useServerSide) {
            const ranServerSide = await this.tryServerSideSearch(folder.uri, masks, query, useWildcards, namespaceId, source);
            if (ranServerSide) return;
            // tryServerSideSearch already posted a statusUpdate explaining why
            // it's falling back, unless the search was cancelled meanwhile.
            if (token.isCancellationRequested) {
                this._view.webview.postMessage({ type: 'searchStopped', namespaceId, message: 'Search cancelled.' });
                this.forgetSearchIfCurrent(namespaceId, source);
                return;
            }
        }

        const tuning = getSearchTuning();
        const dirCache: DirCache = new Map();

        try {
            this._view.webview.postMessage({
                type: 'statusUpdate',
                namespaceId,
                message: 'Resolving target paths in parallel...'
            });

            const resolutionPromises = masks.map(m => resolveSingleMaskFast(folder.uri, m, token, tuning, dirCache));
            const nestedResults = await Promise.all(resolutionPromises);

            if (token.isCancellationRequested) {
                this._view.webview.postMessage({ type: 'searchStopped', namespaceId, message: 'Search cancelled.' });
                return;
            }

            const uniqueFileMap = new Map<string, vscode.Uri>();
            for (const fileList of nestedResults) {
                for (const uri of fileList) {
                    uniqueFileMap.set(uri.toString(), uri);
                }
            }

            const targetFiles = Array.from(uniqueFileMap.values());

            if (targetFiles.length === 0) {
                this._view.webview.postMessage({
                    type: 'searchCompleted',
                    namespaceId,
                    message: 'Complete. No matching files found.',
                    totalMatches: 0
                });
                return;
            }

            this._view.webview.postMessage({
                type: 'statusUpdate',
                namespaceId,
                message: `Found ${targetFiles.length} file(s). Scanning...`
            });

            let processed = 0;
            let totalMatches = 0;

            await runWithConcurrency(targetFiles, tuning.fileConcurrency, token, async (fileUri) => {
                if (token.isCancellationRequested) return;

                try {
                    if (tuning.pauseBetweenReadsMs > 0) await sleep(tuning.pauseBetweenReadsMs);

                    const fileBytes = await vscode.workspace.fs.readFile(fileUri);
                    const content = new TextDecoder('utf-8').decode(fileBytes);
                    const lines = content.split(/\r?\n/);
                    const matches: MatchResult[] = [];

                    // One regex per file instead of one per line - same matching
                    // behavior (reset lastIndex before each line), far fewer
                    // RegExp allocations on files with many lines.
                    const fileRegex = new RegExp(searchRegex.source, searchRegex.flags);
                    lines.forEach((lineText, lineIdx) => {
                        fileRegex.lastIndex = 0;
                        let match: RegExpExecArray | null;
                        while ((match = fileRegex.exec(lineText)) !== null) {
                            const fileName = fileUri.path.split('/').pop() || 'Unknown';
                            matches.push({
                                fileName,
                                line: lineIdx,
                                column: match.index,
                                lineText: lineText.trim(),
                                uri: fileUri.toString()
                            });
                            totalMatches++;
                            // Guard against zero-length matches (e.g. a bare "*"
                            // wildcard) spinning forever at the same index.
                            if (match.index === fileRegex.lastIndex) fileRegex.lastIndex++;
                        }
                    });

                    if (matches.length > 0 && this._view && !token.isCancellationRequested) {
                        this._view.webview.postMessage({
                            type: 'addMatches',
                            namespaceId,
                            fileName: fileUri.path.split('/').pop() || 'Unknown',
                            uri: fileUri.toString(),
                            matches
                        });
                    }
                } catch {
                    // Ignore transient file read errors
                } finally {
                    processed++;
                    if (this._view && processed % 5 === 0 && !token.isCancellationRequested) {
                        this._view.webview.postMessage({
                            type: 'statusUpdate',
                            namespaceId,
                            message: `Scanned ${processed} / ${targetFiles.length} files...`
                        });
                    }
                }
            });

            if (token.isCancellationRequested) {
                this._view.webview.postMessage({ type: 'searchStopped', namespaceId, message: 'Search cancelled.' });
            } else {
                this._view.webview.postMessage({
                    type: 'searchCompleted',
                    namespaceId,
                    message: `Complete. Found ${totalMatches} match(es) across ${targetFiles.length} files.`,
                    totalMatches
                });
            }

        } catch (err: any) {
            this._view.webview.postMessage({ type: 'error', namespaceId, message: `Search error: ${err.message}` });
        } finally {
            this.forgetSearchIfCurrent(namespaceId, source);
        }
    }

    // Attempts the whole search as one server-side Atelier action/search
    // request. Returns true if it fully handled the search (posted
    // searchCompleted, cleaned up the token source) - the caller should just
    // return in that case. Returns false if the caller should fall back to
    // the local file-by-file scan, having already posted a statusUpdate
    // explaining why (unless the search was cancelled, which the caller
    // checks for itself).
    private async tryServerSideSearch(
        folderUri: vscode.Uri,
        masks: string[],
        query: string,
        useWildcards: boolean,
        namespaceId: string,
        source: vscode.CancellationTokenSource
    ): Promise<boolean> {
        if (!this._view) return false;
        const token = source.token;

        log(`=== New search: query="${query}" wildcards=${useWildcards} masks=[${masks.join(', ')}] ===`);

        let connection: ServerConnectionInfo | undefined;
        try {
            connection = await resolveServerConnection(folderUri);
        } catch (e: any) {
            log(`resolveServerConnection threw unexpectedly: ${e?.message || e}`);
            connection = undefined;
        }

        if (token.isCancellationRequested) return false;

        if (!connection) {
            log(`No server connection resolved - falling back to local scan. See the FAILED line(s) above for why.`);
            this._view.webview.postMessage({
                type: 'statusUpdate',
                namespaceId,
                message: 'Server-side search unavailable for this namespace - scanning files locally instead (see View > Output > "ISFS Namespace Search" for why)...'
            });
            return false;
        }

        this._view.webview.postMessage({ type: 'statusUpdate', namespaceId, message: 'Searching on the server...' });

        const cfg = vscode.workspace.getConfiguration('isfsNamespaceSearch');
        const allowSelfSigned = cfg.get('allowSelfSignedCert') === true;
        const configuredMax = cfg.get('serverSearchMaxResults');
        const maxResults = typeof configuredMax === 'number' && Number.isFinite(configuredMax) && configuredMax > 0
            ? Math.floor(configuredMax)
            : 5000;

        let groups: ServerSearchGroup[];
        try {
            groups = await runServerSideSearch(folderUri, connection, masks, query, useWildcards, maxResults, allowSelfSigned, token);
        } catch (err: any) {
            if (token.isCancellationRequested) return false;
            log(`runServerSideSearch failed: ${err?.message || err} - falling back to local scan.`);
            this._view.webview.postMessage({
                type: 'statusUpdate',
                namespaceId,
                message: `Server-side search failed (${err?.message || err}) - scanning files locally instead (see View > Output > "ISFS Namespace Search")...`
            });
            return false;
        }

        if (token.isCancellationRequested) return false;

        let totalMatches = 0;
        for (const group of groups) {
            totalMatches += group.matches.length;
            this._view.webview.postMessage({
                type: 'addMatches',
                namespaceId,
                fileName: group.fileName,
                uri: group.uri.toString(),
                matches: group.matches
            });
        }

        log(`SUCCESS: server-side search completed - ${totalMatches} match(es) across ${groups.length} file(s).`);
        this._view.webview.postMessage({
            type: 'searchCompleted',
            namespaceId,
            message: `Complete (server-side search). Found ${totalMatches} match(es) across ${groups.length} file(s).`,
            totalMatches
        });
        this.forgetSearchIfCurrent(namespaceId, source);
        return true;
    }

    // Only clears the map entry if it still points at *this* run's token
    // source, so a fresh search kicked off for the same namespace while an
    // older one is still winding down (post-cancellation) isn't clobbered.
    private forgetSearchIfCurrent(namespaceId: string, source: vscode.CancellationTokenSource) {
        if (this._cancellationTokenSources.get(namespaceId) === source) {
            this._cancellationTokenSources.delete(namespaceId);
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        html, body {
            height: 100%;
        }

        body {
            font-family: var(--vscode-font-family);
            padding: 0;
            margin: 0;
            color: var(--vscode-foreground);
            background-color: var(--vscode-sideBar-background);
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        /* Everything the user needs to see while scrolling through long
           result lists (namespace, search text, masks, buttons, status)
           stays pinned at the top. Only #scrollArea below it scrolls. */
        #fixedHeader {
            flex: 0 0 auto;
            padding: 8px 10px 0 10px;
            box-sizing: border-box;
        }

        #scrollArea {
            flex: 1 1 auto;
            min-height: 0;
            overflow-y: auto;
            padding: 0 10px 10px 10px;
            box-sizing: border-box;
        }

        .tab-panel {
            display: none;
        }

        .tab-panel.active {
            display: block;
        }

        .input-group {
            margin-bottom: 10px;
        }

        label {
            display: block;
            font-size: 10px;
            font-weight: 600;
            margin-bottom: 4px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
        }

        .hint {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
            line-height: 1.4;
        }

        .checkbox-row {
            display: flex;
            align-items: flex-start;
            gap: 6px;
            margin-top: 6px;
            font-size: 10px;
            font-weight: normal;
            text-transform: none;
            letter-spacing: normal;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            line-height: 1.4;
        }

        .checkbox-row input[type="checkbox"] {
            margin: 1px 0 0 0;
            flex-shrink: 0;
            cursor: pointer;
        }

        .mask-row {
            display: flex;
            gap: 4px;
            margin-bottom: 4px;
            align-items: center;
        }

        input[type="text"] {
            width: 100%;
            box-sizing: border-box;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, transparent);
            padding: 5px 7px;
            font-size: 12px;
            border-radius: 2px;
            outline: none;
            flex: 1;
        }

        input[type="text"]:focus {
            border-color: var(--vscode-focusBorder);
        }

        /* Small inline "x" sitting inside the Search Text box itself, so
           clearing just the query doesn't require touching the mask or
           results/history. */
        .input-with-clear {
            position: relative;
        }

        .input-with-clear input[type="text"] {
            padding-right: 24px;
        }

        .inline-clear-btn {
            position: absolute;
            top: 50%;
            right: 3px;
            transform: translateY(-50%);
            background: none;
            border: none;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            width: 18px;
            height: 18px;
            padding: 0;
            font-size: 12px;
            line-height: 1;
            border-radius: 2px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }

        .inline-clear-btn:hover {
            color: var(--vscode-errorForeground);
            background: var(--vscode-list-hoverBackground);
        }

        /* A label with its own small "clear" action to the right of it -
           used above the file mask rows so clearing the mask doesn't
           require a full "Clear All". */
        .label-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 4px;
        }

        .label-row label {
            margin-bottom: 0;
        }

        .label-clear-btn {
            background: none;
            border: none;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            padding: 2px 4px;
            font-size: 11px;
            line-height: 1;
            border-radius: 2px;
            text-transform: none;
            letter-spacing: normal;
        }

        .label-clear-btn:hover {
            color: var(--vscode-errorForeground);
            background: var(--vscode-list-hoverBackground);
        }

        /* Namespace picker: a compact dropdown button, better suited to a
           narrow sidebar than a row of tabs that needs horizontal scrolling.
           Each namespace still keeps its own independent search state (see
           nsState below) - this only changes how you pick which one is active. */
        .namespace-picker {
            position: relative;
        }

        .namespace-picker-btn {
            width: 100%;
            box-sizing: border-box;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            background: var(--vscode-dropdown-background, var(--vscode-input-background));
            color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
            border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, transparent));
            padding: 5px 8px;
            font-size: 12px;
            border-radius: 2px;
            cursor: pointer;
        }

        .namespace-picker-btn:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .namespace-picker-btn.open,
        .namespace-picker-btn:focus {
            border-color: var(--vscode-focusBorder);
            outline: none;
        }

        .namespace-picker-btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }

        .namespace-picker-label {
            flex: 1;
            display: flex;
            align-items: center;
            gap: 6px;
            overflow: hidden;
            min-width: 0;
        }

        .namespace-picker-label .label-text {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .namespace-picker-caret {
            flex-shrink: 0;
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            transition: transform 0.1s ease;
        }

        .namespace-picker-btn.open .namespace-picker-caret {
            transform: rotate(180deg);
        }

        .namespace-dropdown {
            position: absolute;
            top: calc(100% + 3px);
            left: 0;
            right: 0;
            z-index: 20;
            background: var(--vscode-dropdown-background, var(--vscode-sideBar-background));
            border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.3)));
            border-radius: 3px;
            max-height: 200px;
            overflow-y: auto;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
        }

        .namespace-option {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px 8px;
            font-size: 12px;
            cursor: pointer;
        }

        .namespace-option .label-text {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .namespace-option:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .namespace-option.active {
            background: var(--vscode-list-activeSelectionBackground, var(--vscode-button-background));
            color: var(--vscode-list-activeSelectionForeground, var(--vscode-button-foreground));
        }

        .namespace-empty-option {
            padding: 7px 8px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }

        .tab-searching-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--vscode-testing-iconQueued, #cca700);
            flex-shrink: 0;
            animation: tab-pulse 1s ease-in-out infinite;
        }

        @keyframes tab-pulse {
            0%, 100% { opacity: 0.4; }
            50% { opacity: 1; }
        }

        .icon-btn {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 0;
            width: 24px;
            height: 24px;
            font-size: 13px;
            cursor: pointer;
            border-radius: 2px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
        }

        .icon-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        .btn-row {
            display: flex;
            gap: 6px;
            margin-top: 8px;
        }

        button.action-btn {
            flex: 1;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 5px 8px;
            font-size: 12px;
            cursor: pointer;
            border-radius: 2px;
            font-weight: 500;
        }

        button.action-btn:hover {
            background: var(--vscode-button-hoverBackground);
        }

        button.action-btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }

        button#stopBtn {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            display: none;
        }

        button#stopBtn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        button#clearBtn {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        button#clearBtn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        #status {
            font-size: 11px;
            margin: 8px 0 12px 0;
            color: var(--vscode-descriptionForeground);
        }

        /* Tab bar: switches the scrollable area below #fixedHeader between
           the live "Current Search" results, the "Search History" log, and
           (once a result row has been clicked) a temporary third tab that
           shows just that one file's matches. */
        .tabs-bar {
            display: flex;
            align-items: stretch;
            gap: 2px;
            margin: 10px 0 0 0;
            border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
            flex: 0 0 auto;
            padding: 0 10px 0 22px;
            box-sizing: border-box;
        }

        .tab-btn {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
            padding: 7px 10px;
            cursor: pointer;
            border-bottom: 2px solid transparent;
            user-select: none;
            white-space: nowrap;
        }

        .tab-btn:hover {
            color: var(--vscode-foreground);
        }

        .tab-btn.active {
            color: var(--vscode-foreground);
            border-bottom-color: var(--vscode-focusBorder, var(--vscode-button-background));
        }

        /* Small "x" living inside each tab label itself (Current Search /
           Search History), so each can be cleared independently without
           affecting the other. */
        .tab-inline-clear-btn {
            background: none;
            border: none;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            padding: 1px 3px;
            font-size: 11px;
            line-height: 1;
            border-radius: 2px;
            text-transform: none;
            letter-spacing: normal;
            flex-shrink: 0;
        }

        .tab-inline-clear-btn:hover {
            color: var(--vscode-errorForeground);
            background: var(--vscode-list-hoverBackground);
        }

        /* Clean Results List - each is a flat, clickable row; clicking it
           drills into that one file's matches in place (see .detail-view
           below) instead of expanding inline. */
        .file-group {
            margin-bottom: 2px;
            border-radius: 2px;
        }

        .file-group .file-header {
            font-size: 12px;
            font-weight: 500;
            color: var(--vscode-sideBarTitle-foreground, var(--vscode-foreground));
            padding: 4px 6px;
            cursor: pointer;
            user-select: none;
            display: flex;
            align-items: center;
            border-radius: 2px;
        }

        .file-group .file-header::before {
            content: '›';
            display: inline-block;
            margin-right: 6px;
            font-size: 12px;
            line-height: 1;
        }

        .file-group:hover .file-header {
            background: var(--vscode-list-hoverBackground);
        }

        /* Drill-down view shown in place of a file list once one of its rows
           is clicked - just a back button, the file name, and its matches. */
        .detail-header {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 2px 4px 8px 4px;
        }

        .back-btn {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            width: 22px;
            height: 22px;
            padding: 0;
            font-size: 13px;
            line-height: 1;
            cursor: pointer;
            border-radius: 2px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
        }

        .back-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        .detail-title {
            font-size: 12px;
            font-weight: 600;
            color: var(--vscode-foreground);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .match-item {
            font-size: 11px;
            padding: 3px 6px 3px 16px;
            cursor: pointer;
            border-radius: 2px;
            font-family: var(--vscode-editor-font-family);
            word-break: break-all;
            line-height: 1.4;
            color: var(--vscode-foreground);
        }

        .match-item:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .line-num {
            color: var(--vscode-editorLineNumber-foreground, #858585);
            font-weight: normal;
            margin-right: 6px;
            user-select: none;
        }

        /* History Items */
        details.history-tab {
            border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
            border-radius: 3px;
            margin-bottom: 6px;
            background: transparent;
        }

        details.history-tab > summary {
            padding: 6px 8px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: space-between;
            user-select: none;
            gap: 6px;
        }

        details.history-tab > summary:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .history-summary-left {
            display: flex;
            flex-direction: column;
            gap: 2px;
            overflow: hidden;
            flex: 1;
        }

        .history-title {
            font-size: 12px;
            font-weight: 600;
            color: var(--vscode-foreground);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .history-sub {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .history-time {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
        }

        .history-content {
            padding: 6px 8px 8px 8px;
            border-top: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
        }

        .tab-clear-btn {
            background: none;
            border: none;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            padding: 2px 4px;
            font-size: 11px;
            border-radius: 2px;
            line-height: 1;
        }

        .tab-clear-btn:hover {
            color: var(--vscode-errorForeground);
            background: var(--vscode-list-hoverBackground);
        }
    </style>
</head>
<body>
    <div id="fixedHeader">
        <div class="input-group">
            <label>Namespace</label>
            <div class="namespace-picker" id="namespacePicker">
                <button type="button" id="namespacePickerBtn" class="namespace-picker-btn">
                    <span id="namespacePickerLabel" class="namespace-picker-label"><span class="label-text">No namespace folders found</span></span>
                    <span class="namespace-picker-caret">▾</span>
                </button>
                <div id="namespaceDropdown" class="namespace-dropdown" hidden></div>
            </div>
        </div>
        <div class="input-group">
            <label>Search Text</label>
            <div class="input-with-clear">
                <input type="text" id="query" placeholder="Search term..." />
                <button type="button" class="inline-clear-btn" id="clearQueryBtn" title="Clear search text">✕</button>
            </div>
            <label class="checkbox-row">
                <input type="checkbox" id="useWildcardsCheckbox" checked />
                <span>Use wildcards (<code>*</code> = any characters, <code>?</code> = one character). Turn off to search for a literal <code>*</code> or <code>?</code>.</span>
            </label>
        </div>
        <div class="input-group">
            <div class="label-row">
                <label>File Mask / Package</label>
                <button type="button" class="label-clear-btn" id="clearMasksBtn" title="Clear file mask">✕</button>
            </div>
            <div id="masksContainer">
                <div class="mask-row">
                    <input type="text" class="mask-input" placeholder="*.cls,*.mac,*.int" />
                    <button type="button" class="icon-btn" id="addMaskBtn" title="Add mask">+</button>
                </div>
            </div>
            <div class="hint">Use <code>Pkg.Sub.*</code> to search inside a package and everything under it. A plain <code>NAME*</code> (no dot) only checks items directly at the namespace root, so it stays fast.</div>
        </div>
        <div class="btn-row">
            <button id="searchBtn" class="action-btn">Search</button>
            <button id="clearBtn" class="action-btn">Clear All</button>
            <button id="stopBtn" class="action-btn">Stop</button>
        </div>

        <div id="status">Ready</div>
    </div>

    <div class="tabs-bar" id="tabsBar">
        <div class="tab-btn active" id="tabBtnCurrent">
            <span>Current Search</span>
            <button type="button" class="tab-inline-clear-btn" id="clearCurrentBtn" title="Clear current results">✕</button>
        </div>
        <div class="tab-btn" id="tabBtnHistory">
            <span>Search History</span>
            <button type="button" class="tab-inline-clear-btn" id="clearHistoryBtn" title="Clear search history">✕</button>
        </div>
    </div>

    <div id="scrollArea">
        <div id="results" class="tab-panel active">
            <div id="resultsList"></div>
            <div id="resultsDetail" class="detail-view" hidden>
                <div class="detail-header">
                    <button type="button" class="back-btn" id="resultsBackBtn" title="Back to results">←</button>
                    <span class="detail-title" id="resultsDetailTitle"></span>
                </div>
                <div id="resultsDetailMatches"></div>
            </div>
        </div>
        <div id="historyContainer" class="tab-panel"></div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const namespacePickerEl = document.getElementById('namespacePicker');
        const namespacePickerBtn = document.getElementById('namespacePickerBtn');
        const namespacePickerLabel = document.getElementById('namespacePickerLabel');
        const namespaceDropdownEl = document.getElementById('namespaceDropdown');
        const queryInput = document.getElementById('query');
        const useWildcardsCheckbox = document.getElementById('useWildcardsCheckbox');
        const masksContainer = document.getElementById('masksContainer');
        const addMaskBtn = document.getElementById('addMaskBtn');
        const searchBtn = document.getElementById('searchBtn');
        const clearBtn = document.getElementById('clearBtn');
        const stopBtn = document.getElementById('stopBtn');
        const clearQueryBtn = document.getElementById('clearQueryBtn');
        const clearMasksBtn = document.getElementById('clearMasksBtn');
        const clearCurrentBtn = document.getElementById('clearCurrentBtn');
        const clearHistoryBtn = document.getElementById('clearHistoryBtn');
        const statusDiv = document.getElementById('status');
        const resultsDiv = document.getElementById('results');
        const resultsListDiv = document.getElementById('resultsList');
        const resultsDetailDiv = document.getElementById('resultsDetail');
        const resultsDetailTitle = document.getElementById('resultsDetailTitle');
        const resultsDetailMatches = document.getElementById('resultsDetailMatches');
        const resultsBackBtn = document.getElementById('resultsBackBtn');
        const historyContainer = document.getElementById('historyContainer');
        const tabBtnCurrent = document.getElementById('tabBtnCurrent');
        const tabBtnHistory = document.getElementById('tabBtnHistory');

        // "refs" bundle used by showFileDetail/showFileList to know which
        // list/detail pair to toggle - the Current Search pane has one fixed
        // set, and each Search History entry gets its own (see buildHistoryTabElement).
        const resultsRefs = { listEl: resultsListDiv, detailEl: resultsDetailDiv, titleEl: resultsDetailTitle, matchesEl: resultsDetailMatches };

        setupNamespacePicker();
        setupTabs();

        const DEFAULT_MASKS = ['*.cls,*.mac,*.int'];

        let namespaces = [];
        let activeNamespace = '';
        // Every namespace tab keeps its own independent state (query, masks,
        // in-flight/finished results, status text, and recent-search log) so
        // switching tabs never loses what's there, and a search kicked off in
        // one tab keeps running while you work in another.
        let nsState = {};

        function createDefaultNsState() {
            return {
                query: '',
                useWildcards: true,
                // Left empty (rather than pre-filled with DEFAULT_MASKS) so a
                // namespace that's never been searched shows the defaults as
                // a placeholder hint instead of real text to delete - see
                // restoreMaskInputs/addMaskRow and the searchBtn fallback.
                masks: [],
                resultsHtml: '',
                matchCount: 0,
                statusText: 'Ready',
                searching: false,
                activeSearchInfo: { query: '', mask: '' },
                history: [],
                // Which of the two tabs is showing (current / history), and
                // whether the Current Search pane is drilled into one file's
                // matches ({fileName, matches}) or showing the full list
                // (null). Both are per-namespace so switching namespace tabs
                // restores what was on screen there.
                activeTab: 'current',
                resultsDrilldown: null
            };
        }

        function getNsState(nsId) {
            if (!nsState[nsId]) nsState[nsId] = createDefaultNsState();
            return nsState[nsId];
        }

        const previousState = vscode.getState();
        if (previousState) {
            if (previousState.nsState) nsState = previousState.nsState;
            if (previousState.namespaces && Array.isArray(previousState.namespaces)) namespaces = previousState.namespaces;
            if (previousState.activeNamespace) activeNamespace = previousState.activeNamespace;

            if (activeNamespace && nsState[activeNamespace]) {
                const state = getNsState(activeNamespace);
                queryInput.value = state.query || '';
                useWildcardsCheckbox.checked = state.useWildcards !== false;
                restoreMaskInputs(state.masks && state.masks.length ? state.masks : DEFAULT_MASKS, !(state.masks && state.masks.length));
                resultsListDiv.innerHTML = state.resultsHtml || '';
                statusDiv.textContent = state.statusText || 'Ready';
                renderHistoryFor(activeNamespace);
                updateSearchButtonsForActiveTab();
                attachListeners();
                if (state.resultsDrilldown) showFileDetail(resultsRefs, state.resultsDrilldown.fileName, state.resultsDrilldown.matches);
                else showFileList(resultsRefs);
                renderActiveTabUI();
            }
            renderNamespacePicker();
        }

        // Ask the extension for the current (and always up to date) list of
        // open ISFS namespace folders. The response repopulates the tabs
        // without disturbing the active tab or any tab's state if it's still valid.
        vscode.postMessage({ type: 'ready' });

        function getMaskValues() {
            const inputs = document.querySelectorAll('.mask-input');
            const values = [];
            inputs.forEach(input => {
                const val = input.value.trim();
                if (val) values.push(val);
            });
            return values;
        }

        function saveState() {
            // Keep the live inputs in sync with the active tab's own state
            // before persisting, so switching away never loses an in-progress edit.
            if (activeNamespace) {
                const state = getNsState(activeNamespace);
                state.query = queryInput.value;
                state.useWildcards = useWildcardsCheckbox.checked;
                state.masks = getMaskValues();
            }
            vscode.setState({ namespaces, activeNamespace, nsState });
        }

        function setNamespaces(list) {
            namespaces = Array.isArray(list) ? list : [];

            // Drop state for namespaces that are no longer open in the explorer.
            const validIds = new Set(namespaces.map(ns => ns.id));
            Object.keys(nsState).forEach(id => {
                if (!validIds.has(id)) delete nsState[id];
            });

            if (namespaces.length === 0) {
                activeNamespace = '';
                searchBtn.disabled = true;
                queryInput.value = '';
                resultsListDiv.innerHTML = '';
                showFileList(resultsRefs);
                historyContainer.innerHTML = '';
                statusDiv.textContent = 'No ISFS namespace folders open.';
                renderNamespacePicker();
                renderActiveTabUI();
                saveState();
                return;
            }

            searchBtn.disabled = false;

            if (!activeNamespace || !validIds.has(activeNamespace)) {
                switchToNamespace(namespaces[0].id);
            } else {
                renderNamespacePicker();
                saveState();
            }
        }

        // Renders both the closed picker button (active namespace name, plus a
        // pulsing dot if that namespace has a search running) and the dropdown
        // list of every open namespace. A vertical list is a better fit for a
        // narrow sidebar than a row of tabs: full names are readable without
        // truncation or horizontal scrolling, and it scales to any number of
        // open namespaces. Each namespace still keeps its own independent
        // search state (see nsState) - this only changes how you pick one.
        function renderNamespacePicker() {
            const activeNs = namespaces.find(ns => ns.id === activeNamespace);

            namespacePickerLabel.innerHTML = '';
            const textSpan = document.createElement('span');
            textSpan.className = 'label-text';
            textSpan.textContent = activeNs
                ? activeNs.label
                : (namespaces.length === 0 ? 'No namespace folders found' : 'Select a namespace');
            namespacePickerLabel.appendChild(textSpan);

            if (activeNs && getNsState(activeNs.id).searching) {
                const dot = document.createElement('span');
                dot.className = 'tab-searching-dot';
                dot.title = 'Search in progress';
                namespacePickerLabel.appendChild(dot);
            }

            namespacePickerBtn.disabled = namespaces.length === 0;
            namespacePickerBtn.title = activeNs ? activeNs.label : '';

            renderNamespaceDropdownOptions();
        }

        function renderNamespaceDropdownOptions() {
            namespaceDropdownEl.innerHTML = '';

            if (namespaces.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'namespace-empty-option';
                empty.textContent = 'No ISFS namespace folders open.';
                namespaceDropdownEl.appendChild(empty);
                return;
            }

            namespaces.forEach(ns => {
                const option = document.createElement('div');
                option.className = 'namespace-option' + (ns.id === activeNamespace ? ' active' : '');
                option.title = ns.label;

                const textSpan = document.createElement('span');
                textSpan.className = 'label-text';
                textSpan.textContent = ns.label;
                option.appendChild(textSpan);

                if (getNsState(ns.id).searching) {
                    const dot = document.createElement('span');
                    dot.className = 'tab-searching-dot';
                    dot.title = 'Search in progress';
                    option.appendChild(dot);
                }

                option.addEventListener('click', () => {
                    closeNamespaceDropdown();
                    if (ns.id !== activeNamespace) switchToNamespace(ns.id);
                });

                namespaceDropdownEl.appendChild(option);
            });
        }

        function openNamespaceDropdown() {
            if (namespaces.length === 0) return;
            namespaceDropdownEl.hidden = false;
            namespacePickerBtn.classList.add('open');
        }

        function closeNamespaceDropdown() {
            namespaceDropdownEl.hidden = true;
            namespacePickerBtn.classList.remove('open');
        }

        function setupNamespacePicker() {
            namespacePickerBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (namespaceDropdownEl.hidden) {
                    openNamespaceDropdown();
                } else {
                    closeNamespaceDropdown();
                }
            });

            document.addEventListener('click', (e) => {
                if (!namespaceDropdownEl.hidden && !namespacePickerEl.contains(e.target)) {
                    closeNamespaceDropdown();
                }
            });

            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && !namespaceDropdownEl.hidden) {
                    closeNamespaceDropdown();
                }
            });
        }

        function switchToNamespace(nsId) {
            activeNamespace = nsId;
            const state = getNsState(nsId);

            queryInput.value = state.query || '';
            useWildcardsCheckbox.checked = state.useWildcards !== false;
            restoreMaskInputs(state.masks && state.masks.length ? state.masks : DEFAULT_MASKS, !(state.masks && state.masks.length));
            resultsListDiv.innerHTML = state.resultsHtml || '';
            statusDiv.textContent = state.statusText || 'Ready';
            renderHistoryFor(nsId);
            updateSearchButtonsForActiveTab();
            attachListeners();
            if (state.resultsDrilldown) showFileDetail(resultsRefs, state.resultsDrilldown.fileName, state.resultsDrilldown.matches);
            else showFileList(resultsRefs);
            renderActiveTabUI();
            renderNamespacePicker();
            saveState();
        }

        function updateSearchButtonsForActiveTab() {
            const state = activeNamespace ? getNsState(activeNamespace) : null;
            const searching = !!(state && state.searching);
            searchBtn.style.display = searching ? 'none' : 'block';
            clearBtn.style.display = searching ? 'none' : 'block';
            stopBtn.style.display = searching ? 'block' : 'none';
        }

        // asPlaceholder: when true, the masks passed in (normally the
        // untouched DEFAULT_MASKS) are shown as grey placeholder hints
        // instead of real input text, so tabbing into an empty namespace's
        // mask box lands on a blank field ready to type into rather than
        // text that has to be deleted first. Searching with it still left
        // blank falls back to those same default masks (see searchBtn's
        // click handler), so behavior is unchanged - only the look of the
        // untouched field is different.
        function restoreMaskInputs(masks, asPlaceholder) {
            masksContainer.innerHTML = '';
            if (!masks || masks.length === 0) masks = DEFAULT_MASKS;

            masks.forEach((maskValue, index) => {
                addMaskRow(maskValue, index === 0, !!asPlaceholder && index === 0);
            });
        }

        function addMaskRow(value = '', isFirst = false, asPlaceholder = false) {
            const row = document.createElement('div');
            row.className = 'mask-row';

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'mask-input';
            if (asPlaceholder) {
                input.value = '';
                input.placeholder = value;
            } else {
                input.value = value;
                input.placeholder = 'e.g. Tafnit.App.Portfolio*.cls';
            }
            input.addEventListener('input', saveState);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    triggerSearchFromKeyboard();
                }
            });

            row.appendChild(input);

            if (isFirst) {
                const addBtn = document.createElement('button');
                addBtn.type = 'button';
                addBtn.className = 'icon-btn';
                addBtn.textContent = '+';
                addBtn.title = 'Add mask';
                addBtn.addEventListener('click', () => {
                    addMaskRow('', false);
                    saveState();
                });
                row.appendChild(addBtn);
            } else {
                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.className = 'icon-btn';
                removeBtn.textContent = '✕';
                removeBtn.title = 'Remove mask';
                removeBtn.addEventListener('click', () => {
                    row.remove();
                    saveState();
                });
                row.appendChild(removeBtn);
            }

            masksContainer.appendChild(row);
        }

        queryInput.addEventListener('input', saveState);
        queryInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                triggerSearchFromKeyboard();
            } else if (e.key === 'Tab' && !e.shiftKey) {
                // Skip past the wildcards checkbox that sits between the
                // search box and the masks in the DOM - Tab should go
                // straight to the first mask box instead.
                const firstMaskInput = masksContainer.querySelector('.mask-input');
                if (firstMaskInput) {
                    e.preventDefault();
                    firstMaskInput.focus();
                }
            }
        });
        useWildcardsCheckbox.addEventListener('change', saveState);
        addMaskBtn.addEventListener('click', () => {
            addMaskRow('', false);
            saveState();
        });

        // Pressing Enter in the search box or a mask box runs the search,
        // same as clicking the Search button - but only when that button is
        // actually the one showing (not disabled, and not already replaced
        // by the Stop button while a search is in flight).
        function triggerSearchFromKeyboard() {
            if (searchBtn.disabled) return;
            if (searchBtn.style.display === 'none') return;
            searchBtn.click();
        }

        searchBtn.addEventListener('click', () => {
            const query = queryInput.value.trim();
            // An empty mask box is normally just the untouched DEFAULT_MASKS
            // placeholder (see restoreMaskInputs) - searching without typing
            // anything there should still search those default extensions,
            // exactly as it did back when the box was pre-filled with them.
            const typedMasks = getMaskValues();
            const maskList = typedMasks.length ? typedMasks : DEFAULT_MASKS.slice();
            const useWildcards = useWildcardsCheckbox.checked;

            if (!query) return;
            if (!activeNamespace) {
                statusDiv.textContent = 'Select a namespace to search in.';
                return;
            }

            const nsId = activeNamespace;
            // Archiving now happens when THIS search itself finishes (see the
            // searchCompleted/searchStopped/error handling below), not here
            // right before starting it - so every search gets a history
            // entry on its own, rather than only the ones a later search
            // happens to overwrite.

            const state = getNsState(nsId);
            state.query = query;
            state.useWildcards = useWildcards;
            state.masks = maskList;
            state.resultsHtml = '';
            state.matchCount = 0;
            state.statusText = 'Preparing search...';
            state.searching = true;
            state.activeSearchInfo = { query, mask: maskList.join(' | ') };
            // A fresh search invalidates whatever file was drilled into, so
            // back out to the full list and land back on Current Search.
            state.resultsDrilldown = null;
            state.activeTab = 'current';

            resultsListDiv.innerHTML = '';
            showFileList(resultsRefs);
            statusDiv.textContent = state.statusText;
            updateSearchButtonsForActiveTab();
            renderActiveTabUI();
            renderNamespacePicker();
            saveState();

            vscode.postMessage({ type: 'startSearch', query, masks: maskList, namespaceId: nsId, useWildcards });
        });

        // Wipes this namespace's current results and its whole search
        // history (but leaves the search text and file mask alone) - shared
        // by the small "x" in the tab bar and by "Clear All" below, which
        // layers the text/mask reset on top of this.
        function clearSearchesForNamespace(nsId, keepHistory) {
            const state = getNsState(nsId);
            state.resultsHtml = '';
            state.matchCount = 0;
            if (!keepHistory) state.history = [];
            state.statusText = 'Ready';
            state.activeSearchInfo = { query: '', mask: '' };
            state.resultsDrilldown = null;
            state.activeTab = 'current';

            if (nsId === activeNamespace) {
                resultsListDiv.innerHTML = '';
                showFileList(resultsRefs);
                statusDiv.textContent = 'Ready';
                if (!keepHistory) renderHistoryFor(nsId);
                renderActiveTabUI();
            }
        }

        clearBtn.addEventListener('click', () => {
            // "Clear All" resets the search text, every file mask row, and
            // the current results for the active namespace - but leaves the
            // search history alone (keepHistory=true), since that's only
            // ever cleared by the dedicated icon near the tabs.
            if (!activeNamespace) return;
            queryInput.value = '';
            restoreMaskInputs(['']);
            clearSearchesForNamespace(activeNamespace, true);
            saveState();
        });

        clearQueryBtn.addEventListener('click', () => {
            queryInput.value = '';
            queryInput.focus();
            saveState();
        });

        clearMasksBtn.addEventListener('click', () => {
            restoreMaskInputs(['']);
            saveState();
        });

        // Wipes just this namespace's search history, leaving its current
        // results untouched - the "x" on the Search History tab.
        function clearHistoryOnlyForNamespace(nsId) {
            const state = getNsState(nsId);
            state.history = [];

            if (nsId === activeNamespace) {
                renderHistoryFor(nsId);
            }
        }

        clearCurrentBtn.addEventListener('click', (e) => {
            // Lives inside the Current Search tab button itself - stop the
            // click from also bubbling up into that tab's own switch-to handler.
            e.stopPropagation();
            if (!activeNamespace) return;
            // keepHistory=true: only the current results are cleared here.
            clearSearchesForNamespace(activeNamespace, true);
            saveState();
        });

        clearHistoryBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!activeNamespace) return;
            clearHistoryOnlyForNamespace(activeNamespace);
            saveState();
        });

        stopBtn.addEventListener('click', () => {
            if (!activeNamespace) return;
            vscode.postMessage({ type: 'stopSearch', namespaceId: activeNamespace });
        });

        window.addEventListener('message', event => {
            const msg = event.data;

            if (msg.type === 'namespaceList') {
                setNamespaces(msg.namespaces);
                return;
            }

            if (msg.type === 'focusQuery') {
                queryInput.focus();
                return;
            }

            // Every other message is tagged with the namespace it belongs to,
            // since a search can be running in a tab that isn't the one
            // currently visible. Update that tab's own state, and only touch
            // the visible DOM when the message is for the active tab.
            const nsId = msg.namespaceId;
            if (!nsId) return;
            const state = getNsState(nsId);
            const isActive = nsId === activeNamespace;

            switch (msg.type) {
                case 'searchStarted':
                    state.searching = true;
                    state.statusText = 'Preparing search...';
                    if (isActive) {
                        statusDiv.textContent = state.statusText;
                        updateSearchButtonsForActiveTab();
                    }
                    renderNamespacePicker();
                    saveState();
                    break;
                case 'statusUpdate':
                    state.statusText = msg.message;
                    if (isActive) statusDiv.textContent = msg.message;
                    saveState();
                    break;
                case 'addMatches': {
                    const el = buildFileMatchesElement(msg.fileName, msg.uri, msg.matches);
                    state.resultsHtml += el.outerHTML;
                    state.matchCount += msg.matches.length;
                    if (isActive) resultsListDiv.appendChild(el);
                    saveState();
                    break;
                }
                case 'searchCompleted':
                    state.searching = false;
                    state.statusText = msg.message || 'Complete.';
                    if (isActive) {
                        statusDiv.textContent = state.statusText;
                        updateSearchButtonsForActiveTab();
                    }
                    // This search's own results go to history the moment it
                    // finishes - not only if/when a later search overwrites
                    // them - so every search you actually run ends up there.
                    archiveToHistory(nsId);
                    renderNamespacePicker();
                    saveState();
                    break;
                case 'searchStopped':
                case 'error':
                    state.searching = false;
                    state.statusText = msg.message || 'Stopped';
                    if (isActive) {
                        statusDiv.textContent = state.statusText;
                        updateSearchButtonsForActiveTab();
                    }
                    // Whatever matches had already streamed in before the
                    // search was stopped/errored still count as a real,
                    // completed result set for history purposes.
                    archiveToHistory(nsId);
                    renderNamespacePicker();
                    saveState();
                    break;
            }
        });

        function archiveToHistory(nsId) {
            const state = getNsState(nsId);
            if (!state.matchCount) return;

            const now = new Date();
            const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            const entry = {
                query: state.activeSearchInfo.query || state.query,
                mask: state.activeSearchInfo.mask || (state.masks || []).join(' | '),
                totalMatches: state.matchCount,
                timeStr,
                resultsHtml: state.resultsHtml
            };

            state.history.unshift(entry);

            if (nsId === activeNamespace) renderHistoryFor(nsId);
        }

        function renderHistoryFor(nsId) {
            historyContainer.innerHTML = '';
            const entries = getNsState(nsId).history || [];
            entries.forEach(entry => {
                historyContainer.appendChild(buildHistoryTabElement(nsId, entry));
            });
        }

        function buildHistoryTabElement(nsId, entry) {
            const details = document.createElement('details');
            details.className = 'history-tab';

            const summary = document.createElement('summary');

            const leftContainer = document.createElement('div');
            leftContainer.className = 'history-summary-left';

            const titleSpan = document.createElement('span');
            titleSpan.className = 'history-title';
            titleSpan.textContent = '"' + entry.query + '"';

            const subSpan = document.createElement('span');
            subSpan.className = 'history-sub';
            subSpan.textContent = entry.mask + ' (' + entry.totalMatches + ' matches)';

            leftContainer.appendChild(titleSpan);
            leftContainer.appendChild(subSpan);

            const timeSpan = document.createElement('span');
            timeSpan.className = 'history-time';
            timeSpan.textContent = entry.timeStr;

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'tab-clear-btn';
            deleteBtn.title = 'Clear entry';
            deleteBtn.textContent = '✕';
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const state = getNsState(nsId);
                state.history = (state.history || []).filter(item => item !== entry);
                details.remove();
                saveState();
            });

            summary.appendChild(leftContainer);
            summary.appendChild(timeSpan);
            summary.appendChild(deleteBtn);

            const contentDiv = document.createElement('div');
            contentDiv.className = 'history-content';

            // Each history entry gets its own independent list/detail pair
            // (unlike Current Search, this doesn't need to be persisted -
            // reopening the sidebar just shows the full list again).
            const entryListDiv = document.createElement('div');
            entryListDiv.innerHTML = entry.resultsHtml;

            const entryDetailDiv = document.createElement('div');
            entryDetailDiv.className = 'detail-view';
            entryDetailDiv.hidden = true;

            const entryDetailHeader = document.createElement('div');
            entryDetailHeader.className = 'detail-header';

            const entryBackBtn = document.createElement('button');
            entryBackBtn.type = 'button';
            entryBackBtn.className = 'back-btn';
            entryBackBtn.title = 'Back to results';
            entryBackBtn.textContent = '←';

            const entryDetailTitle = document.createElement('span');
            entryDetailTitle.className = 'detail-title';

            entryDetailHeader.appendChild(entryBackBtn);
            entryDetailHeader.appendChild(entryDetailTitle);

            const entryDetailMatches = document.createElement('div');

            entryDetailDiv.appendChild(entryDetailHeader);
            entryDetailDiv.appendChild(entryDetailMatches);

            const entryRefs = { listEl: entryListDiv, detailEl: entryDetailDiv, titleEl: entryDetailTitle, matchesEl: entryDetailMatches };

            entryBackBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                showFileList(entryRefs);
            });

            attachFileGroupListeners(entryListDiv, entryRefs);

            contentDiv.appendChild(entryListDiv);
            contentDiv.appendChild(entryDetailDiv);

            details.appendChild(summary);
            details.appendChild(contentDiv);

            return details;
        }

        // Builds one flat, clickable row per file (e.g. "Offer.cls (2)").
        // The individual matches aren't rendered inline - they're stashed on
        // the row as JSON (so they survive being serialized back out via
        // outerHTML/innerHTML for history/state) and only rendered into the
        // list's own detail view when the row itself is clicked.
        function buildFileMatchesElement(fileName, uri, matches) {
            const group = document.createElement('div');
            group.className = 'file-group';
            group.setAttribute('data-filename', fileName);
            group.setAttribute('data-matches', JSON.stringify(matches));

            const header = document.createElement('div');
            header.className = 'file-header';
            header.textContent = fileName + ' (' + matches.length + ')';
            group.appendChild(header);

            group.addEventListener('click', () => {
                if (activeNamespace) {
                    getNsState(activeNamespace).resultsDrilldown = { fileName, matches };
                    saveState();
                }
                showFileDetail(resultsRefs, fileName, matches);
            });

            return group;
        }

        // Re-wires the click-to-drill-down handler on every file-group row
        // inside a container after that container's markup was restored from
        // a raw HTML string (innerHTML restores markup but not listeners) -
        // used for the Current Search list on reload/namespace-switch and for
        // each Search History entry's own list when it's built.
        function attachFileGroupListeners(container, refs) {
            container.querySelectorAll('.file-group').forEach(group => {
                group.addEventListener('click', () => {
                    const fileName = group.getAttribute('data-filename') || '';
                    let matches = [];
                    try { matches = JSON.parse(group.getAttribute('data-matches') || '[]'); } catch {}
                    if (refs === resultsRefs && activeNamespace) {
                        getNsState(activeNamespace).resultsDrilldown = { fileName, matches };
                        saveState();
                    }
                    showFileDetail(refs, fileName, matches);
                });
            });
        }

        function attachListeners() {
            attachFileGroupListeners(resultsListDiv, resultsRefs);
        }

        // Swaps a list/detail pair (see resultsRefs / entryRefs) to show just
        // one file's matches, with a back button to return to the full list.
        function showFileDetail(refs, fileName, matches) {
            refs.titleEl.textContent = fileName + ' (' + matches.length + ')';
            refs.matchesEl.innerHTML = '';
            matches.forEach(m => {
                const item = document.createElement('div');
                item.className = 'match-item';
                item.innerHTML = '<span class="line-num">' + (m.line + 1) + '</span>' + escapeHtml(m.lineText);
                item.addEventListener('click', () => {
                    vscode.postMessage({ type: 'openMatch', uri: m.uri, line: m.line, column: m.column });
                });
                refs.matchesEl.appendChild(item);
            });
            refs.listEl.hidden = true;
            refs.detailEl.hidden = false;
        }

        function showFileList(refs) {
            refs.detailEl.hidden = true;
            refs.listEl.hidden = false;
        }

        resultsBackBtn.addEventListener('click', () => {
            showFileList(resultsRefs);
            if (activeNamespace) {
                getNsState(activeNamespace).resultsDrilldown = null;
                saveState();
            }
        });

        // --- Tabs: Current Search / Search History ---

        function setupTabs() {
            tabBtnCurrent.addEventListener('click', () => switchToTab('current'));
            tabBtnHistory.addEventListener('click', () => switchToTab('history'));
        }

        function switchToTab(tabName) {
            if (!activeNamespace) return;
            const state = getNsState(activeNamespace);
            state.activeTab = tabName;
            renderActiveTabUI();
            saveState();
        }

        // Reflects the active namespace's chosen tab into the tab bar and
        // which of the two panels in #scrollArea is visible.
        function renderActiveTabUI() {
            const state = activeNamespace ? getNsState(activeNamespace) : null;
            const activeTab = state ? (state.activeTab || 'current') : 'current';

            tabBtnCurrent.classList.toggle('active', activeTab === 'current');
            tabBtnHistory.classList.toggle('active', activeTab === 'history');

            resultsDiv.classList.toggle('active', activeTab === 'current');
            historyContainer.classList.toggle('active', activeTab === 'history');
        }

        function escapeHtml(text) {
            return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        }
    </script>
</body>
</html>`;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function resolveSingleMaskFast(
    rootFolderUri: vscode.Uri,
    singleMask: string,
    token: vscode.CancellationToken,
    tuning: SearchTuning,
    dirCache: DirCache
): Promise<vscode.Uri[]> {
    const cleanMask = singleMask.trim();
    if (!cleanMask) return [];

    const nameFilterRegex = convertLocationInputToRegex(cleanMask);

    if (!cleanMask.includes('*') && !cleanMask.includes('?') && cleanMask.endsWith('.cls')) {
        const filePath = cleanMask.replace(/\./g, '/').replace(/\/cls$/, '.cls');
        const directFileUri = vscode.Uri.joinPath(rootFolderUri, filePath);
        try {
            const stat = await vscode.workspace.fs.stat(directFileUri);
            if (stat.type === vscode.FileType.File) {
                return [directFileUri];
            }
        } catch {
            // Fall back to target dir walk if stat fails
        }
    }

    // Only the mask's own trailing extension dot (".int", ".mac", ".cls", ...)
    // separates it from any real package path - so the dot-count that
    // actually matters is on packagePath (the mask with that one extension
    // segment removed), not on the raw mask itself.
    const lastDotIndex = cleanMask.lastIndexOf('.');
    const packagePath = lastDotIndex > 0 ? cleanMask.substring(0, lastDotIndex) : '';
    const startsWithWildcard = cleanMask.startsWith('*') || cleanMask.startsWith('?');

    // A mask with no real package qualifier - either no dot at all (e.g.
    // "WBLR*"), or its only dot is the trailing extension separator on an
    // otherwise flat, un-packaged name (e.g. "WBLRSHOW*.int") - has nothing
    // to narrow the search to beyond the root, so rather than walking the
    // entire namespace tree looking for it, treat it as a same-level lookup:
    // only the direct children of the namespace root are checked.
    // Routines in particular are commonly flat (one file per name directly
    // under the root, e.g. "WBLRSHOWFF.int"), unlike classes, which ISFS
    // nests one folder per package segment - so checking cleanMask.includes('.')
    // directly (as this used to) misfired on any routine mask with a
    // wildcard right before its extension: it wrongly treated "WBLRSHOW*" (from
    // "WBLRSHOW*.int") as a package folder name to look for, found no such
    // folder at the root (because WBLRSHOWFF.int etc. are files, not
    // folders), and silently returned zero matches - confirmed live: this is
    // exactly why the local-scan fallback found "No matching files found"
    // for a mask/server combination that genuinely had matching files.
    // A mask whose packagePath itself contains a dot (e.g.
    // "Tafnit.App.Something.cls" -> packagePath "Tafnit.App.Something") is a
    // real package path and is resolved to its folder below and searched
    // recursively from there.
    // A mask that STARTS with a wildcard (e.g. "*LRSHOW*") has no literal
    // prefix at all to anchor on - the match could be nested inside any
    // package - so it falls through to the full recursive walk below instead
    // of being wrongly restricted to just the root folder.
    if (!packagePath.includes('.') && !startsWithWildcard) {
        return await collectMatchingFilesShallow(rootFolderUri, rootFolderUri, nameFilterRegex, token, tuning, dirCache);
    }

    if (!packagePath) {
        // No package path could be derived at all (e.g. a mask starting with
        // a bare dot, or a wildcard-prefixed mask with no other dot) -
        // nothing to narrow the search to.
        return await collectMatchingFiles(rootFolderUri, rootFolderUri, nameFilterRegex, token, tuning, dirCache);
    }

    // Walk down the package path one dot-segment at a time. A literal segment
    // (e.g. "App") is a direct, zero-cost path join - no directory listing
    // needed. Only a wildcarded segment (e.g. "*" in "Tafnit.*.UI.bl.*")
    // requires listing its parent directory, and even then only to fan out
    // over that one level's subdirectories - not to walk every file beneath
    // them. This means a pattern like "Tafnit.*.UI.bl.*" only lists Tafnit's
    // direct children and checks each for a "UI/bl" subpath, instead of
    // recursively walking the entire Tafnit tree (which is what made a
    // mid-path wildcard so slow before).
    const segments = buildPathSegmentPlan(packagePath.split('.'));

    const candidateFolders = await resolveSegmentedFolders(rootFolderUri, segments, 0, token, tuning, dirCache);
    if (candidateFolders.length === 0 || token.isCancellationRequested) return [];

    const nestedFileResults = await mapWithConcurrency(candidateFolders, tuning.dirConcurrency, token, folderUri =>
        collectMatchingFiles(folderUri, rootFolderUri, nameFilterRegex, token, tuning, dirCache)
    );

    const uniqueFiles = new Map<string, vscode.Uri>();
    for (const list of nestedFileResults) {
        // A batch cancelled partway through leaves later slots unset.
        if (!list) continue;
        for (const uri of list) uniqueFiles.set(uri.toString(), uri);
    }
    return Array.from(uniqueFiles.values());
}

interface PathSegmentMatcher {
    literal: string;
    isWildcard: boolean;
    regex?: RegExp;
}

function buildPathSegmentPlan(parts: string[]): PathSegmentMatcher[] {
    return parts.map(part => {
        if (!part.includes('*') && !part.includes('?')) {
            return { literal: part, isWildcard: false };
        }
        const pattern = part
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.');
        return { literal: part, isWildcard: true, regex: new RegExp(`^${pattern}$`, 'i') };
    });
}

// Descends through the package-path segments, resolving to every concrete
// folder the pattern could point to. Literal segments narrow the path
// directly with no I/O; wildcard segments list just their parent directory
// to fan out over its subdirectories for the next segment.
async function resolveSegmentedFolders(
    currentUri: vscode.Uri,
    segments: PathSegmentMatcher[],
    index: number,
    token: vscode.CancellationToken,
    tuning: SearchTuning,
    dirCache: DirCache
): Promise<vscode.Uri[]> {
    if (token.isCancellationRequested) return [];
    if (index >= segments.length) return [currentUri];

    const segment = segments[index];

    if (!segment.isWildcard) {
        const nextUri = vscode.Uri.joinPath(currentUri, segment.literal);
        return resolveSegmentedFolders(nextUri, segments, index + 1, token, tuning, dirCache);
    }

    const entries = await readDirCached(dirCache, currentUri, tuning.pauseBetweenReadsMs, token);

    const matchingDirs = entries
        .filter(([name, type]) => type === vscode.FileType.Directory && segment.regex!.test(name))
        .map(([name]) => vscode.Uri.joinPath(currentUri, name));

    const nestedResults = await mapWithConcurrency(matchingDirs, tuning.dirConcurrency, token, dirUri =>
        resolveSegmentedFolders(dirUri, segments, index + 1, token, tuning, dirCache)
    );

    const flattened: vscode.Uri[] = [];
    for (const list of nestedResults) {
        // A batch cancelled partway through leaves later slots unset.
        if (!list) continue;
        for (const uri of list) flattened.push(uri);
    }
    return flattened;
}

async function collectMatchingFilesShallow(
    dirUri: vscode.Uri,
    rootFolderUri: vscode.Uri,
    nameFilterRegex: RegExp,
    token: vscode.CancellationToken,
    tuning: SearchTuning,
    dirCache: DirCache
): Promise<vscode.Uri[]> {
    const fileUris: vscode.Uri[] = [];
    if (token.isCancellationRequested) return fileUris;

    const entries = await readDirCached(dirCache, dirUri, tuning.pauseBetweenReadsMs, token);

    for (const [name, type] of entries) {
        if (token.isCancellationRequested) return fileUris;
        if (type !== vscode.FileType.File) continue;

        const childUri = vscode.Uri.joinPath(dirUri, name);
        let relativePath = childUri.path.substring(rootFolderUri.path.length);
        if (relativePath.startsWith('/')) relativePath = relativePath.substring(1);

        if (nameFilterRegex.test(name) || nameFilterRegex.test(relativePath)) {
            fileUris.push(childUri);
        }
    }

    return fileUris;
}

async function collectMatchingFiles(
    startUri: vscode.Uri,
    rootFolderUri: vscode.Uri,
    nameFilterRegex: RegExp,
    token: vscode.CancellationToken,
    tuning: SearchTuning,
    dirCache: DirCache
): Promise<vscode.Uri[]> {
    const fileUris: vscode.Uri[] = [];

    async function walk(currentUri: vscode.Uri) {
        if (token.isCancellationRequested) return;

        const entries = await readDirCached(dirCache, currentUri, tuning.pauseBetweenReadsMs, token);

        const subDirs: vscode.Uri[] = [];
        for (const [name, type] of entries) {
            if (token.isCancellationRequested) return;
            const childUri = vscode.Uri.joinPath(currentUri, name);
            if (type === vscode.FileType.Directory) {
                subDirs.push(childUri);
            } else if (type === vscode.FileType.File) {
                let relativePath = childUri.path.substring(rootFolderUri.path.length);
                if (relativePath.startsWith('/')) relativePath = relativePath.substring(1);

                if (nameFilterRegex.test(name) || nameFilterRegex.test(relativePath)) {
                    fileUris.push(childUri);
                }
            }
        }

        await runWithConcurrency(subDirs, tuning.dirConcurrency, token, walk);
    }

    await walk(startUri);
    return fileUris;
}

async function runWithConcurrency<T>(
    items: T[],
    concurrency: number,
    token: vscode.CancellationToken,
    fn: (item: T) => Promise<void>
): Promise<void> {
    let index = 0;
    const workers = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
        while (index < items.length) {
            if (token.isCancellationRequested) return;
            const i = index++;
            await fn(items[i]);
        }
    });
    await Promise.all(workers);
}

// Same throttled-concurrency pattern as runWithConcurrency, but collects each
// call's return value instead of assuming void.
async function mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    token: vscode.CancellationToken,
    fn: (item: T) => Promise<R>
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let index = 0;
    const workers = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
        while (index < items.length) {
            if (token.isCancellationRequested) return;
            const i = index++;
            results[i] = await fn(items[i]);
        }
    });
    await Promise.all(workers);
    return results;
}

function convertLocationInputToRegex(input: string): RegExp {
    let clean = input.trim();
    if (!clean) return /\.(cls|mac|int)$/i;

    if (clean.includes(',')) {
        const parts = clean.split(',').map(p => convertSingleMaskToRegexStr(p.trim())).filter(Boolean);
        return new RegExp(`^(${parts.join('|')})$`, 'i');
    }

    return new RegExp(`^${convertSingleMaskToRegexStr(clean)}$`, 'i');
}

function convertSingleMaskToRegexStr(mask: string): string {
    let result = mask.trim();
    if (!result) return '';
    const hasClassOrRoutineExt = /\.(cls|mac|int)$/i.test(result);

    if (result.includes('.')) {
        if (hasClassOrRoutineExt) {
            const lastDotIndex = result.lastIndexOf('.');
            const ext = result.substring(lastDotIndex);
            const packageAndName = result.substring(0, lastDotIndex);

            const slashPath = packageAndName.replace(/\./g, '/');
            return `.*${slashPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')}\\${ext}`;
        } else {
            const parts = result.split('.');
            const slashPath = parts.join('/');
            let regexStr = slashPath
                .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                .replace(/\*/g, '.*')
                .replace(/\?/g, '.');

            regexStr += '(\\.(cls|mac|int))?';
            return `.*${regexStr}`;
        }
    }

    let regexStr = result
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');

    if (!hasClassOrRoutineExt) {
        regexStr += '\\.(cls|mac|int)';
    }

    return `.*${regexStr}`;
}