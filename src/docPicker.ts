import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';

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
    ns: string;
    server: string;
    authHeader?: string;
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

function isIsfsUri(uri: vscode.Uri | undefined): boolean {
    return !!uri && (uri.scheme === 'isfs' || uri.scheme === 'isfs-readonly');
}

// ---------------------------------------------------------------------------
// Connection + REST
// ---------------------------------------------------------------------------

async function resolveConnection(folder: vscode.WorkspaceFolder, log: Logger): Promise<Connection> {
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

    let authHeader: string | undefined;
    if (s.username && s.password) {
        authHeader = 'Basic ' + Buffer.from(`${s.username}:${s.password}`).toString('base64');
    } else if (s.auth?.httpAuthorizationHeader) {
        authHeader = s.auth.httpAuthorizationHeader;
    } else if (s.username && String(s.username).toLowerCase() !== 'unknownuser') {
        // Newer vscode-objectscript versions only hand out a password that is
        // stored in plain text in settings.
        throw new Error(
            `No password available for server "${s.serverName || authority}". ` +
            `Store the password in your intersystems.servers settings so this command can use it.`
        );
    }

    let pathPrefix: string = s.pathPrefix || '';
    if (pathPrefix && !pathPrefix.startsWith('/')) pathPrefix = '/' + pathPrefix;
    pathPrefix = pathPrefix.replace(/\/+$/, '');
    const scheme = s.scheme === 'http' ? 'http' : 'https';

    const conn: Connection = {
        base: `${scheme}://${s.host}:${s.port}${pathPrefix}/api/atelier/v1/${encodeURIComponent(ns)}`,
        ns,
        server: s.serverName || authority.split(':')[0] || s.host,
        authHeader,
        allowSelfSigned: vscode.workspace.getConfiguration('isfsNamespaceSearch').get<boolean>('allowSelfSignedCert', false)
    };
    log(`Open Document: using ${scheme}://${s.host}:${s.port}${pathPrefix} ns=${ns}`);
    return conn;
}

function request(conn: Connection, method: 'GET' | 'POST' | 'HEAD', path: string, body?: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
        const url = new URL(conn.base + path);
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
                    reject(new HttpError(status, `HTTP ${status}${text ? ': ' + text.slice(0, 300) : ''}`));
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
    goUp(): void;
    goToRoot(): void;
}
let activePicker: ActivePicker | undefined;

// Context keys for the in-picker keybindings in package.json.
const CTX_OPEN = 'isfsNamespaceSearch.docPicker.open';
const CTX_CAN_GO_UP = 'isfsNamespaceSearch.docPicker.canGoUp';
const CTX_FILTER_EMPTY = 'isfsNamespaceSearch.docPicker.filterEmpty';

function setContext(key: string, value: boolean) {
    vscode.commands.executeCommand('setContext', key, value);
}

function initialMode(context: vscode.ExtensionContext): Mode {
    const setting = vscode.workspace.getConfiguration('isfsNamespaceSearch').get<string>('openDocument.defaultMode', 'last');
    if (setting === 'tree' || setting === 'flat') return setting;
    return context.globalState.get<Mode>(MODE_KEY, 'tree');
}

function pickDocument(context: vscode.ExtensionContext, conn: Connection, log: Logger): Promise<string | undefined> {
    let mode: Mode = initialMode(context);
    let sys: Flag = '0';
    let gen: Flag = '0';
    let map: Flag = '1';
    let treeParent = ''; // '' = tree root
    let loadSeq = 0;

    return new Promise<string | undefined>((resolve) => {
        let done = false;
        const finish = (doc: string | undefined) => {
            if (done) return;
            done = true;
            resolve(doc);
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
        const rootButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('home'), tooltip: 'Back to namespace root (Alt+Home)' };
        let buttons = { mode: modeButton(), sys: sysButton(), gen: genButton(), map: mapButton() };

        const refreshChrome = () => {
            buttons = { mode: modeButton(), sys: sysButton(), gen: genButton(), map: mapButton() };
            const inSubPackage = mode === 'tree' && !!treeParent;
            // Back (left of the title) and Root stay put no matter how far the list is scrolled.
            quickPick.buttons = [
                ...(inSubPackage ? [vscode.QuickInputButtons.Back, rootButton] : []),
                buttons.mode, buttons.sys, buttons.gen, buttons.map
            ];
            setContext(CTX_CAN_GO_UP, inSubPackage);
            const where = mode === 'tree' && treeParent ? ` · ${treeParent}` : '';
            quickPick.title = `Open document (${mode === 'tree' ? 'Tree' : 'Flat'}) in namespace '${conn.ns}' on server '${conn.server}'${where}`;
            quickPick.placeholder =
                `System: ${sys === '1' ? 'on' : 'off'} · Generated: ${gen === '1' ? 'on' : 'off'} · Mapped: ${map === '1' ? 'on' : 'off'}` +
                ' — or type a full document name with extension and press Enter';
        };

        const load = async (selectName?: string) => {
            const seq = ++loadSeq;
            quickPick.busy = true;
            refreshChrome();
            try {
                let items: PickItem[];
                if (mode === 'flat') {
                    const rows = await runQuery(conn, FLAT_QUERY, [FLAT_SPEC, sys, gen, map]);
                    items = rows.map((r) => createItem(r));
                } else if (!treeParent) {
                    const rows = await runQuery(conn, `${TREE_QUERY} WHERE Type != 5 AND Type != 10`, [TREE_ROOT_SPEC, sys, gen, map]);
                    items = rows.map((r) => createItem(r));
                } else {
                    const delim = treeParent.includes('/') ? '/' : '.';
                    const rows = await runQuery(conn, TREE_QUERY, [`${treeParent}/*`, sys, gen, map]);
                    const up = treeParent.split(delim).slice(0, -1).join(delim);
                    items = [
                        { label: '$(arrow-up) ..', fullName: up === '/' ? '' : up, entry: 'up' } as PickItem,
                        ...rows.map((r) => createItem(r, treeParent, delim))
                    ];
                }
                if (seq !== loadSeq || done) return; // a newer load superseded this one
                quickPick.items = items;
                const selected = selectName ? items.find((i) => i.fullName === selectName) : undefined;
                if (selected) quickPick.activeItems = [selected];
            } catch (e: any) {
                if (seq !== loadSeq || done) return;
                log(`Open Document: listing failed: ${e?.message || e}`);
                const hint = e instanceof HttpError && e.status === 401 ? ' Check the username/password stored for this server.' : '';
                vscode.window.showErrorMessage(`Failed to get namespace contents: ${e?.message || e}.${hint}`);
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
                quickPick.value = '';
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
            quickPick.value = '';
            // Land on the package you just left.
            load(cameFrom);
        };

        const goToRoot = () => {
            if (mode !== 'tree' || !treeParent) return;
            treeParent = '';
            quickPick.value = '';
            load();
        };

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
                if (doc.endsWith('.cls')) {
                    // StudioOpenDialog so Hidden classes aren't exposed.
                    const rows = await runQuery(conn, 'SELECT Name, Type FROM %Library.RoutineMgr_StudioOpenDialog(?,1,1,1,1,0,1,,0,1)', [doc]);
                    if (!rows.length) {
                        vscode.window.showErrorMessage(`Class '${doc.slice(0, -4)}' does not exist, or is Hidden.`, 'Dismiss');
                        return undefined;
                    }
                } else {
                    await request(conn, 'HEAD', `/doc/${encodeURIComponent(doc)}`);
                }
                return doc;
            } catch (e: any) {
                const status = e instanceof HttpError ? e.status : 0;
                vscode.window.showErrorMessage(
                    status === 400 ? `'${doc}' is an invalid document name.`
                    : status === 404 ? `Document '${doc}' does not exist.`
                    : `Couldn't validate document '${doc}': ${e?.message || e}`,
                    'Dismiss'
                );
                return undefined;
            }
        };

        quickPick.onDidTriggerButton((button) => {
            if (button === buttons.mode) {
                toggleMode();
                return;
            }
            if (button === vscode.QuickInputButtons.Back) {
                goUp();
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
            const item = quickPick.selectedItems[0] ?? quickPick.activeItems[0];
            if (item?.entry === 'up') {
                goUp();
                return;
            }
            if (item?.entry === 'folder') {
                treeParent = item.fullName;
                quickPick.value = '';
                load();
                return;
            }
            if (item) {
                finish(item.fullName);
                return;
            }
            const typed = quickPick.value.trim();
            if (!typed) return;
            quickPick.busy = true;
            quickPick.enabled = false;
            const doc = await validateTyped(typed);
            if (doc) {
                finish(doc);
            } else if (!done) {
                quickPick.busy = false;
                quickPick.enabled = true;
            }
        });

        quickPick.onDidChangeValue((v) => setContext(CTX_FILTER_EMPTY, v.length === 0));

        quickPick.onDidHide(() => {
            activePicker = undefined;
            setContext(CTX_OPEN, false);
            setContext(CTX_CAN_GO_UP, false);
            if (!done) {
                done = true;
                resolve(undefined);
            }
            quickPick.dispose();
        });

        activePicker = { toggleMode, goUp, goToRoot };
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

    const conn = await resolveConnection(folder, log);
    const doc = await pickDocument(context, conn, log);
    if (!doc) return;

    const uri = docNameToUri(folder.uri, doc);
    log(`Open Document: ${doc} -> ${uri.toString()}`);
    await vscode.window.showTextDocument(uri, { preview: false });
}

export function registerDocPicker(context: vscode.ExtensionContext, log: Logger) {
    context.subscriptions.push(
        // In-picker actions (keybindings in package.json, only active while the picker is open).
        vscode.commands.registerCommand(`${COMMAND_ID}.toggleView`, () => activePicker?.toggleMode()),
        vscode.commands.registerCommand(`${COMMAND_ID}.goUp`, () => activePicker?.goUp()),
        vscode.commands.registerCommand(`${COMMAND_ID}.goToRoot`, () => activePicker?.goToRoot()),
        vscode.commands.registerCommand(COMMAND_ID, () =>
            runOpenDocument(context, log).catch((e: any) => {
                log(`Open Document failed: ${e?.message || e}`);
                vscode.window.showErrorMessage(`Open Document: ${e?.message || e}`);
            })
        )
    );
}
