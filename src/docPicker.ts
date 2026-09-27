import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { Credential, basicAuthHeader, forgetStoredPassword, getCredential, isUnauthenticated } from './credentials';

// ---------------------------------------------------------------------------
// Open InterSystems Document - with a Tree <-> Flat toggle.
//
// Same job as the InterSystems ObjectScript extension's "Open InterSystems
// Document..." command, but in one picker you can switch between:
//   - Tree: the package-by-package drill-down from vscode-objectscript <= 3.8.2
//   - Flat: the single filterable list from vscode-objectscript >= 3.8.3
// Switch with the button in the picker's title bar, or by running the command
// again (i.e. pressing your keybinding again) while the picker is open.
//
// The two list-building queries and the typed-name validation are adapted
// from vscode-objectscript's src/utils/documentPicker.ts (v3.8.2 for the
// tree, v3.8.6 for the flat list), MIT licensed - see THIRD_PARTY_NOTICES.md.
//
// It does not depend on which vscode-objectscript version is installed: it
// only borrows the connection details from its public serverForUri /
// asyncServerForUri API, talks to the Atelier REST API directly, and opens
// the chosen document through the isfs folder, so editing, saving and
// compiling still go through the InterSystems extension as usual.
// ---------------------------------------------------------------------------

type Logger = (message: string) => void;
type Mode = 'tree' | 'flat';
type Flag = '0' | '1';

const COMMAND_ID = 'isfsNamespaceSearch.openDocument';
const MODE_KEY = 'isfsNamespaceSearch.openDocument.lastMode';
const LAST_NAMESPACE_KEY = 'isfsNamespaceSearch.openDocument.lastNamespace';

// %Library.RoutineMgr_StudioOpenDialog(Spec, Dir, OrderBy, SystemFiles, Flat, NotStudio, ShowGenerated, Filter, RoundTime, Mapped)
const TREE_QUERY = 'SELECT Name, Type FROM %Library.RoutineMgr_StudioOpenDialog(?,1,1,?,0,0,?,,0,?)';
const FLAT_QUERY = 'SELECT Name, Type FROM %Library.RoutineMgr_StudioOpenDialog(?,1,1,?,1,0,?,,0,?)';
const FLAT_SPEC = "*.cls,*.mac,*.int,*.inc,*.other,'*.bpl,'*.dtl";
const TREE_ROOT_SPEC = "*,'*.prj";

interface Connection {
    base: string; // .../api/atelier/v1/<ns>
    root: string; // .../api/atelier/
    ns: string;
    server: string;
    authHeader?: string;
    credential?: Credential;
    allowSelfSigned: boolean;
}

interface PickItem extends vscode.QuickPickItem {
    fullName: string;
    entry: 'doc' | 'folder' | 'up';
}

class HttpError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

type Row = { Name: string; Type: number };
interface Flags {
    sys: Flag;
    gen: Flag;
    map: Flag;
}

/**
 * Where the document lists come from: straight from the server (fast flat
 * list, needs a password available without asking), or through the isfs
 * folder, i.e. the InterSystems extension's own connection - no password or
 * permission needed, but the flat list has to walk every package.
 */
interface DocSource {
    kind: 'direct' | 'isfs';
    ns: string;
    server: string;
    treeRoot(f: Flags): Promise<Row[]>;
    treeChildren(pkg: string, f: Flags): Promise<Row[]>;
    flat(f: Flags, progress: (rows: Row[]) => void, cancelled: () => boolean): Promise<Row[]>;
    /** 'ok', or why a typed name can't be opened. Throws on other errors. */
    validate(doc: string): Promise<'ok' | 'missing' | 'hidden' | 'invalid'>;
}

function directSource(conn: Connection): DocSource {
    return {
        kind: 'direct',
        ns: conn.ns,
        server: conn.server,
        treeRoot: (f) => runQuery(conn, `${TREE_QUERY} WHERE Type != 5 AND Type != 10`, [TREE_ROOT_SPEC, f.sys, f.gen, f.map]),
        treeChildren: (pkg, f) => runQuery(conn, TREE_QUERY, [`${pkg}/*`, f.sys, f.gen, f.map]),
        flat: (f) => runQuery(conn, FLAT_QUERY, [FLAT_SPEC, f.sys, f.gen, f.map]),
        async validate(doc) {
            try {
                if (doc.endsWith('.cls')) {
                    // StudioOpenDialog so Hidden classes aren't exposed.
                    const rows = await runQuery(conn, 'SELECT Name, Type FROM %Library.RoutineMgr_StudioOpenDialog(?,1,1,1,1,0,1,,0,1)', [doc]);
                    return rows.length ? 'ok' : 'hidden';
                }
                await request(conn, 'HEAD', `/doc/${encodeURIComponent(doc)}`);
                return 'ok';
            } catch (e) {
                if (e instanceof HttpError && e.status === 404) return 'missing';
                if (e instanceof HttpError && e.status === 400) return 'invalid';
                throw e;
            }
        }
    };
}

// Flat lists built by walking isfs folders are kept for a few minutes, so
// reopening the picker or switching views doesn't walk everything again.
const FLAT_CACHE_MS = 3 * 60 * 1000;
const flatCache = new Map<string, { at: number; rows: Row[] }>();

function isfsSource(folder: vscode.WorkspaceFolder): DocSource {
    const authority = decodeURIComponent(folder.uri.authority);
    const [server, ns = ''] = authority.split(':');

    // isfs folder options: system=1, generated=1, mapped=0.
    const uriFor = (pkg: string, f: Flags) => {
        const params = new URLSearchParams(folder.uri.query);
        params.delete('csp');
        if (f.sys === '1') params.set('system', '1'); else params.delete('system');
        if (f.gen === '1') params.set('generated', '1'); else params.delete('generated');
        if (f.map === '0') params.set('mapped', '0'); else params.delete('mapped');
        return folder.uri.with({ path: '/' + pkg.split('.').filter(Boolean).join('/'), query: params.toString() });
    };
    const list = async (pkg: string, f: Flags): Promise<Row[]> => {
        const entries = await vscode.workspace.fs.readDirectory(uriFor(pkg, f));
        return entries
            .filter(([name]) => !name.startsWith('.')) // e.g. .vscode
            .map(([name, type]) => ({
                Name: name,
                Type: type & vscode.FileType.Directory ? 9 : /\.cls$/i.test(name) ? 4 : 0
            }));
    };

    return {
        kind: 'isfs',
        ns: ns.toUpperCase(),
        server,
        treeRoot: (f) => list('', f),
        treeChildren: (pkg, f) => list(pkg, f),
        async flat(f, progress, cancelled) {
            const key = `${folder.uri.toString()}|${f.sys}${f.gen}${f.map}`;
            const hit = flatCache.get(key);
            if (hit && Date.now() - hit.at < FLAT_CACHE_MS) return hit.rows;

            const docs: Row[] = [];
            const queue: string[] = [''];
            let lastReport = 0;
            const listOne = async (pkg: string) => {
                let rows: Row[];
                try {
                    rows = await list(pkg, f);
                } catch {
                    return; // unreadable package: skip it, keep the rest
                }
                for (const r of rows) {
                    const full = pkg ? `${pkg}.${r.Name}` : r.Name;
                    if (r.Type === 9) queue.push(full);
                    else docs.push({ Name: full, Type: r.Type });
                }
                if (Date.now() - lastReport > 300) {
                    lastReport = Date.now();
                    progress([...docs].sort(byName));
                }
            };
            // Up to 8 package listings in flight at once.
            const inFlight = new Set<Promise<void>>();
            while ((queue.length || inFlight.size) && !cancelled()) {
                while (queue.length && inFlight.size < 8) {
                    const p: Promise<void> = listOne(queue.shift()!).finally(() => inFlight.delete(p));
                    inFlight.add(p);
                }
                await Promise.race(inFlight);
            }
            docs.sort(byName);
            if (!cancelled()) flatCache.set(key, { at: Date.now(), rows: docs });
            return docs;
        },
        async validate(doc) {
            try {
                const st = await vscode.workspace.fs.stat(docNameToUri(folder.uri, doc));
                return st.type & vscode.FileType.File ? 'ok' : 'missing';
            } catch (e) {
                if (e instanceof vscode.FileSystemError && e.code === 'FileNotFound') return 'missing';
                throw e;
            }
        }
    };
}

function byName(a: Row, b: Row): number {
    return a.Name.localeCompare(b.Name, undefined, { sensitivity: 'base' });
}

function isIsfsUri(uri: vscode.Uri | undefined): boolean {
    return !!uri && (uri.scheme === 'isfs' || uri.scheme === 'isfs-readonly');
}

// ---------------------------------------------------------------------------
// Connection + REST
// ---------------------------------------------------------------------------

/**
 * A direct connection if a password is available without asking anything
 * (settings, an already-allowed Server Manager login, or one stored by this
 * extension). Otherwise undefined.
 */
async function resolveConnection(folder: vscode.WorkspaceFolder, log: Logger): Promise<Connection | undefined> {
    const ext = vscode.extensions.getExtension('intersystems-community.vscode-objectscript');
    if (!ext) throw new Error('The InterSystems ObjectScript extension is not installed.');
    const api: any = ext.isActive ? ext.exports : await ext.activate();

    const s: any = api?.asyncServerForUri ? await api.asyncServerForUri(folder.uri) : api?.serverForUri?.(folder.uri);
    if (!s?.host || !s?.port) {
        throw new Error(`No active server connection for "${folder.name}".`);
    }

    const authority = decodeURIComponent(folder.uri.authority);
    const ns: string = s.namespace || authority.split(':')[1] || '';
    if (!ns) throw new Error(`Couldn't determine the namespace of "${folder.name}".`);

    // Never use s.auth.httpAuthorizationHeader: on vscode-objectscript 3.8.x,
    // without a plain-text password it's "username:undefined" and gets a 401.
    const serverName: string = s.serverName || authority.split(':')[0];
    let credential: Credential | undefined;
    if (!isUnauthenticated(s.username)) {
        credential = await getCredential(serverName, s.username, s.password || s.auth?.password, { log });
        if (!credential) {
            log(`Open Document: no password available without asking - listing through the isfs folder instead.`);
            return undefined;
        }
        log(`Open Document: using the password from ${credential.source} for ${credential.username}@${serverName}`);
    }

    let pathPrefix: string = s.pathPrefix || '';
    if (pathPrefix && !pathPrefix.startsWith('/')) pathPrefix = '/' + pathPrefix;
    pathPrefix = pathPrefix.replace(/\/+$/, '');
    const scheme = s.scheme === 'http' ? 'http' : 'https';

    const conn: Connection = {
        base: `${scheme}://${s.host}:${s.port}${pathPrefix}/api/atelier/v1/${encodeURIComponent(ns)}`,
        root: `${scheme}://${s.host}:${s.port}${pathPrefix}/api/atelier/`,
        ns,
        server: serverName || s.host,
        authHeader: credential ? basicAuthHeader(credential) : undefined,
        credential,
        allowSelfSigned: vscode.workspace.getConfiguration('isfsNamespaceSearch').get<boolean>('allowSelfSignedCert', false)
    };
    log(`Open Document: using ${scheme}://${s.host}:${s.port}${pathPrefix} ns=${ns}`);
    return conn;
}

function request(conn: Connection, method: 'GET' | 'POST' | 'HEAD', path: string, body?: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
        const url = new URL(/^https?:/.test(path) ? path : conn.base + path);
        const lib = url.protocol === 'http:' ? http : https;
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
        const headers: Record<string, string | number> = { Accept: 'application/json' };
        if (conn.authHeader) headers.Authorization = conn.authHeader;
        if (payload) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = payload.length;
        }
        const options: https.RequestOptions = { method, headers };
        if (lib === https && conn.allowSelfSigned) options.rejectUnauthorized = false;

        const req = lib.request(url, options, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c as Buffer));
            res.on('end', () => {
                const status = res.statusCode || 0;
                const text = Buffer.concat(chunks).toString('utf8');
                if (status < 200 || status >= 300) {
                    // IIS/CSP error pages are HTML: keep the status, drop the markup.
                    const detail = text && !/^\s*</.test(text) ? ': ' + text.slice(0, 300) : status === 401 ? ' Unauthorized' : '';
                    reject(new HttpError(status, `HTTP ${status}${detail}`));
                    return;
                }
                if (method === 'HEAD' || !text) {
                    resolve({});
                    return;
                }
                try {
                    resolve(JSON.parse(text));
                } catch (e: any) {
                    reject(new Error(`Invalid JSON response: ${e?.message || e}`));
                }
            });
        });
        req.setTimeout(60000, () => req.destroy(new Error('Request timed out')));
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function runQuery(conn: Connection, query: string, parameters: string[]): Promise<{ Name: string; Type: number }[]> {
    const data = await request(conn, 'POST', '/action/query', { query, parameters });
    const errors: any[] = data?.status?.errors ?? [];
    if (errors.length) {
        throw new Error(errors.map((e) => e?.error ?? JSON.stringify(e)).join('; '));
    }
    return data?.result?.content ?? [];
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

function docIcon(name: string, type: number): string {
    if (type === 4) return '$(symbol-class)';
    if (type === 0) {
        if (/\.inc$/i.test(name)) return '$(file-symlink-file)';
        if (/\.(int|mac)$/i.test(name)) return '$(note)';
        return '$(symbol-misc)';
    }
    return '$(symbol-file)';
}

function createItem(row: { Name: string; Type: number }, parent?: string, delimiter = '.'): PickItem {
    const fullName = parent ? parent + delimiter + row.Name : row.Name;
    if (row.Type === 9 || row.Type === 10) {
        return { label: `${row.Type === 9 ? '$(package)' : '$(folder)'} ${row.Name}`, fullName, entry: 'folder' };
    }
    return { label: `${docIcon(row.Name, row.Type)} ${row.Name}`, fullName, entry: 'doc' };
}

/** The package a document lives in, e.g. "A.B.C.cls" -> "A.B", "X.mac" -> "" (tree root). */
function packageOf(docName: string): string {
    if (docName.includes('/')) return '';
    const parts = docName.split('.');
    return parts.length > 2 ? parts.slice(0, -2).join('.') : '';
}

/** vscode-objectscript's isfs mapping: every dot but the extension's becomes a folder. */
function docNameToUri(folderUri: vscode.Uri, name: string): vscode.Uri {
    const isCsp = name.includes('/');
    const lastDot = name.lastIndexOf('.');
    let path = isCsp ? name : name.slice(0, lastDot).replace(/\./g, '/') + '.' + name.slice(lastDot + 1);
    if (!isCsp && /.\.G?[1-9]\.int$/i.test(name)) {
        // Generated INT routine (e.g. Pkg.Cls.1.int): its last dot stays a dot.
        const lastSlash = path.lastIndexOf('/');
        path = path.slice(0, lastSlash) + '.' + path.slice(lastSlash + 1);
    }
    let uri = folderUri.with({ path: path.startsWith('/') ? path : '/' + path });
    if (!isCsp) {
        const params = new URLSearchParams(folderUri.query);
        if (params.has('csp')) {
            params.delete('csp');
            uri = uri.with({ query: params.toString() });
        }
    }
    return uri;
}

// ---------------------------------------------------------------------------
// Picker
// ---------------------------------------------------------------------------

interface ActivePicker {
    toggleMode(): void;
    toggleCheck(): void;
    goUp(): void;
    goToRoot(): void;
    backspaceUp(): void;
}
let activePicker: ActivePicker | undefined;

// Context keys for the in-picker keybindings in package.json.
const CTX_OPEN = 'isfsNamespaceSearch.docPicker.open';
const CTX_CAN_GO_UP = 'isfsNamespaceSearch.docPicker.canGoUp';
const CTX_FILTER_EMPTY = 'isfsNamespaceSearch.docPicker.filterEmpty';
const CTX_MULTI = 'isfsNamespaceSearch.docPicker.multi';

// Holding Backspace: the key auto-repeats every few dozen ms, but VS Code
// doesn't tell extensions whether a key is held. So a Backspace that arrives
// within REPEAT_GAP_MS of the previous one is treated as a held repeat, and
// one within EMPTIED_GUARD_MS of the filter being emptied by typing is
// treated as the same hold (covers the OS's initial repeat delay). Either
// way it's ignored, so a held Backspace stops at the empty filter and only a
// fresh press goes up a package.
const REPEAT_GAP_MS = 150;
const EMPTIED_GUARD_MS = 600;

function setContext(key: string, value: boolean) {
    vscode.commands.executeCommand('setContext', key, value);
}

function initialMode(context: vscode.ExtensionContext): Mode {
    const setting = vscode.workspace.getConfiguration('isfsNamespaceSearch').get<string>('openDocument.defaultMode', 'last');
    if (setting === 'tree' || setting === 'flat') return setting;
    return context.globalState.get<Mode>(MODE_KEY, 'tree');
}

function pickDocument(context: vscode.ExtensionContext, source: DocSource, log: Logger): Promise<string[] | undefined> {
    let mode: Mode = initialMode(context);
    let sys: Flag = '0';
    let gen: Flag = '0';
    let map: Flag = '1';
    let treeParent = ''; // '' = tree root
    let loadSeq = 0;
    let lastBackspaceAt = 0; // last Backspace-driven event (deletion or ignored/handled press)
    let emptiedAt = 0; // when typing/deleting (not us) last emptied the filter
    let clearingFilter = false;
    // Checkbox mode: ticked documents are remembered by full name across
    // packages and Tree/Flat switches; Enter opens them all.
    let multi = false;
    const checked = new Set<string>();
    let applyingSelection = false;

    return new Promise<string[] | undefined>((resolve) => {
        let done = false;
        const finish = (docs: string[] | undefined) => {
            if (done) return;
            done = true;
            resolve(docs);
            quickPick.hide();
        };

        const quickPick = vscode.window.createQuickPick<PickItem>();
        quickPick.ignoreFocusOut = true;

        const modeButton = (): vscode.QuickInputButton =>
            mode === 'tree'
                ? { iconPath: new vscode.ThemeIcon('list-flat'), tooltip: 'Switch to flat list' }
                : { iconPath: new vscode.ThemeIcon('list-tree'), tooltip: 'Switch to tree' };
        const sysButton = (): vscode.QuickInputButton => ({
            iconPath: new vscode.ThemeIcon('library'),
            tooltip: `System documents: ${sys === '1' ? 'shown' : 'hidden'} (click to toggle)`
        });
        const genButton = (): vscode.QuickInputButton => ({
            iconPath: new vscode.ThemeIcon('server-process'),
            tooltip: `Generated documents: ${gen === '1' ? 'shown' : 'hidden'} (click to toggle)`
        });
        const mapButton = (): vscode.QuickInputButton => ({
            iconPath: new vscode.ThemeIcon('references'),
            tooltip: `Mapped documents: ${map === '1' ? 'shown' : 'hidden'} (click to toggle)`
        });
        const rootButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('home'), tooltip: 'Back to namespace root (Ctrl+H)' };
        const refreshButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('refresh'), tooltip: 'Reload the list' };
        const multiButton = (): vscode.QuickInputButton =>
            multi
                ? { iconPath: new vscode.ThemeIcon('checklist'), tooltip: 'Checkbox mode is ON: tick files, Enter opens them all (click to turn off)' }
                : { iconPath: new vscode.ThemeIcon('checklist'), tooltip: 'Open several files: checkbox mode' };
        let buttons = { multi: multiButton(), mode: modeButton(), sys: sysButton(), gen: genButton(), map: mapButton() };

        const refreshChrome = () => {
            buttons = { multi: multiButton(), mode: modeButton(), sys: sysButton(), gen: genButton(), map: mapButton() };
            const inSubPackage = mode === 'tree' && !!treeParent;
            // Back (left of the title) and Root stay put no matter how far the list is scrolled.
            quickPick.buttons = [
                ...(inSubPackage ? [vscode.QuickInputButtons.Back, rootButton] : []),
                ...(mode === 'flat' ? [refreshButton] : []),
                buttons.multi, buttons.mode, buttons.sys, buttons.gen, buttons.map
            ];
            setContext(CTX_CAN_GO_UP, inSubPackage);
            const where = mode === 'tree' && treeParent ? ` · ${treeParent}` : '';
            const ticks = multi ? ` · ${checked.size} ticked` : '';
            quickPick.title = `Open document (${mode === 'tree' ? 'Tree' : 'Flat'}) in namespace '${source.ns}' on server '${source.server}'${where}${ticks}`;
            quickPick.placeholder = multi
                ? 'Tick files (click, or Ctrl+Enter), then press Enter to open them all'
                : `System: ${sys === '1' ? 'on' : 'off'} · Generated: ${gen === '1' ? 'on' : 'off'} · Mapped: ${map === '1' ? 'on' : 'off'}` +
                  ' — or type a full document name with extension and press Enter';
        };

        /** Shows `items`, re-ticking remembered documents in checkbox mode. */
        const setItems = (items: PickItem[], activeName?: string) => {
            applyingSelection = true;
            quickPick.items = items;
            if (multi) quickPick.selectedItems = items.filter((i) => i.entry === 'doc' && checked.has(i.fullName));
            const active = activeName ? items.find((i) => i.fullName === activeName) : undefined;
            if (active) quickPick.activeItems = [active];
            applyingSelection = false;
        };

        const clearFilter = () => {
            clearingFilter = true;
            quickPick.value = '';
            clearingFilter = false;
            setContext(CTX_FILTER_EMPTY, true);
        };

        const load = async (selectName?: string) => {
            const seq = ++loadSeq;
            quickPick.busy = true;
            refreshChrome();
            try {
                let items: PickItem[];
                const flags: Flags = { sys, gen, map };
                if (mode === 'flat') {
                    const stale = () => seq !== loadSeq || done;
                    // Through the isfs folder, documents show up as they're found.
                    const rows = await source.flat(flags, (partial) => {
                        if (stale()) return;
                        setItems(partial.map((r) => createItem(r)));
                        refreshChrome();
                        quickPick.title += ` — loading... ${partial.length} documents so far`;
                    }, stale);
                    if (stale()) return;
                    refreshChrome();
                    items = rows.map((r) => createItem(r));
                } else if (!treeParent) {
                    const rows = await source.treeRoot(flags);
                    items = rows.map((r) => createItem(r));
                } else {
                    const delim = treeParent.includes('/') ? '/' : '.';
                    const rows = await source.treeChildren(treeParent, flags);
                    const up = treeParent.split(delim).slice(0, -1).join(delim);
                    items = [
                        { label: '$(arrow-up) ..', fullName: up === '/' ? '' : up, entry: 'up' } as PickItem,
                        ...rows.map((r) => createItem(r, treeParent, delim))
                    ];
                }
                if (seq !== loadSeq || done) return; // a newer load superseded this one
                setItems(items, selectName);
            } catch (e: any) {
                if (seq !== loadSeq || done) return;
                log(`Open Document: listing failed: ${e?.message || e}`);
                vscode.window.showErrorMessage(`Failed to get namespace contents: ${e?.message || e}`);
                finish(undefined);
            } finally {
                if (seq === loadSeq) quickPick.busy = false;
            }
        };

        const toggleMode = () => {
            const current = quickPick.activeItems[0];
            mode = mode === 'tree' ? 'flat' : 'tree';
            context.globalState.update(MODE_KEY, mode);
            log(`Open Document: switched to ${mode}`);
            if (mode === 'tree') {
                // Flat -> Tree always starts at the namespace root.
                treeParent = '';
                clearFilter();
                load();
            } else {
                // Tree -> Flat keeps the filter text, and the document you were on if any.
                load(current?.entry === 'doc' ? current.fullName : undefined);
            }
        };

        const goUp = () => {
            if (mode !== 'tree' || !treeParent) return;
            const delim = treeParent.includes('/') ? '/' : '.';
            const cameFrom = treeParent;
            const up = treeParent.split(delim).slice(0, -1).join(delim);
            treeParent = up === '/' ? '' : up;
            clearFilter();
            // Land on the package you just left.
            load(cameFrom);
        };

        const backspaceUp = () => {
            const now = Date.now();
            const heldRepeat = now - lastBackspaceAt < REPEAT_GAP_MS || now - emptiedAt < EMPTIED_GUARD_MS;
            lastBackspaceAt = now;
            if (heldRepeat) return;
            // Same guard after going up, so holding Backspace on an empty
            // filter goes up one package, not all the way to the root.
            emptiedAt = now;
            goUp();
        };

        const goToRoot = () => {
            if (mode !== 'tree' || !treeParent) return;
            treeParent = '';
            clearFilter();
            load();
        };

        const toggleMulti = () => {
            multi = !multi;
            if (!multi) checked.clear();
            quickPick.canSelectMany = multi;
            setContext(CTX_MULTI, multi);
            log(`Open Document: checkbox mode ${multi ? 'on' : 'off'}`);
            refreshChrome();
            setItems([...quickPick.items], quickPick.activeItems[0]?.fullName);
        };

        /** Ctrl+Enter in checkbox mode: tick/untick the highlighted file. */
        const toggleCheck = () => {
            const item = quickPick.activeItems[0];
            if (!multi || !item || item.entry !== 'doc') return;
            if (checked.has(item.fullName)) checked.delete(item.fullName);
            else checked.add(item.fullName);
            setItems([...quickPick.items], item.fullName);
            refreshChrome();
        };

        quickPick.onDidChangeSelection((selection) => {
            if (!multi || applyingSelection) return;
            // Folders and '..' get a checkbox too (VS Code shows one on every
            // row); clicking one navigates instead of ticking it.
            const nav = selection.find((i) => i.entry !== 'doc');
            if (nav) {
                if (nav.entry === 'up') goUp();
                else {
                    treeParent = nav.fullName;
                    clearFilter();
                    load();
                }
                return;
            }
            const selected = new Set(selection.map((i) => i.fullName));
            for (const i of quickPick.items) {
                if (i.entry !== 'doc') continue;
                if (selected.has(i.fullName)) checked.add(i.fullName);
                else checked.delete(i.fullName);
            }
            refreshChrome();
        });

        const validateTyped = async (raw: string): Promise<string | undefined> => {
            let doc = raw;
            // Normalize the extension case for classes and routines.
            if (['.cls', '.mac', '.int', '.inc'].includes(doc.slice(-4).toLowerCase())) {
                doc = doc.slice(0, -3) + doc.slice(-3).toLowerCase();
            }
            // Short form of %Library classes: %String.cls -> %Library.String.cls
            if (doc.startsWith('%') && doc.split('.').length === 2 && doc.endsWith('.cls')) {
                doc = `%Library.${doc.slice(1)}`;
            }
            if (!/\.[^./]+$/.test(doc)) {
                vscode.window.showErrorMessage(`Type the full document name with its extension (e.g. ${doc}.cls or ${doc}.mac).`, 'Dismiss');
                return undefined;
            }
            try {
                const result = await source.validate(doc);
                if (result === 'ok') return doc;
                vscode.window.showErrorMessage(
                    result === 'hidden' ? `Class '${doc.slice(0, -4)}' does not exist, or is Hidden.`
                    : result === 'invalid' ? `'${doc}' is an invalid document name.`
                    : `Document '${doc}' does not exist.`,
                    'Dismiss'
                );
                return undefined;
            } catch (e: any) {
                vscode.window.showErrorMessage(`Couldn't check document '${doc}': ${e?.message || e}`, 'Dismiss');
                return undefined;
            }
        };

        quickPick.onDidTriggerButton((button) => {
            if (button === buttons.mode) {
                toggleMode();
                return;
            }
            if (button === buttons.multi) {
                toggleMulti();
                return;
            }
            if (button === vscode.QuickInputButtons.Back) {
                goUp();
                return;
            }
            if (button === refreshButton) {
                flatCache.clear();
                load(quickPick.activeItems[0]?.fullName);
                return;
            }
            if (button === rootButton) {
                goToRoot();
                return;
            }
            if (button === buttons.sys) sys = sys === '1' ? '0' : '1';
            else if (button === buttons.gen) gen = gen === '1' ? '0' : '1';
            else if (button === buttons.map) map = map === '1' ? '0' : '1';
            else return;
            const current = quickPick.activeItems[0];
            load(current?.fullName);
        });

        quickPick.onDidAccept(async () => {
            if (multi && checked.size) {
                finish([...checked].sort());
                return;
            }
            const item = (multi ? undefined : quickPick.selectedItems[0]) ?? quickPick.activeItems[0];
            if (item?.entry === 'up') {
                goUp();
                return;
            }
            if (item?.entry === 'folder') {
                treeParent = item.fullName;
                clearFilter();
                load();
                return;
            }
            if (item) {
                finish([item.fullName]);
                return;
            }
            const typed = quickPick.value.trim();
            if (!typed) return;
            quickPick.busy = true;
            quickPick.enabled = false;
            const doc = await validateTyped(typed);
            if (doc) {
                finish([doc]);
            } else if (!done) {
                quickPick.busy = false;
                quickPick.enabled = true;
            }
        });

        let previousValue = '';
        quickPick.onDidChangeValue((v) => {
            setContext(CTX_FILTER_EMPTY, v.length === 0);
            if (!clearingFilter && v.length < previousValue.length) {
                // A deletion by the user (Backspace/Delete/cut).
                lastBackspaceAt = Date.now();
                if (!v.length) emptiedAt = lastBackspaceAt;
            }
            previousValue = v;
        });

        quickPick.onDidHide(() => {
            activePicker = undefined;
            setContext(CTX_OPEN, false);
            setContext(CTX_CAN_GO_UP, false);
            setContext(CTX_MULTI, false);
            if (!done) {
                done = true;
                resolve(undefined);
            }
            quickPick.dispose();
        });

        activePicker = { toggleMode, toggleCheck, goUp, goToRoot, backspaceUp };
        setContext(CTX_OPEN, true);
        setContext(CTX_FILTER_EMPTY, true);
        refreshChrome();
        quickPick.show();
        load();
    });
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/** One isfs folder: use it. Several: ask, with the current file's namespace first. */
async function pickFolder(context: vscode.ExtensionContext): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => isIsfsUri(f.uri));
    if (folders.length <= 1) return folders[0];

    const active = vscode.window.activeTextEditor?.document.uri;
    const current = isIsfsUri(active) ? vscode.workspace.getWorkspaceFolder(active!) : undefined;
    const lastId = context.workspaceState.get<string>(LAST_NAMESPACE_KEY);
    const rank = (f: vscode.WorkspaceFolder) =>
        current && f.uri.toString() === current.uri.toString() ? 0 : f.uri.toString() === lastId ? 1 : 2;
    const ordered = [...folders].sort((a, b) => rank(a) - rank(b) || a.index - b.index);

    const picked = await vscode.window.showQuickPick(
        ordered.map((f) => ({
            label: f.name,
            description: [decodeURIComponent(f.uri.authority), rank(f) === 0 ? 'current file' : rank(f) === 1 ? 'last used' : '']
                .filter(Boolean)
                .join('  ·  '),
            folder: f
        })),
        { title: 'Open InterSystems Document', placeHolder: 'Open a document from which namespace?' }
    );
    if (picked) await context.workspaceState.update(LAST_NAMESPACE_KEY, picked.folder.uri.toString());
    return picked?.folder;
}

/**
 * Direct when a password is available silently and the server accepts it,
 * otherwise through the isfs folder. Never prompts and never asks VS Code
 * for permission to use a saved login.
 */
async function chooseSource(folder: vscode.WorkspaceFolder, log: Logger): Promise<DocSource> {
    try {
        const conn = await resolveConnection(folder, log);
        if (conn) {
            try {
                await request(conn, 'GET', conn.root); // one cheap login check
                return directSource(conn);
            } catch (e) {
                if (e instanceof HttpError && e.status === 401 && conn.credential) {
                    log(`Open Document: server rejected the password from ${conn.credential.source}.`);
                    if (conn.credential.source === 'secret') await forgetStoredPassword(conn.server, conn.credential.username);
                } else {
                    log(`Open Document: direct connection failed (${(e as any)?.message || e}).`);
                }
            }
        }
    } catch (e: any) {
        log(`Open Document: couldn't resolve a direct connection (${e?.message || e}).`);
    }
    return isfsSource(folder);
}

async function runOpenDocument(context: vscode.ExtensionContext, log: Logger) {
    // Pressing the keybinding again while the picker is open flips Tree <-> Flat.
    if (activePicker) {
        activePicker.toggleMode();
        return;
    }

    const folder = await pickFolder(context);
    if (!folder) {
        if (!(vscode.workspace.workspaceFolders ?? []).some((f) => isIsfsUri(f.uri))) {
            vscode.window.showWarningMessage('Open Document: no InterSystems (isfs) namespace folder is open in this workspace.');
        }
        return;
    }

    const source = await chooseSource(folder, log);
    log(`Open Document: listing ${source.kind === 'direct' ? 'directly from the server' : 'through the isfs folder'}.`);
    const docs = await pickDocument(context, source, log);
    if (!docs?.length) return;

    // Several: open each as its own tab, keeping focus for the last one.
    for (let i = 0; i < docs.length; i++) {
        const uri = docNameToUri(folder.uri, docs[i]);
        log(`Open Document: ${docs[i]} -> ${uri.toString()}`);
        try {
            await vscode.window.showTextDocument(uri, { preview: false, preserveFocus: i < docs.length - 1 });
        } catch (e: any) {
            vscode.window.showErrorMessage(`Couldn't open ${docs[i]}: ${e?.message || e}`);
        }
    }
}

export function registerDocPicker(context: vscode.ExtensionContext, log: Logger) {
    context.subscriptions.push(
        // In-picker actions (keybindings in package.json, only active while the picker is open).
        vscode.commands.registerCommand(`${COMMAND_ID}.toggleView`, () => activePicker?.toggleMode()),
        vscode.commands.registerCommand(`${COMMAND_ID}.toggleCheck`, () => activePicker?.toggleCheck()),
        vscode.commands.registerCommand(`${COMMAND_ID}.goUp`, () => activePicker?.goUp()),
        vscode.commands.registerCommand(`${COMMAND_ID}.backspaceUp`, () => activePicker?.backspaceUp()),
        vscode.commands.registerCommand(`${COMMAND_ID}.goToRoot`, () => activePicker?.goToRoot()),
        vscode.commands.registerCommand(COMMAND_ID, () =>
            runOpenDocument(context, log).catch((e: any) => {
                log(`Open Document failed: ${e?.message || e}`);
                vscode.window.showErrorMessage(`Open Document: ${e?.message || e}`);
            })
        )
    );
}
