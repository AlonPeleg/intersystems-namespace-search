import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { chooseDocuments, docNameToUri } from './docPicker';
import { findLabelLine } from './goto';
import { CodeLogView } from './codeLogView';

// ---------------------------------------------------------------------------
// Code Log: your own notes about server-side code, organised in folders.
//
//   folder (any name, Hebrew / English)
//     ├─ subfolder ... (any depth)
//     └─ document (Pkg.Cls.cls / ROUTINE.mac / .int, on a server + namespace)
//          └─ label / method / classmethod
//
// Every entry has a title and a description, edited in the Details panel
// under the tree. Documents and members open in the editor when their
// namespace is open in the workspace; otherwise they just stay as notes.
// Members are stored by name (not line number) and located when opened, so
// they survive edits to the code. Saved in VS Code's global storage, with
// JSON export / import.
// ---------------------------------------------------------------------------

type Logger = (message: string) => void;

export type Status = 'check' | 'progress' | 'ok' | 'fix';
export const STATUSES: Status[] = ['check', 'progress', 'ok', 'fix'];

export interface JournalEntry {
    id: string;
    at: string; // ISO date/time
    text: string;
}

export interface Todo {
    id: string;
    text: string;
    done: boolean;
}

/**
 * The "code log" of a document or member: working notes that live in the
 * Details panel. (Title and notes are shared with the tree.)
 */
export interface Work {
    status?: Status;
    tags: string[];
    journal: JournalEntry[];
    todos: Todo[];
    created?: string; // ISO
    edited?: string; // ISO
}

interface LogMember extends Work {
    id: string;
    name: string;
    kind: string; // Label, ClassMethod, Method, Query, ...
    title: string;
    description: string;
    /** id of the LogGroup (in the same document) this member is in, if any. */
    group?: string;
}

/** A named group of members inside one document, just for organising the view. */
interface LogGroup {
    id: string;
    name: string;
    description: string;
    tags?: string[];
}

interface LogFile extends Work {
    id: string;
    server: string;
    ns: string;
    doc: string; // Pkg.Sub.Cls.cls, ROUTINE.mac
    title: string;
    description: string;
    groups: LogGroup[];
    members: LogMember[];
}

interface LogFolder {
    id: string;
    name: string;
    description: string;
    tags?: string[];
    folders: LogFolder[];
    files: LogFile[];
}

interface LogData {
    version: 2;
    folders: LogFolder[];
}

type Node =
    | { kind: 'folder'; id: string; folder: LogFolder; parent?: LogFolder }
    | { kind: 'file'; id: string; folder: LogFolder; file: LogFile }
    | { kind: 'group'; id: string; folder: LogFolder; file: LogFile; group: LogGroup }
    | { kind: 'member'; id: string; folder: LogFolder; file: LogFile; member: LogMember; group?: LogGroup };

type FolderNode = Extract<Node, { kind: 'folder' }>;
type FileNode = Extract<Node, { kind: 'file' }>;
type GroupNode = Extract<Node, { kind: 'group' }>;
type MemberNode = Extract<Node, { kind: 'member' }>;

const STORAGE_KEY = 'isfsNamespaceSearch.codeLog';
const TREE_ID = 'isfsNamespaceSearch.codeLogTree';
const DETAILS_ID = 'isfsNamespaceSearch.codeLogDetails';
const CMD = 'isfsNamespaceSearch.codeLog';
const DRAG_MIME = `application/vnd.code.tree.${TREE_ID.toLowerCase()}`;

const CLASS_MEMBER = /^\s*(ClassMethod|ClientMethod|Method|Query|Trigger)\s+(%?\w+)/i;
const ROUTINE_LABEL = /^(%?[A-Za-z0-9]+)(?:\(|\s|;|$)/;

// Bidi isolation: keeps a Hebrew (right-to-left) label and the English
// name / number next to it from being reordered into each other.
const FSI = '\u2068'; // first-strong isolate: direction from the text itself
const LRI = '\u2066'; // left-to-right isolate
const PDI = '\u2069'; // end of isolate
const isolate = (s: string) => (s ? FSI + s + PDI : s);
const isolateLtr = (s: string) => (s ? LRI + s + PDI : s);

// Folder rows carry this URI so a decoration badge (the file count) can sit
// at the right edge of the row, where VS Code puts Explorer badges.
const DECO_SCHEME = 'isfsnamespacesearch-codelog';

/**
 * The user's Desktop, where export/import dialogs start. On Windows,
 * OneDrive often moves it to %USERPROFILE%\\OneDrive[ - Company]\\Desktop.
 */
function desktopDir(): string {
    const home = os.homedir();
    const candidates: string[] = [];
    try {
        for (const entry of fs.readdirSync(home)) {
            if (/^OneDrive/i.test(entry)) candidates.push(path.join(home, entry, 'Desktop'));
        }
    } catch {
        // ignore
    }
    candidates.push(path.join(home, 'Desktop'));
    return candidates.find((c) => {
        try {
            return fs.statSync(c).isDirectory();
        } catch {
            return false;
        }
    }) ?? home;
}

function newId(): string {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function isIsfs(uri: vscode.Uri | undefined): uri is vscode.Uri {
    return !!uri && (uri.scheme === 'isfs' || uri.scheme === 'isfs-readonly');
}

/** server, namespace and document name of an isfs document. */
function describeIsfsUri(uri: vscode.Uri): { server: string; ns: string; doc: string } {
    const [server, authNs = ''] = decodeURIComponent(uri.authority).split(':');
    const ns = new URLSearchParams(uri.query).get('ns') || authNs;
    const doc = uri.path.replace(/^\//, '').split('/').join('.');
    return { server, ns: ns.toUpperCase(), doc };
}

/** The open isfs workspace folder for this server + namespace, if any. */
function folderFor(server: string, ns: string): vscode.WorkspaceFolder | undefined {
    return (vscode.workspace.workspaceFolders ?? []).find((f) => {
        if (!isIsfs(f.uri)) return false;
        const d = describeIsfsUri(f.uri);
        return d.server.toLowerCase() === server.toLowerCase() && d.ns.toLowerCase() === ns.toLowerCase();
    });
}

function sameDoc(x: LogFile, server: string, ns: string, doc: string): boolean {
    return x.doc.toLowerCase() === doc.toLowerCase() && x.server.toLowerCase() === server.toLowerCase() && x.ns.toLowerCase() === ns.toLowerCase();
}

/** Labels (routines) or methods/queries/triggers (classes) in a document. */
function membersIn(text: string[], isClass: boolean): { name: string; kind: string; line: number }[] {
    const out: { name: string; kind: string; line: number }[] = [];
    text.forEach((t, line) => {
        if (isClass) {
            const m = CLASS_MEMBER.exec(t);
            if (m) out.push({ name: m[2], kind: m[1][0].toUpperCase() + m[1].slice(1), line });
        } else if (!/^ROUTINE\s/i.test(t)) {
            const m = ROUTINE_LABEL.exec(t);
            if (m) out.push({ name: m[1], kind: 'Label', line });
        }
    });
    return out;
}

function memberAt(text: string[], line: number, isClass: boolean) {
    const all = membersIn(text, isClass).filter((m) => m.line <= line);
    return all.length ? all[all.length - 1] : undefined;
}

function isValidFolder(f: any): boolean {
    return (
        typeof f?.name === 'string' &&
        Array.isArray(f.files) &&
        f.files.every((x: any) =>
            typeof x?.doc === 'string' && typeof x?.server === 'string' && typeof x?.ns === 'string' &&
            (x.members === undefined || Array.isArray(x.members))
        ) &&
        (f.folders === undefined || (Array.isArray(f.folders) && f.folders.every(isValidFolder)))
    );
}

function isValidData(d: any): boolean {
    return !!d && Array.isArray(d.folders) && d.folders.every(isValidFolder);
}

/** Fills in anything missing (ids, empty strings, subfolders) - also upgrades version-1 data. */
function normalizeFolder(f: any): LogFolder {
    return {
        id: f.id || newId(),
        name: f.name,
        description: f.description || '',
        tags: normalizeWork(f).tags,
        folders: (f.folders || []).map(normalizeFolder),
        files: f.files.map((x: any) => ({
            id: x.id || newId(),
            server: x.server,
            ns: String(x.ns).toUpperCase(),
            doc: x.doc,
            title: x.title || '',
            description: x.description || '',
            ...normalizeWork(x),
            ...normalizeMembers(x)
        }))
    };
}

/** Status / tags / journal / to-dos / dates, with safe defaults (older logs have none). */
export function normalizeWork(x: any): Work {
    const iso = (v: any) => (typeof v === 'string' && !isNaN(Date.parse(v)) ? v : undefined);
    const tags = Array.isArray(x?.tags) ? x.tags.filter((t: any) => typeof t === 'string' && t.trim()).map(normalizeTag) : [];
    return {
        ...(STATUSES.includes(x?.status) ? { status: x.status as Status } : {}),
        tags: [...new Set<string>(tags)],
        journal: (Array.isArray(x?.journal) ? x.journal : [])
            .filter((j: any) => typeof j?.text === 'string')
            .map((j: any) => ({ id: j.id || newId(), at: iso(j.at) || new Date().toISOString(), text: j.text })),
        todos: (Array.isArray(x?.todos) ? x.todos : [])
            .filter((t: any) => typeof t?.text === 'string')
            .map((t: any) => ({ id: t.id || newId(), text: t.text, done: !!t.done })),
        ...(iso(x?.created) ? { created: iso(x.created) } : {}),
        ...(iso(x?.edited) ? { edited: iso(x.edited) } : {})
    };
}

/** "#Customers " -> "#Customers"; "new tag" -> "#new-tag". */
export function normalizeTag(t: string): string {
    const clean = t.trim().replace(/^#+/, '').replace(/\s+/g, '-');
    return clean ? '#' + clean : '';
}

export function emptyWork(): Work {
    const now = new Date().toISOString();
    return { tags: [], journal: [], todos: [], created: now, edited: now };
}

/** Anything written in the Details panel beyond an empty entry? */
export function hasDetails(x: { title: string; description: string } & Work): boolean {
    return !!(x.title || x.description || x.status || x.tags.length || x.journal.length || x.todos.length);
}

/** Drops status / tags / journal / to-dos (tree exports carry only titles and notes). */
export function stripWork(f: LogFolder): LogFolder {
    const clear = (w: any) => {
        delete w.status;
        w.tags = [];
        w.journal = [];
        w.todos = [];
    };
    f.tags = [];
    f.folders.forEach(stripWork);
    for (const file of f.files) {
        clear(file);
        file.members.forEach(clear);
        file.groups.forEach((g) => (g.tags = []));
    }
    return f;
}

/** Groups and members of a document; a member pointing at a missing group becomes ungrouped. */
function normalizeMembers(x: any): { groups: LogGroup[]; members: LogMember[] } {
    const groups: LogGroup[] = (Array.isArray(x.groups) ? x.groups : [])
        .filter((g: any) => typeof g?.name === 'string')
        .map((g: any) => ({ id: g.id || newId(), name: g.name, description: g.description || '', tags: normalizeWork(g).tags }));
    const ids = new Set(groups.map((g) => g.id));
    const members: LogMember[] = (x.members || []).filter((m: any) => typeof m?.name === 'string').map((m: any) => ({
        id: m.id || newId(),
        name: m.name,
        kind: m.kind || 'Label',
        title: m.title || '',
        description: m.description || '',
        ...normalizeWork(m),
        ...(m.group && ids.has(m.group) ? { group: m.group } : {})
    }));
    return { groups, members };
}

function normalize(d: any): LogData {
    return { version: 2, folders: (d?.folders || []).filter(isValidFolder).map(normalizeFolder) };
}

function countFiles(f: LogFolder): number {
    return f.files.length + f.folders.reduce((n, s) => n + countFiles(s), 0);
}

export function registerCodeLog(context: vscode.ExtensionContext, log: Logger) {
    let data: LogData = normalize(context.globalState.get<any>(STORAGE_KEY, { folders: [] }));
    const nodes = new Map<string, Node>();
    const parentOf = new Map<LogFolder, LogFolder | undefined>();

    const persist = () => context.globalState.update(STORAGE_KEY, data);

    const rebuildIndex = () => {
        nodes.clear();
        parentOf.clear();
        const walk = (folder: LogFolder, parent?: LogFolder) => {
            parentOf.set(folder, parent);
            nodes.set(folder.id, { kind: 'folder', id: folder.id, folder, parent });
            for (const sub of folder.folders) walk(sub, folder);
            for (const file of folder.files) {
                nodes.set(file.id, { kind: 'file', id: file.id, folder, file });
                const groupById = new Map(file.groups.map((g) => [g.id, g]));
                for (const group of file.groups) nodes.set(group.id, { kind: 'group', id: group.id, folder, file, group });
                for (const member of file.members) {
                    nodes.set(member.id, { kind: 'member', id: member.id, folder, file, member, group: member.group ? groupById.get(member.group) : undefined });
                }
            }
        };
        data.folders.forEach((f) => walk(f));
    };
    rebuildIndex();

    /** Folder names from the top down to `folder`. */
    const pathOf = (folder: LogFolder): string[] => {
        const names: string[] = [];
        for (let f: LogFolder | undefined = folder; f; f = parentOf.get(f)) names.unshift(f.name);
        return names;
    };

    /** Every folder, depth-first, with its depth. */
    const allFolders = (): { folder: LogFolder; depth: number }[] => {
        const out: { folder: LogFolder; depth: number }[] = [];
        const walk = (f: LogFolder, depth: number) => {
            out.push({ folder: f, depth });
            f.folders.forEach((s) => walk(s, depth + 1));
        };
        data.folders.forEach((f) => walk(f, 0));
        return out;
    };

    const isInside = (folder: LogFolder, ancestor: LogFolder): boolean => {
        for (let f: LogFolder | undefined = folder; f; f = parentOf.get(f)) if (f === ancestor) return true;
        return false;
    };

    const siblingsOf = (folder: LogFolder): LogFolder[] => parentOf.get(folder)?.folders ?? data.folders;

    // ---- expand / collapse ----
    // Closing a row also closes everything inside it, so reopening shows one
    // clean level. VS Code can't collapse a given row from code, so the rows
    // inside get a new tree id (an epoch suffix) and a collapsed state: VS Code
    // treats them as new rows and uses that state.
    const forcedState = new Map<string, vscode.TreeItemCollapsibleState>();
    const epochs = new Map<string, number>();
    const itemId = (n: Node) => (epochs.get(n.id) ? `${n.id}~${epochs.get(n.id)}` : n.id);
    const childrenOf = (n: Node): Node[] => (provider.getChildren(n) as Node[]) ?? [];
    const hasChildren = (n: Node) => childrenOf(n).length > 0;
    /** Everything starts collapsed; rows without children have no arrow. */
    const stateFor = (n: Node) =>
        !hasChildren(n) ? vscode.TreeItemCollapsibleState.None : forcedState.get(n.id) ?? vscode.TreeItemCollapsibleState.Collapsed;

    // ---- tree ----
    const treeChanged = new vscode.EventEmitter<Node | undefined | void>();
    const provider: vscode.TreeDataProvider<Node> = {
        onDidChangeTreeData: treeChanged.event,
        getParent: (n) => {
            if (n.kind === 'member') return nodes.get(n.group ? n.group.id : n.file.id);
            if (n.kind === 'group') return nodes.get(n.file.id);
            if (n.kind === 'file') return nodes.get(n.folder.id);
            return n.parent ? nodes.get(n.parent.id) : undefined;
        },
        getChildren: (n) => {
            if (!n) return data.folders.map((f) => nodes.get(f.id)!);
            if (n.kind === 'folder') return [...n.folder.folders.map((f) => nodes.get(f.id)!), ...n.folder.files.map((f) => nodes.get(f.id)!)];
            // Groups first, then members not in a group.
            if (n.kind === 'file') return [
                ...n.file.groups.map((g) => nodes.get(g.id)!),
                ...n.file.members.filter((m) => !m.group).map((m) => nodes.get(m.id)!)
            ];
            if (n.kind === 'group') return n.file.members.filter((m) => m.group === n.group.id).map((m) => nodes.get(m.id)!);
            return [];
        },
        getTreeItem: (n) => {
            if (n.kind === 'folder') {
                const empty = !n.folder.folders.length && !n.folder.files.length;
                // Top-level folders are projects: own icon, emphasised name, exportable.
                const isProject = !n.parent;
                const name = isolate(n.folder.name);
                const item = new vscode.TreeItem(
                    isProject ? { label: name, highlights: [[0, name.length]] } : name,
                    stateFor(n)
                );
                item.id = itemId(n);
                item.iconPath = new vscode.ThemeIcon(isProject ? 'project' : 'folder');
                // File count as a right-aligned badge (see the decoration provider).
                item.resourceUri = vscode.Uri.from({ scheme: DECO_SCHEME, path: '/' + n.id });
                if (empty) item.description = 'empty';
                item.tooltip = [pathOf(n.folder).join(' › '), n.folder.description].filter(Boolean).join('\n\n');
                item.contextValue = (isProject ? 'logProject' : 'logFolder');
                return item;
            }
            if (n.kind === 'file') {
                const open = !!folderFor(n.file.server, n.file.ns);
                // Title as the main text when there is one; the document name next to it.
                const item = new vscode.TreeItem(
                    isolate(n.file.title || n.file.doc),
                    stateFor(n)
                );
                item.id = itemId(n);
                const icon = /\.cls$/i.test(n.file.doc) ? 'symbol-class' : 'file-code';
                item.iconPath = open ? new vscode.ThemeIcon(icon) : new vscode.ThemeIcon(icon, new vscode.ThemeColor('disabledForeground'));
                item.description = isolateLtr([open ? '' : '(not open)', n.file.title ? n.file.doc : ''].filter(Boolean).join(' '));
                const md = new vscode.MarkdownString();
                if (n.file.title) md.appendMarkdown(`**${escapeMd(n.file.title)}**\n\n`);
                if (n.file.description) md.appendText(n.file.description + '\n\n');
                md.appendMarkdown(`\`${escapeMd(n.file.doc)}\` · ${escapeMd(n.file.ns)} on ${escapeMd(n.file.server)}`);
                if (!open) md.appendMarkdown(`\n\n_Namespace ${escapeMd(n.file.ns)} on ${escapeMd(n.file.server)} isn't open in this workspace._`);
                item.tooltip = md;
                item.contextValue = (open ? 'logFile' : 'logFileClosed');
                return item;
            }
            if (n.kind === 'group') {
                const count = n.file.members.filter((m) => m.group === n.group.id).length;
                const item = new vscode.TreeItem(
                    isolate(n.group.name),
                    stateFor(n)
                );
                item.id = itemId(n);
                item.iconPath = new vscode.ThemeIcon('layers');
                item.resourceUri = vscode.Uri.from({ scheme: DECO_SCHEME, path: '/' + n.id }); // count badge
                if (!count) item.description = 'empty';
                item.tooltip = [n.group.name, n.group.description].filter(Boolean).join('\n\n');
                item.contextValue = 'logGroup';
                return item;
            }
            const open = !!folderFor(n.file.server, n.file.ns);
            const item = new vscode.TreeItem(isolate(n.member.title || n.member.name), vscode.TreeItemCollapsibleState.None);
            item.id = itemId(n);
            const icon = n.member.kind === 'Label' ? 'symbol-function' : 'symbol-method';
            item.iconPath = open ? new vscode.ThemeIcon(icon) : new vscode.ThemeIcon(icon, new vscode.ThemeColor('disabledForeground'));
            item.description = n.member.title ? isolateLtr(n.member.name) : '';
            item.tooltip = [`${n.member.kind} ${n.member.name}`, n.member.title, n.member.description].filter(Boolean).join('\n\n');
            item.contextValue = open ? 'logMember' : 'logMemberClosed';
            return item;
        }
    };

    const dnd: vscode.TreeDragAndDropController<Node> = {
        dragMimeTypes: [DRAG_MIME],
        // Also accepts a .json file (from Explorer / the desktop) or dragged JSON text: imports it.
        dropMimeTypes: [DRAG_MIME, 'text/uri-list', 'text/plain'],
        handleDrag(source, transfer) {
            // Documents, subfolders, groups and members; projects (top-level folders) stay put.
            const ids = source
                .filter((n) => n.kind === 'file' || n.kind === 'group' || n.kind === 'member' || (n.kind === 'folder' && !!n.parent))
                .map((n) => n.id);
            if (ids.length) transfer.set(DRAG_MIME, new vscode.DataTransferItem(ids));
        },
        async handleDrop(target, transfer) {
            const ids: string[] | undefined = transfer.get(DRAG_MIME)?.value;
            if (!ids?.length) {
                await importDropped(transfer);
                return;
            }
            // Onto a folder: into it. Onto a document/member: into its folder. Onto empty space: top level (folders only).
            const to = target ? target.folder : undefined;
            for (const id of ids) {
                const n = nodes.get(id);
                if (n?.kind === 'file' && to) moveFile(n, to);
                else if (n?.kind === 'folder') moveFolder(n, to);
                else if (n?.kind === 'member') dropMember(n, target);
                else if (n?.kind === 'group') dropGroup(n, target);
            }
            changed();
        }
    };

    /** A file or JSON text dropped onto the tree from outside: import it (tree or log export, whichever it is). */
    async function importDropped(transfer: vscode.DataTransfer) {
        try {
            const uris = ((await transfer.get('text/uri-list')?.asString()) ?? '')
                .split(/\r?\n/)
                .map((x) => x.trim())
                .filter((x) => x && !x.startsWith('#'));
            if (uris.length) {
                const uri = vscode.Uri.parse(uris[0]);
                if (!/\.json$/i.test(uri.path)) {
                    vscode.window.showWarningMessage('Drop a .json export (Projects or Code Log) to import it.');
                    return;
                }
                await importAuto(await readJsonFile(uri));
                return;
            }
            const text = ((await transfer.get('text/plain')?.asString()) ?? '').trim();
            if (text.startsWith('{')) await importAuto({ text, label: 'the dropped JSON' });
        } catch (e: any) {
            vscode.window.showErrorMessage(`Couldn't import the dropped item: ${e?.message || e}`);
        }
    }

    const tree = vscode.window.createTreeView(TREE_ID, {
        treeDataProvider: provider,
        showCollapseAll: true,
        canSelectMany: false,
        dragAndDropController: dnd
    });
    context.subscriptions.push(tree, treeChanged);

    context.subscriptions.push(
        tree.onDidCollapseElement((e) => {
            const closed = e.element;
            let changedAny = false;
            const walk = (x: Node) => {
                for (const c of childrenOf(x)) {
                    if (!hasChildren(c)) continue;
                    forcedState.set(c.id, vscode.TreeItemCollapsibleState.Collapsed);
                    epochs.set(c.id, (epochs.get(c.id) ?? 0) + 1);
                    changedAny = true;
                    walk(c);
                }
            };
            walk(closed);
            if (changedAny) treeChanged.fire(closed);
        }),
        // Opening a row by hand: it stays open after later refreshes.
        tree.onDidExpandElement((e) => forcedState.set(e.element.id, vscode.TreeItemCollapsibleState.Expanded))
    );

    // ---- folder file-count badges ----
    const decoChanged = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    context.subscriptions.push(
        decoChanged,
        vscode.window.registerFileDecorationProvider({
            onDidChangeFileDecorations: decoChanged.event,
            provideFileDecoration(uri) {
                if (uri.scheme !== DECO_SCHEME) return undefined;
                const n = nodes.get(uri.path.slice(1));
                if (n?.kind === 'group') {
                    const count = n.file.members.filter((m) => m.group === n.group.id).length;
                    return count ? new vscode.FileDecoration(count > 99 ? '99' : String(count), `${count} in this group`) : undefined;
                }
                if (n?.kind !== 'folder') return undefined;
                const total = countFiles(n.folder);
                if (!total) return undefined;
                // Badges hold at most 2 characters.
                return new vscode.FileDecoration(total > 99 ? '99' : String(total), `${total} document${total === 1 ? '' : 's'} (including subfolders)`);
            }
        })
    );

    // ---- details panel (Overview + Item) ----
    const details = new CodeLogView(
        context.extensionUri,
        (msg) => onViewMessage(msg).catch((e: any) => log(`Code Log details: ${e?.message || e}`)),
        () => buildState()
    );
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(DETAILS_ID, details, { webviewOptions: { retainContextWhenHidden: true } }));
    let selected: Node | undefined;
    const showDetails = (reason: 'selection' | 'update' = 'update') => details.show(buildState(), reason);
    context.subscriptions.push(
        tree.onDidChangeSelection((e) => {
            selected = e.selection[0];
            showDetails('selection');
        })
    );

    let refreshTimer: NodeJS.Timeout | undefined;
    const changed = (opts: { soon?: boolean } = {}) => {
        rebuildIndex();
        persist();
        decoChanged.fire(undefined);
        if (selected) selected = nodes.get(selected.id);
        if (opts.soon) {
            // Typing in the details panel: refresh the tree a moment later.
            if (refreshTimer) clearTimeout(refreshTimer);
            refreshTimer = setTimeout(() => treeChanged.fire(), 400);
        } else {
            treeChanged.fire();
            showDetails();
        }
    };

    // Namespaces opened or closed: grey-out state changes.
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        treeChanged.fire();
        showDetails();
    }));

    const select = async (id: string | undefined) => {
        const n = id ? nodes.get(id) : undefined;
        if (!n) return;
        try {
            await tree.reveal(n, { select: true, focus: false, expand: true });
        } catch {
            // view not visible yet
        }
        selected = n;
        showDetails('selection');
    };

    // ---- helpers ----
    /**
     * Pick an existing folder (subfolders indented under their parents).
     * Adding documents never creates folders - that's done in the panel.
     */
    const pickFolder = async (placeHolder: string, include: (f: LogFolder) => boolean = () => true): Promise<LogFolder | undefined> => {
        const choices = allFolders().filter(({ folder }) => include(folder));
        if (!choices.length) {
            const go = await vscode.window.showInformationMessage(
                data.folders.length
                    ? 'No suitable folder in Projects.'
                    : 'Create a folder in Projects first (New Folder in its title bar).',
                'Open Code Log'
            );
            if (go) await vscode.commands.executeCommand(`${TREE_ID}.focus`);
            return undefined;
        }
        const picked = await vscode.window.showQuickPick(
            choices.map(({ folder, depth }) => ({
                label: `${' '.repeat(depth)}$(${depth ? 'folder' : 'project'}) ${folder.name}`,
                description: depth ? pathOf(folder).slice(0, -1).join(' › ') : '',
                folder
            })),
            { placeHolder, ignoreFocusOut: true, matchOnDescription: true }
        );
        return picked?.folder;
    };

    const askFolderName = async (title: string, value = '') =>
        (await vscode.window.showInputBox({
            title,
            prompt: 'Folder name (Hebrew, English or both)',
            value,
            ignoreFocusOut: true,
            validateInput: (v) => (v.trim() ? undefined : 'Enter a name')
        }))?.trim();

    const createFolder = async (parent?: LogFolder): Promise<LogFolder | undefined> => {
        const name = await askFolderName(parent ? `New subfolder in "${parent.name}"` : 'New Code Log folder');
        if (!name) return undefined;
        const folder: LogFolder = { id: newId(), name, description: '', folders: [], files: [] };
        (parent ? parent.folders : data.folders).push(folder);
        changed();
        return folder;
    };

    const addFile = (folder: LogFolder, server: string, ns: string, doc: string): LogFile => {
        const existing = folder.files.find((x) => sameDoc(x, server, ns, doc));
        if (existing) return existing;
        const file: LogFile = { id: newId(), server, ns: ns.toUpperCase(), doc, title: '', description: '', groups: [], members: [], ...emptyWork() };
        folder.files.push(file);
        return file;
    };

    const addMember = (file: LogFile, name: string, kind: string, title = ''): LogMember => {
        const existing = file.members.find((m) => m.name === name);
        if (existing) return existing;
        const member: LogMember = { id: newId(), name, kind, title, description: '', ...emptyWork() };
        file.members.push(member);
        return member;
    };

    const moveFile = (n: FileNode, to: LogFolder) => {
        if (n.folder === to) return;
        if (to.files.some((x) => sameDoc(x, n.file.server, n.file.ns, n.file.doc))) {
            vscode.window.showWarningMessage(`${n.file.doc} is already in "${to.name}".`);
            return;
        }
        n.folder.files = n.folder.files.filter((x) => x !== n.file);
        to.files.push(n.file);
    };

    /** Moves a folder under `to`, or to the top level when `to` is undefined. */
    const moveFolder = (n: FolderNode, to: LogFolder | undefined) => {
        const folder = n.folder;
        if (to && isInside(to, folder)) {
            vscode.window.showWarningMessage(`Can't move "${folder.name}" into itself.`);
            return;
        }
        if (parentOf.get(folder) === to) return;
        const from = siblingsOf(folder);
        from.splice(from.indexOf(folder), 1);
        (to ? to.folders : data.folders).push(folder);
    };

    /** Member dropped: onto a group (join it), a member (reorder next to it), or its document (ungroup). */
    const dropMember = (n: MemberNode, target: Node | undefined) => {
        if (!target || target.kind === 'folder') return;
        if (target.file !== n.file) {
            vscode.window.showWarningMessage('Labels and methods can only be arranged within their own document.');
            return;
        }
        const list = n.file.members;
        if (target.kind === 'member') {
            if (target.member === n.member) return;
            list.splice(list.indexOf(n.member), 1);
            list.splice(list.indexOf(target.member), 0, n.member); // just before the target
            setGroup(n.member, target.member.group);
        } else {
            // Onto a group or the document: to the end of that list.
            list.splice(list.indexOf(n.member), 1);
            list.push(n.member);
            setGroup(n.member, target.kind === 'group' ? target.group.id : undefined);
        }
    };

    /** Group dropped onto another group of the same document: placed just before it. */
    const dropGroup = (n: GroupNode, target: Node | undefined) => {
        if (!target || target.kind === 'folder' || target.file !== n.file) return;
        const before = target.kind === 'group' ? target.group : target.kind === 'member' ? target.group : undefined;
        if (before === n.group) return;
        const list = n.file.groups;
        list.splice(list.indexOf(n.group), 1);
        if (before) list.splice(list.indexOf(before), 0, n.group);
        else list.push(n.group);
    };

    const setGroup = (m: LogMember, groupId: string | undefined) => {
        if (groupId) m.group = groupId;
        else delete m.group;
    };

    const askGroupName = async (title: string, value = '') =>
        (await vscode.window.showInputBox({
            title,
            prompt: 'Group name (Hebrew, English or both)',
            value,
            ignoreFocusOut: true,
            validateInput: (v) => (v.trim() ? undefined : 'Enter a name')
        }))?.trim();

    const createGroup = async (file: LogFile): Promise<LogGroup | undefined> => {
        const name = await askGroupName(`New group in ${file.doc}`);
        if (!name) return undefined;
        const group: LogGroup = { id: newId(), name, description: '' };
        file.groups.push(group);
        return group;
    };

    const openNode = async (n: Node | undefined) => {
        if (!n || n.kind === 'folder' || n.kind === 'group') return;
        const ws = folderFor(n.file.server, n.file.ns);
        if (!ws) {
            vscode.window.showInformationMessage(
                `Namespace ${n.file.ns} on server ${n.file.server} isn't open in this workspace. Add it to open ${n.file.doc}.`
            );
            return;
        }
        const uri = docNameToUri(ws.uri, n.file.doc);
        let doc: vscode.TextDocument;
        try {
            doc = await vscode.workspace.openTextDocument(uri);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Couldn't open ${n.file.doc}: ${e?.message || e}`);
            return;
        }
        let line = 0;
        if (n.kind === 'member') {
            const found = findLabelLine(doc.getText().split(/\r?\n/), n.member.name, /\.cls$/i.test(n.file.doc));
            if (found === null) {
                vscode.window.showWarningMessage(`${n.member.name} wasn't found in ${n.file.doc} (renamed or removed?). Opened at the top.`);
            } else line = found;
        }
        const editor = await vscode.window.showTextDocument(doc, { preview: false });
        const pos = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), line ? vscode.TextEditorRevealType.AtTop : vscode.TextEditorRevealType.Default);
    };

    const askTitle = (what: string) =>
        vscode.window.showInputBox({
            title: `Title for ${what}`,
            prompt: 'A short title (optional). Add longer notes in the Code Log panel.',
            ignoreFocusOut: true
        });

    // ---- details panel: state ----
    const countMembers = (f: LogFolder): number =>
        f.files.reduce((n, x) => n + x.members.length, 0) + f.folders.reduce((n, sub) => n + countMembers(sub), 0);

    /** Everything the Details page needs: the selected item and the whole log for the Overview. */
    const buildState = () => {
        const tagCounts = new Map<string, number>();
        const countTags = (tags: string[] | undefined) => {
            (tags ?? []).forEach((t) => tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1));
            return tags ?? [];
        };
        const work = (w: Work & { title: string; description: string }) => {
            w.tags.forEach((t) => tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1));
            const open = w.todos.filter((t) => !t.done);
            return { status: w.status, tags: w.tags, openTodos: open.length, todoTexts: open.slice(0, 6).map((t) => t.text), title: w.title, notes: w.description };
        };
        const ovMember = (m: LogMember) => ({ id: m.id, kind: 'member', label: m.title || m.name, sub: m.title ? m.name : undefined, ...work(m) });
        const ovFile = (x: LogFile) => ({
            id: x.id, kind: 'file', label: x.title || x.doc, sub: x.title ? x.doc : undefined, ...work(x),
            children: [
                ...x.groups.map((g) => ({ id: g.id, kind: 'group', label: g.name, notes: g.description, tags: countTags(g.tags), children: x.members.filter((m) => m.group === g.id).map(ovMember) })),
                ...x.members.filter((m) => !m.group).map(ovMember)
            ]
        });
        const ovFolder = (f: LogFolder, project: boolean): any => ({
            id: f.id, kind: 'folder', label: f.name, project, notes: f.description, tags: countTags(f.tags),
            children: [...f.folders.map((x) => ovFolder(x, false)), ...f.files.map(ovFile)]
        });
        const projects = data.folders.map((f) => ovFolder(f, true));
        return {
            selected: selected ? detailOf(selected) : null,
            projects,
            tags: [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, count]) => ({ tag, count }))
        };
    };

    /** One row of the clickable Contents / Members list in the Info tab. */
    const entryOfMember = (f: LogFile, m: LogMember, depth = 0) => ({
        id: m.id, kind: 'member', label: m.title || m.name, sub: m.title ? m.name : '', type: m.kind, status: m.status,
        openTodos: m.todos.filter((t) => !t.done).length, canOpen: !!folderFor(f.server, f.ns), depth
    });
    const membersOfFile = (f: LogFile) => {
        const out: any[] = [];
        for (const g of f.groups) {
            const ms = f.members.filter((m) => m.group === g.id);
            out.push({ id: g.id, kind: 'group', label: g.name, sub: '', type: `Group · ${ms.length}`, depth: 0 });
            ms.forEach((m) => out.push(entryOfMember(f, m, 1)));
        }
        const known = new Set(f.groups.map((g) => g.id));
        f.members.filter((m) => !m.group || !known.has(m.group)).forEach((m) => out.push(entryOfMember(f, m)));
        return out;
    };

    /** The way up: every folder above, then the document and group for members. Each one is clickable. */
    const crumbsOf = (n: Node) => {
        const out: { id: string; label: string; kind: string }[] = [];
        let f: LogFolder | undefined = n.kind === 'folder' ? parentOf.get(n.folder) : n.folder;
        for (; f; f = parentOf.get(f)) out.unshift({ id: f.id, label: f.name, kind: 'folder' });
        if (n.kind === 'group' || n.kind === 'member') out.push({ id: n.file.id, label: n.file.title || n.file.doc, kind: 'file' });
        if (n.kind === 'member' && n.group) out.push({ id: n.group.id, label: n.group.name, kind: 'group' });
        return out;
    };

    const detailOf = (n: Node) => {
        if (n.kind === 'folder') {
            const contents = [
                ...n.folder.folders.map((f) => ({ id: f.id, kind: 'folder', label: f.name, sub: '', type: `Folder · ${countFiles(f)} docs`, depth: 0 })),
                ...n.folder.files.map((f) => ({
                    id: f.id, kind: 'file', label: f.title || f.doc, sub: f.title ? f.doc : '', status: f.status,
                    type: /\.cls$/i.test(f.doc) ? 'Class' : (f.doc.split('.').pop() || '').toUpperCase() || 'Routine',
                    docType: /\.cls$/i.test(f.doc) ? 'cls' : 'rtn', openTodos: f.todos.filter((t) => !t.done).length,
                    canOpen: !!folderFor(f.server, f.ns), depth: 0
                }))
            ];
            return {
                id: n.id, kind: 'folder', work: false, name: n.folder.name, description: n.folder.description, isProject: !n.parent,
                tags: n.folder.tags ?? [], crumbs: crumbsOf(n),
                path: pathOf(n.folder).slice(0, -1), counts: { docs: countFiles(n.folder), members: countMembers(n.folder) }, contents
            };
        }
        if (n.kind === 'group') {
            const ms = n.file.members.filter((m) => m.group === n.group.id);
            return {
                id: n.id, kind: 'group', work: false, name: n.group.name, description: n.group.description, doc: n.file.doc,
                tags: n.group.tags ?? [], crumbs: crumbsOf(n),
                path: [...pathOf(n.folder), n.file.doc], counts: { members: ms.length }, contents: ms.map((m) => entryOfMember(n.file, m))
            };
        }
        const w = n.kind === 'file' ? n.file : n.member;
        const group = n.kind === 'member' && n.member.group ? n.file.groups.find((g) => g.id === n.member.group)?.name : undefined;
        return {
            id: n.id, kind: n.kind, work: true, title: w.title, description: w.description,
            status: w.status, tags: w.tags, journal: w.journal, todos: w.todos, created: w.created, edited: w.edited,
            doc: n.file.doc, docType: /\.cls$/i.test(n.file.doc) ? 'cls' : 'rtn',
            member: n.kind === 'member' ? { name: n.member.name, kind: n.member.kind } : undefined,
            group, ns: n.file.ns, server: n.file.server, nsOpen: !!folderFor(n.file.server, n.file.ns),
            path: pathOf(n.folder), crumbs: crumbsOf(n),
            contents: n.kind === 'file' ? membersOfFile(n.file) : undefined
        };
    };

    /** Where a node keeps its tags (folders and groups too). */
    const tagHolder = (n: Node): { tags?: string[] } => {
        const x: { tags?: string[] } = n.kind === 'folder' ? n.folder : n.kind === 'group' ? n.group : n.kind === 'file' ? n.file : n.member;
        x.tags ??= [];
        return x;
    };

    // ---- details panel: edits ----
    const onViewMessage = async (msg: any) => {
        const n = typeof msg?.id === 'string' ? nodes.get(msg.id) : undefined;
        if (msg?.type === 'select') {
            await select(msg.id);
            return;
        }
        if (!n) return;
        if (msg.type === 'open') {
            if (n.kind === 'folder' || n.kind === 'group') return;
            await openNode(msg.target === 'file' ? nodes.get(n.file.id) : n);
            return;
        }
        const w: Work | undefined = n.kind === 'file' ? n.file : n.kind === 'member' ? n.member : undefined;
        const text = typeof msg.text === 'string' ? msg.text.trim() : '';
        switch (msg.type) {
            case 'edit': {
                if (typeof msg.value !== 'string') return;
                const target: any = n.kind === 'folder' ? n.folder : n.kind === 'group' ? n.group : n.kind === 'file' ? n.file : n.member;
                if (msg.field === 'name') {
                    if ((n.kind !== 'folder' && n.kind !== 'group') || !msg.value.trim()) return;
                } else if (msg.field === 'title') {
                    if (!w) return;
                } else if (msg.field !== 'description') return;
                target[msg.field] = msg.value;
                if (w) w.edited = new Date().toISOString();
                changed({ soon: true });
                return;
            }
            case 'setStatus':
                if (!w) return;
                if (STATUSES.includes(msg.status)) w.status = msg.status;
                else delete w.status;
                break;
            case 'addTag': {
                const t = normalizeTag(String(msg.tag ?? ''));
                const holder = tagHolder(n);
                if (!t || holder.tags!.includes(t)) return;
                holder.tags!.push(t);
                break;
            }
            case 'removeTag': {
                const holder = tagHolder(n);
                holder.tags = holder.tags!.filter((t) => t !== msg.tag);
                break;
            }
            case 'renameTag': {
                // Renames the tag everywhere in the log.
                const t = normalizeTag(String(msg.to ?? ''));
                if (!t || !msg.from) return;
                const fix = (x: { tags?: string[] }) => {
                    if (x.tags?.includes(msg.from)) x.tags = [...new Set(x.tags.map((y) => (y === msg.from ? t : y)))];
                };
                const walk = (f: LogFolder) => {
                    fix(f);
                    f.folders.forEach(walk);
                    for (const file of f.files) {
                        fix(file);
                        file.groups.forEach(fix);
                        file.members.forEach(fix);
                    }
                };
                data.folders.forEach(walk);
                break;
            }
            case 'addJournal':
                if (!w || !text) return;
                w.journal.push({ id: newId(), at: new Date().toISOString(), text });
                break;
            case 'editJournal': {
                const j = w?.journal.find((x) => x.id === msg.entryId);
                if (!j || !text) return;
                j.text = text;
                break;
            }
            case 'deleteJournal':
                if (!w) return;
                w.journal = w.journal.filter((x) => x.id !== msg.entryId);
                break;
            case 'restoreJournal': {
                const e = normalizeWork({ journal: [msg.entry] }).journal[0];
                if (!w || !e || w.journal.some((x) => x.id === e.id)) return;
                w.journal.splice(Math.min(Math.max(0, msg.index | 0), w.journal.length), 0, e);
                break;
            }
            case 'addTodo':
                if (!w || !text) return;
                w.todos.push({ id: newId(), text, done: false });
                break;
            case 'editTodo': {
                const t = w?.todos.find((x) => x.id === msg.todoId);
                if (!t || !text) return;
                t.text = text;
                break;
            }
            case 'toggleTodo': {
                const t = w?.todos.find((x) => x.id === msg.todoId);
                if (!t) return;
                t.done = !t.done;
                break;
            }
            case 'deleteTodo':
                if (!w) return;
                w.todos = w.todos.filter((x) => x.id !== msg.todoId);
                break;
            case 'restoreTodo': {
                const t = normalizeWork({ todos: [msg.todo] }).todos[0];
                if (!w || !t || w.todos.some((x) => x.id === t.id)) return;
                w.todos.splice(Math.min(Math.max(0, msg.index | 0), w.todos.length), 0, t);
                break;
            }
            case 'moveTodo': {
                if (!w) return;
                const from = w.todos.findIndex((x) => x.id === msg.todoId);
                if (from < 0) return;
                const [t] = w.todos.splice(from, 1);
                const to = w.todos.findIndex((x) => x.id === msg.beforeId);
                w.todos.splice(to < 0 ? w.todos.length : to, 0, t);
                break;
            }
            default:
                return;
        }
        if (w) w.edited = new Date().toISOString();
        changed();
    };

    // ---- commands ----
    const nodeArg = (n?: Node) => n ?? selected;
    const reg = (id: string, fn: (...args: any[]) => any) =>
        context.subscriptions.push(
            vscode.commands.registerCommand(`${CMD}.${id}`, async (...args: any[]) => {
                try {
                    await fn(...args);
                } catch (e: any) {
                    log(`Code Log ${id} failed: ${e?.message || e}`);
                    vscode.window.showErrorMessage(`Code Log: ${e?.message || e}`);
                }
            })
        );

    reg('newFolder', async () => {
        const f = await createFolder();
        if (f) await select(f.id);
    });

    reg('newSubfolder', async (n?: Node) => {
        n = nodeArg(n);
        if (n?.kind !== 'folder') return;
        const f = await createFolder(n.folder);
        if (f) await select(f.id);
    });

    reg('renameFolder', async (n?: Node) => {
        n = nodeArg(n);
        if (n?.kind !== 'folder') return;
        const name = await askFolderName('Rename folder', n.folder.name);
        if (!name) return;
        n.folder.name = name;
        changed();
    });

    reg('addFiles', async (n?: Node) => {
        n = nodeArg(n);
        const folder = n ? n.folder : await pickFolder('Add documents to which folder?');
        if (!folder) return;
        const chosen = await chooseDocuments(context, log, `Add to "${folder.name}"`);
        if (!chosen) return;
        const { server, ns } = describeIsfsUri(chosen.folder.uri);
        const added = chosen.docs.map((doc) => addFile(folder, server, ns, doc));
        changed();
        await select(added[0]?.id);
    });

    /** Adds labels / methods not logged yet, picked from the document's source (or typed). */
    const addNewMembers = async (file: LogFile, intoGroup?: LogGroup) => {
        const isClass = /\.cls$/i.test(file.doc);
        const ws = folderFor(file.server, file.ns);
        const picks: { name: string; kind: string }[] = [];
        let askName = !ws;
        if (ws) {
            try {
                const text = (await vscode.workspace.openTextDocument(docNameToUri(ws.uri, file.doc))).getText().split(/\r?\n/);
                const logged = new Set(file.members.map((m) => m.name));
                const chosen = await vscode.window.showQuickPick(
                    [
                        ...membersIn(text, isClass)
                            .filter((m) => !logged.has(m.name))
                            .map((m) => ({ label: m.name, description: `${m.kind} · line ${m.line + 1}`, m })),
                        { label: '$(edit) Type a name...', description: '', m: undefined }
                    ],
                    {
                        canPickMany: true,
                        placeHolder: `Which ${isClass ? 'methods' : 'labels'} of ${file.doc} to log${intoGroup ? ` in "${intoGroup.name}"` : ''}?`,
                        ignoreFocusOut: true
                    }
                );
                if (!chosen?.length) return;
                for (const c of chosen) if (c.m) picks.push({ name: c.m.name, kind: c.m.kind });
                askName = chosen.some((c) => !c.m);
            } catch (e: any) {
                log(`Code Log: couldn't read ${file.doc}: ${e?.message || e}`);
                askName = true;
            }
        }
        if (askName) {
            const typed = (await vscode.window.showInputBox({
                prompt: ws ? 'Label or method name' : `Label or method name in ${file.doc} (its namespace isn't open, so it can't be listed)`,
                ignoreFocusOut: true
            }))?.trim();
            if (typed) picks.push({ name: typed, kind: isClass ? 'Method' : 'Label' });
        }
        if (!picks.length) return;
        const added = picks.map((p) => addMember(file, p.name, p.kind));
        if (intoGroup) added.forEach((m) => (m.group = intoGroup.id));
        changed();
        await select(added[0].id);
    };

    /**
     * + on a group: tick which of the document's logged members belong in it
     * (unticking takes them out, they stay logged). The last entry adds members
     * not logged yet, straight into the group.
     */
    const chooseGroupMembers = async (file: LogFile, group: LogGroup) => {
        const groupName = (id?: string) => file.groups.find((g) => g.id === id)?.name;
        type Item = vscode.QuickPickItem & { m?: LogMember; addNew?: boolean };
        const items: Item[] = file.members.map((m) => {
            const elsewhere = m.group && m.group !== group.id ? groupName(m.group) : undefined;
            return {
                label: m.title || m.name,
                description: [m.title ? m.name : '', elsewhere ? `· in ${elsewhere}` : ''].filter(Boolean).join(' '),
                picked: m.group === group.id,
                m
            };
        });
        items.push({ label: '$(add) Add labels / methods not logged yet...', description: `from ${file.doc}`, addNew: true });
        const chosen = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            placeHolder: `Which logged members belong in "${group.name}"? (ticked = in the group)`,
            matchOnDescription: true,
            ignoreFocusOut: true
        });
        if (!chosen) return;
        const inGroup = new Set(chosen.filter((c) => c.m).map((c) => c.m!));
        let changes = 0;
        for (const m of file.members) {
            if (inGroup.has(m) && m.group !== group.id) {
                m.group = group.id; // joins (or moves here from another group)
                changes++;
            } else if (!inGroup.has(m) && m.group === group.id) {
                delete m.group; // unticked: ungrouped, still logged
                changes++;
            }
        }
        if (changes) {
            changed();
            await select(group.id);
        }
        if (chosen.some((c) => c.addNew)) await addNewMembers(file, group);
    };

    reg('chooseGroupMembers', async (n?: Node) => {
        n = nodeArg(n);
        if (n?.kind === 'group') await chooseGroupMembers(n.file, n.group);
    });

    reg('addMembers', async (n?: Node) => {
        n = nodeArg(n);
        if (n?.kind === 'group') return chooseGroupMembers(n.file, n.group);
        if (n?.kind !== 'file' && n?.kind !== 'member') return;
        return addNewMembers(n.file);
    });

    reg('addFromEditor', async (uri?: vscode.Uri) => {
        const editor = vscode.window.activeTextEditor;
        const target = isIsfs(uri) ? uri : editor?.document.uri;
        if (!isIsfs(target)) {
            vscode.window.showInformationMessage('Code Log works with server-side (isfs) documents.');
            return;
        }
        const { server, ns, doc } = describeIsfsUri(target);
        const isClass = /\.cls$/i.test(doc);
        let member: { name: string; kind: string } | undefined;
        if (editor && editor.document.uri.toString() === target.toString()) {
            member = memberAt(editor.document.getText().split(/\r?\n/), editor.selection.active.line, isClass);
        }

        let addMemberToo = false;
        if (member) {
            const choice = await vscode.window.showQuickPick(
                [
                    { label: `$(symbol-method) ${member.name}`, description: `${member.kind} in ${doc}`, m: true },
                    { label: `$(file-code) ${doc}`, description: 'The whole document', m: false }
                ],
                { placeHolder: 'Add what to the Code Log?', ignoreFocusOut: true }
            );
            if (!choice) return;
            addMemberToo = choice.m;
        }

        const hasDoc = (f: LogFolder) => f.files.some((x) => sameDoc(x, server, ns, doc));
        let folder: LogFolder | undefined;
        if (addMemberToo) {
            // A member goes under its document: use the folder(s) that already have it.
            const holders = allFolders().map((x) => x.folder).filter(hasDoc);
            folder =
                holders.length === 1 ? holders[0]
                : holders.length > 1 ? await pickFolder(`${doc} is in several folders. Add ${member!.name} to which?`, hasDoc)
                : await pickFolder(`Add ${member!.name} (${doc}) to which folder?`);
        } else {
            folder = await pickFolder(`Add ${doc} to which folder?`, (f) => !hasDoc(f));
        }
        if (!folder) return;

        const title = await askTitle(addMemberToo ? member!.name : doc);
        if (title === undefined) return;
        const file = addFile(folder, server, ns, doc);
        let addedId: string;
        if (addMemberToo) {
            addedId = addMember(file, member!.name, member!.kind, title.trim()).id;
        } else {
            if (title.trim()) file.title = title.trim();
            addedId = file.id;
        }
        changed();
        await vscode.commands.executeCommand(`${TREE_ID}.focus`);
        await select(addedId);
    });

    reg('open', (n?: Node) => openNode(nodeArg(n)));

    reg('newGroup', async (n?: Node) => {
        n = nodeArg(n);
        if (!n || n.kind === 'folder') return;
        const g = await createGroup(n.file);
        if (!g) return;
        changed();
        await select(g.id);
    });

    reg('renameGroup', async (n?: Node) => {
        n = nodeArg(n);
        if (n?.kind !== 'group') return;
        const name = await askGroupName('Rename group', n.group.name);
        if (!name) return;
        n.group.name = name;
        changed();
    });

    reg('moveToGroup', async (n?: Node) => {
        n = nodeArg(n);
        if (n?.kind !== 'member') return;
        const member = n.member;
        const file = n.file;
        const NEW = { label: '$(add) New group...', id: 'new' };
        const NONE = { label: '$(circle-slash) No group', id: '' };
        const picked = await vscode.window.showQuickPick(
            [
                ...file.groups.filter((g) => g.id !== member.group).map((g) => ({ label: `$(layers) ${g.name}`, id: g.id })),
                ...(member.group ? [NONE] : []),
                NEW
            ],
            { placeHolder: `Put ${member.name} in which group?`, ignoreFocusOut: true }
        );
        if (!picked) return;
        let groupId = picked.id || undefined;
        if (picked === NEW) {
            const g = await createGroup(file);
            if (!g) return;
            groupId = g.id;
        }
        // To the end of its new list.
        file.members.splice(file.members.indexOf(member), 1);
        file.members.push(member);
        setGroup(member, groupId);
        changed();
        await select(member.id);
    });

    /** Deep copy of a document entry, with fresh ids. */
    const cloneFile = (f: LogFile): LogFile => {
        const copy: LogFile = JSON.parse(JSON.stringify(f));
        reIdFile(copy);
        return copy;
    };

    /** Deep copy of a folder and everything in it, with fresh ids. */
    const cloneFolder = (f: LogFolder): LogFolder => {
        const copy: LogFolder = JSON.parse(JSON.stringify(f));
        reId(copy);
        return copy;
    };

    /**
     * Move or copy a document or a (sub)folder. Projects (top-level
     * folders) stay where they are: they aren't offered either action.
     */
    const relocate = async (n: Node | undefined, mode: 'move' | 'copy') => {
        const verb = mode === 'move' ? 'Move' : 'Copy';
        if (n?.kind === 'file') {
            const file = n.file;
            const from = n.folder;
            const to = await pickFolder(
                `${verb} ${file.doc} to which folder?`,
                (f) => f !== from && !f.files.some((x) => sameDoc(x, file.server, file.ns, file.doc))
            );
            if (!to) return;
            if (mode === 'move') {
                moveFile(n, to);
                changed();
                await select(n.id);
            } else {
                const copy = cloneFile(file);
                to.files.push(copy);
                changed();
                await select(copy.id);
            }
            return;
        }
        if (n?.kind !== 'folder' || !n.parent) return; // documents and subfolders only
        const folder = n.folder;
        const currentParent = parentOf.get(folder);
        const TOP = { label: '$(root-folder) Top level (as a new project)', folder: undefined as LogFolder | undefined };
        const targets = allFolders().filter(({ folder: f }) => !isInside(f, folder) && (mode === 'copy' || f !== currentParent));
        const picked = await vscode.window.showQuickPick(
            [
                TOP,
                ...targets.map(({ folder: f, depth }) => ({
                    label: `${'\u2003'.repeat(depth)}$(${depth ? 'folder' : 'project'}) ${f.name}`,
                    folder: f as LogFolder | undefined
                }))
            ],
            { placeHolder: `${verb} "${folder.name}" into which folder?`, ignoreFocusOut: true }
        );
        if (!picked) return;
        if (mode === 'move') {
            moveFolder(n, picked.folder);
            changed();
            await select(n.id);
            return;
        }
        const copy = cloneFolder(folder);
        const siblings = picked.folder ? picked.folder.folders : data.folders;
        if (siblings.some((f) => f.name === copy.name)) copy.name = `${copy.name} (copy)`;
        siblings.push(copy);
        changed();
        await select(copy.id);
    };

    reg('move', (n?: Node) => relocate(nodeArg(n), 'move'));
    reg('copy', (n?: Node) => relocate(nodeArg(n), 'copy'));

    reg('remove', async (n?: Node) => {
        n = nodeArg(n);
        if (!n) return;
        if (n.kind === 'folder') {
            const files = countFiles(n.folder);
            const subs = allFolders().filter(({ folder }) => folder !== n!.folder && isInside(folder, (n as FolderNode).folder)).length;
            const extra = [subs ? `${subs} subfolder(s)` : '', files ? `${files} logged document(s)` : ''].filter(Boolean).join(' and ');
            const ok = await vscode.window.showWarningMessage(
                `Delete folder "${n.folder.name}"${extra ? ` with its ${extra}` : ''}?`,
                { modal: true },
                'Delete'
            );
            if (ok !== 'Delete') return;
            const siblings = siblingsOf(n.folder);
            siblings.splice(siblings.indexOf(n.folder), 1);
        } else if (n.kind === 'file') {
            const ok = await vscode.window.showWarningMessage(
                `Remove ${n.file.doc} from "${n.folder.name}"${n.file.members.length ? ` with its ${n.file.members.length} logged member(s)` : ''}?`,
                { modal: true },
                'Remove'
            );
            if (ok !== 'Remove') return;
            n.folder.files = n.folder.files.filter((x) => x !== (n as FileNode).file);
        } else if (n.kind === 'group') {
            const group = n.group;
            const inside = n.file.members.filter((m) => m.group === group.id);
            if (inside.length) {
                const ok = await vscode.window.showWarningMessage(
                    `Remove group "${group.name}"? Its ${inside.length} label(s) / method(s) stay in the document, ungrouped.`,
                    { modal: true },
                    'Remove group'
                );
                if (ok !== 'Remove group') return;
            }
            inside.forEach((m) => delete m.group);
            n.file.groups = n.file.groups.filter((g) => g !== group);
        } else {
            const member = n.member;
            n.file.members = n.file.members.filter((m) => m !== member);
        }
        if (selected?.id === n.id) selected = undefined;
        changed();
    });

    /** Save to a file or copy to the clipboard. Returns where it went ("to C:\\x.json" / "to the clipboard"). */
    const saveJson = async (title: string, fileName: string, payload: unknown): Promise<string | undefined> => {
        const how = await vscode.window.showQuickPick(
            [
                { label: '$(save) Save to file…', id: 'file' },
                { label: '$(copy) Copy to clipboard', id: 'clip', detail: 'Paste it anywhere, e.g. into Import → From clipboard on another machine' }
            ],
            { title, placeHolder: 'Export to…' }
        );
        if (!how) return undefined;
        const json = JSON.stringify(payload, null, 2);
        if (how.id === 'clip') {
            await vscode.env.clipboard.writeText(json);
            return 'to the clipboard';
        }
        const target = await vscode.window.showSaveDialog({
            title,
            defaultUri: vscode.Uri.file(path.join(desktopDir(), fileName)),
            filters: { JSON: ['json'] }
        });
        if (!target) return undefined;
        await vscode.workspace.fs.writeFile(target, Buffer.from(json, 'utf8'));
        return `to ${target.fsPath}`;
    };

    // ---- where imported JSON comes from: clipboard, a paste tab, or a file ----
    type JsonSource = { text: string; label: string };
    const readJsonFile = async (uri: vscode.Uri): Promise<JsonSource> => ({
        text: Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'),
        label: uri.fsPath
    });

    /** The paste tab: an empty JSON editor with an Import button (editor title) and a notification button. */
    const pasteWaiters = new Map<string, (ok: boolean) => void>();
    const syncPasteContext = () => vscode.commands.executeCommand('setContext', 'isfsNamespaceSearch.codeLogPasteDocs', [...pasteWaiters.keys()]);
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((d) => pasteWaiters.get(d.uri.toString())?.(false)));
    const pasteJson = async (title: string): Promise<JsonSource | undefined> => {
        const doc = await vscode.workspace.openTextDocument({ language: 'json', content: '' });
        await vscode.window.showTextDocument(doc, { preview: false });
        const key = doc.uri.toString();
        const ok = await new Promise<boolean>((resolve) => {
            pasteWaiters.set(key, resolve);
            syncPasteContext();
            vscode.window
                .showInformationMessage(`${title}: paste the JSON into the new tab, then click Import (also at the top right of the tab).`, 'Import', 'Cancel')
                .then((b) => resolve(b === 'Import'));
        });
        pasteWaiters.delete(key);
        syncPasteContext();
        if (!ok) return undefined;
        const text = doc.getText();
        // Close the tab without a "save?" question.
        const ed = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === key);
        if (ed) {
            await vscode.window.showTextDocument(ed.document, ed.viewColumn);
            await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        }
        return text.trim() ? { text, label: 'the pasted JSON' } : undefined;
    };
    reg('importPasted', (uri?: vscode.Uri) => {
        const key = (uri ?? vscode.window.activeTextEditor?.document.uri)?.toString();
        if (key) pasteWaiters.get(key)?.(true);
    });

    const chooseJsonSource = async (title: string): Promise<JsonSource | undefined> => {
        const how = await vscode.window.showQuickPick(
            [
                { label: '$(clippy) From clipboard', id: 'clip', detail: 'Copy the JSON text (Ctrl+C) first' },
                { label: '$(edit) Paste JSON…', id: 'paste', detail: 'Opens an empty tab to paste into' },
                { label: '$(folder-opened) From file…', id: 'file' }
            ],
            { title, placeHolder: 'Import from…' }
        );
        if (!how) return undefined;
        if (how.id === 'paste') return pasteJson(title);
        if (how.id === 'file') {
            const picked = await vscode.window.showOpenDialog({
                title,
                defaultUri: vscode.Uri.file(desktopDir()),
                canSelectMany: false,
                filters: { JSON: ['json'] }
            });
            return picked?.[0] ? readJsonFile(picked[0]) : undefined;
        }
        const text = (await vscode.env.clipboard.readText()).trim();
        // A copied file path ("Copy as path" in Explorer, quotes and all) reads that file.
        const asPath = text.replace(/^"(.*)"$/, '$1');
        if (/\.json$/i.test(asPath) && !asPath.includes('\n')) {
            try {
                return await readJsonFile(vscode.Uri.file(asPath));
            } catch {
                // not a readable path - treat it as text below
            }
        }
        if (!text) {
            vscode.window.showWarningMessage(
                'The clipboard has no text. Copy the JSON content itself (open the file, Ctrl+A, Ctrl+C) - a file copied in Explorer can\'t be read from the clipboard. Or use From file… / drop the file onto the Projects tree.'
            );
            return undefined;
        }
        return { text, label: 'the clipboard' };
    };

    const parseJson = (src: JsonSource): any => JSON.parse(src.text.replace(/^\uFEFF/, ''));

    /** Whatever kind of export it is, run the matching import (tree or log). */
    const importAuto = async (src: JsonSource) => {
        let parsed: any;
        try {
            parsed = parseJson(src);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Couldn't import ${src.label}: not valid JSON (${e?.message || e}).`);
            return;
        }
        if (parsed?.format === LOG_FORMAT) await runImportLog(src);
        else await runImport(src);
    };

    reg('export', async () => {
        const target = await saveJson('Export Code Log', 'code-log.json', {
            version: 2,
            scope: 'log',
            folders: data.folders.map((f) => stripWork(cloneFolderRaw(f)))
        });
        if (target) vscode.window.showInformationMessage(`Code Log exported ${target}.`);
    });

    // A project export is a log holding just that project, so Import reads both.
    reg('exportProject', async (n?: Node) => {
        n = nodeArg(n);
        if (n?.kind !== 'folder' || n.parent) return;
        const safeName = n.folder.name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'project';
        const target = await saveJson(`Export project "${n.folder.name}"`, `${safeName}.json`, {
            version: 2,
            scope: 'project',
            folders: [stripWork(cloneFolderRaw(n.folder))]
        });
        if (target) vscode.window.showInformationMessage(`Project "${n.folder.name}" exported ${target}.`);
    });

    // ---- log (Details) export / import ----
    // A separate file with each document's / member's full log (title, notes,
    // status, tags, journal, to-dos) and where it sits. Importing creates
    // anything missing in the tree, and asks before overwriting existing logs.

    type LogItem = {
        path: string[];
        server: string;
        ns: string;
        doc: string;
        member?: { name: string; kind: string };
        group?: string;
        title: string;
        description: string;
    } & Work;

    // ---- right-click menu on the Overview rows (webview/context) ----
    const ctxNode = (ctx: any): Node | undefined => (typeof ctx?.id === 'string' ? nodes.get(ctx.id) : undefined);
    const nameOf = (n: Node) =>
        n.kind === 'folder' ? n.folder.name : n.kind === 'group' ? n.group.name : n.kind === 'file' ? n.file.title || n.file.doc : n.member.title || n.member.name;
    const goToSub = async (ctx: any, sub: 'notes' | 'info') => {
        const n = ctxNode(ctx);
        if (!n) return;
        await select(n.id);
        details.send({ type: 'goto', id: n.id, sub });
    };
    reg('ovNotes', (ctx: any) => goToSub(ctx, 'notes'));
    reg('ovInfo', (ctx: any) => goToSub(ctx, 'info'));
    reg('ovStatus', async (ctx: any) => {
        const n = ctxNode(ctx);
        if (!n || (n.kind !== 'file' && n.kind !== 'member')) return;
        const cur = (n.kind === 'file' ? n.file : n.member).status;
        const opts: { label: string; status?: Status }[] = [
            { label: '$(circle-filled) To check', status: 'check' },
            { label: '$(circle-filled) In progress', status: 'progress' },
            { label: '$(circle-filled) Done', status: 'ok' },
            { label: '$(circle-filled) Needs fix', status: 'fix' },
            { label: '$(circle-outline) No status' }
        ];
        const pick = await vscode.window.showQuickPick(
            opts.map((o) => ({ ...o, description: o.status === cur ? '(current)' : '' })),
            { placeHolder: `Status of ${nameOf(n)}` }
        );
        if (pick) await onViewMessage({ type: 'setStatus', id: n.id, status: pick.status ?? 'none' });
    });
    reg('ovTag', async (ctx: any) => {
        const n = ctxNode(ctx);
        if (!n) return;
        const have = new Set(tagHolder(n).tags);
        const all = new Map<string, number>();
        const count = (x: { tags?: string[] }) => x.tags?.forEach((t) => all.set(t, (all.get(t) ?? 0) + 1));
        const walk = (f: LogFolder) => {
            count(f);
            f.folders.forEach(walk);
            f.files.forEach((file) => {
                count(file);
                file.groups.forEach(count);
                file.members.forEach(count);
            });
        };
        data.folders.forEach(walk);
        const existing = [...all.entries()].filter(([t]) => !have.has(t)).sort((a, b) => b[1] - a[1]);
        const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { tag: string }>();
        qp.placeholder = `Tag ${nameOf(n)}: pick one or type a new tag`;
        const base = existing.map(([t, c]) => ({ label: t, description: `${c} item(s)`, tag: t }));
        qp.items = base;
        qp.onDidChangeValue((v) => {
            const t = normalizeTag(v);
            const extra = t && !all.has(t) && !have.has(t) ? [{ label: `$(add) ${t}`, description: 'new tag', tag: t, alwaysShow: true }] : [];
            qp.items = [...extra, ...base];
        });
        const tag = await new Promise<string | undefined>((resolve) => {
            qp.onDidAccept(() => {
                resolve(qp.selectedItems[0]?.tag ?? (normalizeTag(qp.value) || undefined));
                qp.hide();
            });
            qp.onDidHide(() => resolve(undefined));
            qp.show();
        });
        qp.dispose();
        if (tag) await onViewMessage({ type: 'addTag', id: n.id, tag });
    });
    const addEntry = async (ctx: any, what: 'journal' | 'todo') => {
        const n = ctxNode(ctx);
        if (!n || (n.kind !== 'file' && n.kind !== 'member')) return;
        const text = await vscode.window.showInputBox({
            title: `${what === 'journal' ? 'Journal entry' : 'To-do'} for ${nameOf(n)}`,
            prompt: what === 'journal' ? 'What happened / what did you find?' : 'What needs doing?',
            ignoreFocusOut: true
        });
        if (text?.trim()) await onViewMessage({ type: what === 'journal' ? 'addJournal' : 'addTodo', id: n.id, text });
    };
    reg('ovJournal', (ctx: any) => addEntry(ctx, 'journal'));
    reg('ovTodo', (ctx: any) => addEntry(ctx, 'todo'));

    reg('exportLog', async () => {
        if (!data.folders.length) {
            vscode.window.showInformationMessage('The Code Log is empty: nothing to export.');
            return;
        }
        const pick = await vscode.window.showQuickPick(
            [
                { label: '$(root-folder) All projects', f: undefined as LogFolder | undefined },
                ...data.folders.map((f) => ({ label: `$(project) ${f.name}`, f: f as LogFolder | undefined }))
            ],
            { placeHolder: 'Export the log of…', ignoreFocusOut: true }
        );
        if (!pick) return;
        const items: LogItem[] = [];
        const workOf = (w: Work & { title: string; description: string }) => ({
            title: w.title, description: w.description, ...(w.status ? { status: w.status } : {}),
            tags: w.tags, journal: w.journal, todos: w.todos, created: w.created, edited: w.edited
        });
        const folderTags: { path: string[]; tags: string[] }[] = [];
        const groupTags: { path: string[]; server: string; ns: string; doc: string; group: string; tags: string[] }[] = [];
        const walk = (f: LogFolder, parentPath: string[]) => {
            const p = [...parentPath, f.name];
            if (f.tags?.length) folderTags.push({ path: p, tags: f.tags });
            for (const file of f.files) {
                const where = { path: p, server: file.server, ns: file.ns, doc: file.doc };
                items.push({ ...where, ...workOf(file) });
                for (const g of file.groups) if (g.tags?.length) groupTags.push({ ...where, group: g.name, tags: g.tags });
                for (const m of file.members) {
                    const group = m.group ? file.groups.find((g) => g.id === m.group)?.name : undefined;
                    items.push({ ...where, member: { name: m.name, kind: m.kind }, ...(group ? { group } : {}), ...workOf(m) });
                }
            }
            f.folders.forEach((sub) => walk(sub, p));
        };
        (pick.f ? [pick.f] : data.folders).forEach((f) => walk(f, []));
        const base = pick.f ? pick.f.name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'project' : 'code-log';
        const target = await saveJson('Export Log', `${base}-log.json`, {
            format: LOG_FORMAT,
            version: 1,
            exported: new Date().toISOString(),
            scope: pick.f ? pick.f.name : 'all',
            items,
            folderTags,
            groupTags
        });
        if (target) vscode.window.showInformationMessage(`Log exported (${items.length} item(s)) ${target}.`);
    });

    reg('importLog', async () => {
        const src = await chooseJsonSource('Import Log');
        if (src) await importAuto(src);
    });

    async function runImportLog(src: JsonSource) {
        let items: LogItem[];
        let folderTags: { path: string[]; tags: string[] }[] = [];
        let groupTags: { path: string[]; server: string; ns: string; doc: string; group: string; tags: string[] }[] = [];
        try {
            const parsed = parseJson(src);
            if (parsed?.format !== LOG_FORMAT) throw new Error('not a Log export');
            items = (Array.isArray(parsed.items) ? parsed.items : [])
                .filter((it: any) =>
                    Array.isArray(it?.path) && it.path.length && it.path.every((x: any) => typeof x === 'string' && x) &&
                    typeof it.server === 'string' && typeof it.ns === 'string' && typeof it.doc === 'string' &&
                    (it.member === undefined || typeof it.member?.name === 'string'))
                .map((it: any) => ({
                    path: it.path, server: it.server, ns: String(it.ns).toUpperCase(), doc: it.doc,
                    ...(it.member ? { member: { name: it.member.name, kind: it.member.kind || 'Label' } } : {}),
                    ...(typeof it.group === 'string' && it.group ? { group: it.group } : {}),
                    title: typeof it.title === 'string' ? it.title : '',
                    description: typeof it.description === 'string' ? it.description : '',
                    ...normalizeWork(it)
                }));
            const okPath = (x: any) => Array.isArray(x?.path) && x.path.length && x.path.every((y: any) => typeof y === 'string' && y);
            folderTags = (Array.isArray(parsed.folderTags) ? parsed.folderTags : [])
                .filter(okPath).map((x: any) => ({ path: x.path, tags: normalizeWork(x).tags }));
            groupTags = (Array.isArray(parsed.groupTags) ? parsed.groupTags : [])
                .filter((x: any) => okPath(x) && typeof x.server === 'string' && typeof x.ns === 'string' && typeof x.doc === 'string' && typeof x.group === 'string' && x.group)
                .map((x: any) => ({ path: x.path, server: x.server, ns: String(x.ns).toUpperCase(), doc: x.doc, group: x.group, tags: normalizeWork(x).tags }));
        } catch (e: any) {
            vscode.window.showErrorMessage(`Couldn't import ${src.label}: ${e?.message || e}`);
            return;
        }
        if (!items.length && !folderTags.length && !groupTags.length) {
            vscode.window.showInformationMessage('That file has no log entries.');
            return;
        }

        // 1. What already exists here (nothing is created yet)?
        const findFolder = (p: string[]) => {
            let list = data.folders;
            let f: LogFolder | undefined;
            for (const name of p) {
                f = list.find((x) => x.name === name);
                if (!f) return undefined;
                list = f.folders;
            }
            return f;
        };
        const findTarget = (it: LogItem): (LogFile | LogMember) | undefined => {
            const file = findFolder(it.path)?.files.find((x) => sameDoc(x, it.server, it.ns, it.doc));
            if (!file || !it.member) return file;
            return file.members.find((m) => m.name === it.member!.name);
        };
        const conflicts = items.filter((it) => {
            const t = findTarget(it);
            return t && hasDetails(t);
        });

        // 2. Ask before overwriting anything that already has a log.
        let overwrite = new Set<LogItem>();
        if (conflicts.length) {
            const choice = await vscode.window.showWarningMessage(
                `${conflicts.length} of the ${items.length} item(s) already have a log here.`,
                {
                    modal: true,
                    detail: 'Overwrite all: replace their title, notes, status, tags, journal and to-dos with the file\'s.\nKeep mine: leave them as they are (only missing items are added).\nChoose: tick which ones to overwrite.'
                },
                'Overwrite all',
                'Keep mine',
                'Choose…'
            );
            if (!choice) return;
            if (choice === 'Overwrite all') overwrite = new Set(conflicts);
            else if (choice === 'Choose…') {
                const ticked = await vscode.window.showQuickPick(
                    conflicts.map((it) => ({
                        label: it.title || (it.member ? it.member.name : it.doc),
                        description: [it.member ? it.member.name : '', it.doc].filter(Boolean).join(' · '),
                        detail: it.path.join(' › '),
                        it
                    })),
                    { canPickMany: true, placeHolder: 'Tick the items to OVERWRITE with the file\'s log (unticked ones keep yours)', ignoreFocusOut: true }
                );
                if (!ticked) return;
                overwrite = new Set(ticked.map((t) => t.it));
            }
        }

        // 3. Apply: create what's missing, fill in / overwrite logs.
        const ensureFolder = (p: string[]) => {
            let list = data.folders;
            let f: LogFolder | undefined;
            for (const name of p) {
                f = list.find((x) => x.name === name);
                if (!f) {
                    f = { id: newId(), name, description: '', folders: [], files: [] };
                    list.push(f);
                }
                list = f.folders;
            }
            return f!;
        };
        const summary = { added: 0, filled: 0, overwritten: 0, kept: 0 };
        for (const it of items) {
            const before = findTarget(it);
            if (before && hasDetails(before) && !overwrite.has(it)) {
                summary.kept++;
                continue;
            }
            const folder = ensureFolder(it.path);
            const file = addFile(folder, it.server, it.ns, it.doc);
            let target: LogFile | LogMember = file;
            if (it.member) {
                const m = addMember(file, it.member.name, it.member.kind);
                if (it.group) {
                    let g = file.groups.find((x) => x.name === it.group);
                    if (!g) {
                        g = { id: newId(), name: it.group, description: '' };
                        file.groups.push(g);
                    }
                    if (!m.group || overwrite.has(it)) m.group = g.id;
                }
                target = m;
            }
            target.title = it.title;
            target.description = it.description;
            const created = before?.created;
            copyWork(it, target);
            if (created) target.created = created;
            target.created ||= new Date().toISOString();
            target.edited ||= new Date().toISOString();
            if (!before) summary.added++;
            else if (overwrite.has(it)) summary.overwritten++;
            else summary.filled++;
        }
        // Folder and group tags are added to yours (never removed).
        const union = (x: { tags?: string[] }, tags: string[]) => (x.tags = [...new Set([...(x.tags ?? []), ...tags])]);
        for (const ft of folderTags) union(ensureFolder(ft.path), ft.tags);
        for (const gt of groupTags) {
            const file = addFile(ensureFolder(gt.path), gt.server, gt.ns, gt.doc);
            let g = file.groups.find((x) => x.name === gt.group);
            if (!g) {
                g = { id: newId(), name: gt.group, description: '', tags: [] };
                file.groups.push(g);
            }
            union(g, gt.tags);
        }
        selected = selected && nodes.get(selected.id);
        changed();
        vscode.window.showInformationMessage(
            `Log imported: ${summary.added} added, ${summary.filled} filled in, ${summary.overwritten} overwritten, ${summary.kept} kept as yours.`
        );
    }

    /**
     * A project file: tick which subfolders / documents to take. If you already
     * have the project, tick which of the existing ones to replace (the rest
     * merge). Your status, tags, journal and to-dos are kept either way.
     */
    const importProject = async (project: LogFolder) => {
        const existing = data.folders.find((f) => f.name === project.name);
        type Unit = { kind: 'folder'; f: LogFolder } | { kind: 'file'; f: LogFile };
        const units: Unit[] = [...project.folders.map((f) => ({ kind: 'folder' as const, f })), ...project.files.map((f) => ({ kind: 'file' as const, f }))];
        const existsIn = (u: Unit) =>
            !existing ? undefined
            : u.kind === 'folder' ? existing.folders.find((x) => x.name === u.f.name)
            : existing.files.find((x) => sameDoc(x, u.f.server, u.f.ns, u.f.doc));

        let chosen: Unit[] = units;
        if (units.length) {
            const picked = await vscode.window.showQuickPick(
                units.map((u) => ({
                    label: u.kind === 'folder' ? `$(folder) ${u.f.name}` : `$(file-code) ${u.f.doc}`,
                    description: existsIn(u) ? 'already exists' : 'new',
                    detail: u.kind === 'folder' ? `${countFiles(u.f)} document(s)` : `${u.f.members.length} label(s) / method(s)`,
                    picked: true,
                    u
                })),
                {
                    canPickMany: true,
                    placeHolder: existing
                        ? `Project "${project.name}" (you have it): which parts to import?`
                        : `New project "${project.name}": which parts to import?`,
                    ignoreFocusOut: true
                }
            );
            if (!picked?.length) return;
            chosen = picked.map((p) => p.u);
        }

        if (!existing) {
            data.folders.push({ ...project, folders: chosen.flatMap((u) => (u.kind === 'folder' ? [u.f] : [])), files: chosen.flatMap((u) => (u.kind === 'file' ? [u.f] : [])) });
            selected = undefined;
            changed();
            vscode.window.showInformationMessage(`Added project "${project.name}".`);
            await select(project.id);
            return;
        }

        const clashing = chosen.filter((u) => existsIn(u));
        let replace = new Set<Unit>();
        if (clashing.length) {
            const toReplace = await vscode.window.showQuickPick(
                clashing.map((u) => ({ label: u.kind === 'folder' ? `$(folder) ${u.f.name}` : `$(file-code) ${u.f.doc}`, description: 'replace', u })),
                {
                    canPickMany: true,
                    placeHolder: 'You already have these. Tick the ones to REPLACE; unticked ones are merged into yours.',
                    ignoreFocusOut: true
                }
            );
            if (!toReplace) return;
            replace = new Set(toReplace.map((t) => t.u));
            if (replace.size) {
                const ok = await vscode.window.showWarningMessage(
                    `Replace ${replace.size} part(s) of "${project.name}" with the imported version? Your status, tags, journal and to-dos are kept.`,
                    { modal: true },
                    'Replace'
                );
                if (ok !== 'Replace') return;
            }
        }

        existing.description ||= project.description;
        const summary = { added: 0, merged: 0, replaced: 0 };
        for (const u of chosen) {
            const old = existsIn(u);
            if (!old) {
                if (u.kind === 'folder') existing.folders.push(u.f);
                else existing.files.push(u.f);
                summary.added++;
            } else if (replace.has(u)) {
                if (u.kind === 'folder') {
                    carryWorkFolder(old as LogFolder, u.f);
                    existing.folders[existing.folders.indexOf(old as LogFolder)] = u.f;
                } else {
                    carryWorkFiles([old as LogFile], [u.f]);
                    existing.files[existing.files.indexOf(old as LogFile)] = u.f;
                }
                summary.replaced++;
            } else {
                if (u.kind === 'folder') mergeFolders(existing.folders, [u.f]);
                else mergeFile(old as LogFile, u.f);
                summary.merged++;
            }
        }
        selected = undefined;
        changed();
        vscode.window.showInformationMessage(
            `Imported into "${project.name}": ${summary.added} added, ${summary.merged} merged, ${summary.replaced} replaced.`
        );
        await select(existing.id);
    };

    reg('import', async () => {
        const src = await chooseJsonSource('Import Projects (whole log or one project)');
        if (src) await importAuto(src);
    });

    async function runImport(src: JsonSource) {
        let incoming: LogData;
        let isProject: boolean;
        try {
            const parsed = parseJson(src);
            if (!isValidData(parsed)) throw new Error('not a Projects or Code Log export');
            incoming = normalize(parsed);
            // The tree carries titles and notes only; status, tags, journal and to-dos come via Import Log.
            incoming.folders.forEach(stripWork);
            isProject = parsed.scope === 'project' || (parsed.scope === undefined && incoming.folders.length === 1);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Couldn't import ${src.label}: ${e?.message || e}`);
            return;
        }
        // Fresh ids, so nothing imported can collide with what's already here.
        incoming.folders.forEach(reId);
        const count = incoming.folders.reduce((n, f) => n + countFiles(f), 0);

        if (isProject && incoming.folders.length === 1) {
            await importProject(incoming.folders[0]);
            return;
        }

        // Several projects: tick which to import, then which existing ones to overwrite.
        const existingByName = new Map(data.folders.map((f) => [f.name, f]));
        const chosen = await vscode.window.showQuickPick(
            incoming.folders.map((p) => ({
                label: `$(project) ${p.name}`,
                description: existingByName.has(p.name) ? 'already exists' : 'new',
                detail: `${countFiles(p)} document(s)`,
                picked: true,
                project: p
            })),
            { canPickMany: true, placeHolder: 'Which projects to import? (untick any you don\'t want)', ignoreFocusOut: true }
        );
        if (!chosen?.length) return;

        const clashing = chosen.filter((c) => existingByName.has(c.project.name));
        let overwrite = new Set<string>();
        if (clashing.length) {
            const toReplace = await vscode.window.showQuickPick(
                clashing.map((c) => ({ label: `$(project) ${c.project.name}`, description: 'overwrite', project: c.project })),
                {
                    canPickMany: true,
                    placeHolder: 'You already have these. Tick the ones to OVERWRITE; unticked ones are merged into yours.',
                    ignoreFocusOut: true
                }
            );
            if (!toReplace) return; // Escape = cancel the whole import
            overwrite = new Set(toReplace.map((t) => t.project.name));
            if (overwrite.size) {
                const ok = await vscode.window.showWarningMessage(
                    `Overwrite ${[...overwrite].map((n) => `"${n}"`).join(', ')} with the imported version?`,
                    { modal: true },
                    'Overwrite'
                );
                if (ok !== 'Overwrite') return;
            }
        }

        const summary = { added: [] as string[], merged: [] as string[], replaced: [] as string[] };
        for (const { project } of chosen) {
            const existing = existingByName.get(project.name);
            if (!existing) {
                data.folders.push(project);
                summary.added.push(project.name);
            } else if (overwrite.has(project.name)) {
                carryWorkFolder(existing, project);
                data.folders[data.folders.indexOf(existing)] = project;
                summary.replaced.push(project.name);
            } else {
                mergeFolders(data.folders, [project]);
                summary.merged.push(project.name);
            }
        }
        selected = undefined;
        changed();
        vscode.window.showInformationMessage(
            'Import done. ' +
            [
                summary.added.length ? `Added: ${summary.added.join(', ')}.` : '',
                summary.merged.length ? `Merged: ${summary.merged.join(', ')}.` : '',
                summary.replaced.length ? `Overwritten: ${summary.replaced.join(', ')}.` : ''
            ].filter(Boolean).join(' ')
        );
    }
}

function cloneFolderRaw(f: LogFolder): LogFolder {
    return JSON.parse(JSON.stringify(f));
}

export const LOG_FORMAT = 'isfs-code-log-details';

/** New ids for a folder and everything in it. */
function reId(f: LogFolder) {
    f.id = newId();
    f.folders.forEach(reId);
    f.files.forEach(reIdFile);
}

/** New ids for a document entry, its groups and members (keeping members in their groups). */
function reIdFile(file: LogFile) {
    file.id = newId();
    const map = new Map<string, string>();
    for (const g of file.groups) {
        const id = newId();
        map.set(g.id, id);
        g.id = id;
    }
    for (const m of file.members) {
        m.id = newId();
        if (m.group) m.group = map.get(m.group);
        if (!m.group) delete m.group;
    }
}

/** Merge by folder name (at each level), then document, then member name. Non-empty text wins. */
function mergeFolders(target: LogFolder[], incoming: LogFolder[]) {
    for (const inF of incoming) {
        const f = target.find((x) => x.name === inF.name);
        if (!f) {
            target.push(inF);
            continue;
        }
        f.description ||= inF.description;
        f.tags = [...new Set([...(f.tags ?? []), ...(inF.tags ?? [])])];
        mergeFolders(f.folders, inF.folders);
        mergeFiles(f.files, inF.files);
    }
}

/** Documents into a folder's documents: new ones added, matching ones merged. */
function mergeFiles(target: LogFile[], incoming: LogFile[]) {
    for (const inFile of incoming) {
        const file = target.find((x) => sameDoc(x, inFile.server, inFile.ns, inFile.doc));
        if (file) mergeFile(file, inFile);
        else target.push(inFile);
    }
}

/** Titles / notes fill in where yours are empty; groups merge by name; new members are added. */
function mergeFile(file: LogFile, inFile: LogFile) {
    file.title ||= inFile.title;
    file.description ||= inFile.description;
    // Groups merge by name; incoming members follow their group.
    const groupMap = new Map<string, string>();
    for (const inG of inFile.groups) {
        const g = file.groups.find((x) => x.name === inG.name);
        if (g) {
            g.description ||= inG.description;
            g.tags = [...new Set([...(g.tags ?? []), ...(inG.tags ?? [])])];
            groupMap.set(inG.id, g.id);
        } else {
            file.groups.push(inG);
            groupMap.set(inG.id, inG.id);
        }
    }
    for (const inM of inFile.members) {
        const m = file.members.find((x) => x.name === inM.name);
        const group = inM.group ? groupMap.get(inM.group) : undefined;
        if (!m) {
            if (group) inM.group = group;
            else delete inM.group;
            file.members.push(inM);
        } else {
            m.title ||= inM.title;
            m.description ||= inM.description;
            if (!m.group && group) m.group = group;
        }
    }
}

const WORK_KEYS: (keyof Work)[] = ['status', 'tags', 'journal', 'todos', 'created', 'edited'];

function copyWork(from: Work, to: Work) {
    for (const k of WORK_KEYS) {
        if (from[k] === undefined) delete (to as any)[k];
        else (to as any)[k] = JSON.parse(JSON.stringify(from[k]));
    }
}

/**
 * A tree import replaced `oldFiles` with `newFiles`: keep your status, tags,
 * journal and to-dos on documents / members that are in both (the tree file
 * only carries titles and notes).
 */
function carryWorkFiles(oldFiles: LogFile[], newFiles: LogFile[]) {
    for (const nf of newFiles) {
        const of = oldFiles.find((x) => sameDoc(x, nf.server, nf.ns, nf.doc));
        if (!of) continue;
        copyWork(of, nf);
        for (const ng of nf.groups) {
            const og = of.groups.find((x) => x.name === ng.name);
            if (og?.tags?.length) ng.tags = [...og.tags];
        }
        for (const nm of nf.members) {
            const om = of.members.find((x) => x.name === nm.name);
            if (om) copyWork(om, nm);
        }
    }
}

/** Same, for whole folders (matching documents anywhere inside them). */
function carryWorkFolder(oldF: LogFolder, newF: LogFolder) {
    const all = (f: LogFolder): LogFile[] => [...f.files, ...f.folders.flatMap(all)];
    const oldFiles = all(oldF);
    const walk = (f: LogFolder, o: LogFolder | undefined) => {
        if (o?.tags?.length) f.tags = [...o.tags];
        carryWorkFiles(oldFiles, f.files);
        f.folders.forEach((sub) => walk(sub, o?.folders.find((x) => x.name === sub.name)));
    };
    walk(newF, oldF);
}

function escapeMd(s: string): string {
    return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
