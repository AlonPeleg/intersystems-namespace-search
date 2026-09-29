import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { chooseDocuments, docNameToUri } from './docPicker';
import { findLabelLine } from './goto';

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

interface LogMember {
    id: string;
    name: string;
    kind: string; // Label, ClassMethod, Method, Query, ...
    title: string;
    description: string;
}

interface LogFile {
    id: string;
    server: string;
    ns: string;
    doc: string; // Pkg.Sub.Cls.cls, ROUTINE.mac
    title: string;
    description: string;
    members: LogMember[];
}

interface LogFolder {
    id: string;
    name: string;
    description: string;
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
    | { kind: 'member'; id: string; folder: LogFolder; file: LogFile; member: LogMember };

type FolderNode = Extract<Node, { kind: 'folder' }>;
type FileNode = Extract<Node, { kind: 'file' }>;

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
        folders: (f.folders || []).map(normalizeFolder),
        files: f.files.map((x: any) => ({
            id: x.id || newId(),
            server: x.server,
            ns: String(x.ns).toUpperCase(),
            doc: x.doc,
            title: x.title || '',
            description: x.description || '',
            members: (x.members || []).filter((m: any) => typeof m?.name === 'string').map((m: any) => ({
                id: m.id || newId(),
                name: m.name,
                kind: m.kind || 'Label',
                title: m.title || '',
                description: m.description || ''
            }))
        }))
    };
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
                for (const member of file.members) nodes.set(member.id, { kind: 'member', id: member.id, folder, file, member });
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

    // ---- tree ----
    const treeChanged = new vscode.EventEmitter<Node | undefined | void>();
    const provider: vscode.TreeDataProvider<Node> = {
        onDidChangeTreeData: treeChanged.event,
        getParent: (n) => {
            if (n.kind === 'member') return nodes.get(n.file.id);
            if (n.kind === 'file') return nodes.get(n.folder.id);
            return n.parent ? nodes.get(n.parent.id) : undefined;
        },
        getChildren: (n) => {
            if (!n) return data.folders.map((f) => nodes.get(f.id)!);
            if (n.kind === 'folder') return [...n.folder.folders.map((f) => nodes.get(f.id)!), ...n.folder.files.map((f) => nodes.get(f.id)!)];
            if (n.kind === 'file') return n.file.members.map((m) => nodes.get(m.id)!);
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
                    empty ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded
                );
                item.id = n.id;
                item.iconPath = new vscode.ThemeIcon(isProject ? 'project' : 'folder');
                // File count as a right-aligned badge (see the decoration provider).
                item.resourceUri = vscode.Uri.from({ scheme: DECO_SCHEME, path: '/' + n.id });
                if (empty) item.description = 'empty';
                item.tooltip = [pathOf(n.folder).join(' › '), n.folder.description].filter(Boolean).join('\n\n');
                item.contextValue = isProject ? 'logProject' : 'logFolder';
                return item;
            }
            if (n.kind === 'file') {
                const open = !!folderFor(n.file.server, n.file.ns);
                // Title as the main text when there is one; the document name next to it.
                const item = new vscode.TreeItem(
                    isolate(n.file.title || n.file.doc),
                    n.file.members.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
                );
                item.id = n.id;
                const icon = /\.cls$/i.test(n.file.doc) ? 'symbol-class' : 'file-code';
                item.iconPath = open ? new vscode.ThemeIcon(icon) : new vscode.ThemeIcon(icon, new vscode.ThemeColor('disabledForeground'));
                item.description = isolateLtr([open ? '' : '(not open)', n.file.title ? n.file.doc : ''].filter(Boolean).join(' '));
                const md = new vscode.MarkdownString();
                if (n.file.title) md.appendMarkdown(`**${escapeMd(n.file.title)}**\n\n`);
                if (n.file.description) md.appendText(n.file.description + '\n\n');
                md.appendMarkdown(`\`${escapeMd(n.file.doc)}\` · ${escapeMd(n.file.ns)} on ${escapeMd(n.file.server)}`);
                if (!open) md.appendMarkdown(`\n\n_Namespace ${escapeMd(n.file.ns)} on ${escapeMd(n.file.server)} isn't open in this workspace._`);
                item.tooltip = md;
                item.contextValue = open ? 'logFile' : 'logFileClosed';
                return item;
            }
            const open = !!folderFor(n.file.server, n.file.ns);
            const item = new vscode.TreeItem(isolate(n.member.title || n.member.name), vscode.TreeItemCollapsibleState.None);
            item.id = n.id;
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
        dropMimeTypes: [DRAG_MIME],
        handleDrag(source, transfer) {
            const ids = source.filter((n) => n.kind === 'file' || n.kind === 'folder').map((n) => n.id);
            if (ids.length) transfer.set(DRAG_MIME, new vscode.DataTransferItem(ids));
        },
        async handleDrop(target, transfer) {
            const ids: string[] | undefined = transfer.get(DRAG_MIME)?.value;
            if (!ids?.length) return;
            // Onto a folder: into it. Onto a document/member: into its folder. Onto empty space: top level (folders only).
            const to = target ? (target.kind === 'folder' ? target.folder : target.folder) : undefined;
            for (const id of ids) {
                const n = nodes.get(id);
                if (n?.kind === 'file' && to) moveFile(n, to);
                else if (n?.kind === 'folder') moveFolder(n, to);
            }
            changed();
        }
    };

    const tree = vscode.window.createTreeView(TREE_ID, {
        treeDataProvider: provider,
        showCollapseAll: true,
        canSelectMany: false,
        dragAndDropController: dnd
    });
    context.subscriptions.push(tree, treeChanged);

    // ---- folder file-count badges ----
    const decoChanged = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    context.subscriptions.push(
        decoChanged,
        vscode.window.registerFileDecorationProvider({
            onDidChangeFileDecorations: decoChanged.event,
            provideFileDecoration(uri) {
                if (uri.scheme !== DECO_SCHEME) return undefined;
                const n = nodes.get(uri.path.slice(1));
                if (n?.kind !== 'folder') return undefined;
                const total = countFiles(n.folder);
                if (!total) return undefined;
                // Badges hold at most 2 characters.
                return new vscode.FileDecoration(total > 99 ? '99' : String(total), `${total} document${total === 1 ? '' : 's'} (including subfolders)`);
            }
        })
    );

    // ---- details panel ----
    const details = new DetailsView((msg) => onDetailsMessage(msg));
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(DETAILS_ID, details));
    let selected: Node | undefined;
    const showDetails = () => details.show(selected ? describeNode(selected, pathOf) : undefined);
    context.subscriptions.push(
        tree.onDidChangeSelection((e) => {
            selected = e.selection[0];
            showDetails();
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
        showDetails();
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
                    ? 'No suitable folder in the Code Log.'
                    : 'Create a folder in the Code Log first (New Folder in its title bar).',
                'Open Code Log'
            );
            if (go) await vscode.commands.executeCommand(`${TREE_ID}.focus`);
            return undefined;
        }
        const picked = await vscode.window.showQuickPick(
            choices.map(({ folder, depth }) => ({
                label: `${' '.repeat(depth)}$(folder) ${folder.name}`,
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
        const file: LogFile = { id: newId(), server, ns: ns.toUpperCase(), doc, title: '', description: '', members: [] };
        folder.files.push(file);
        return file;
    };

    const addMember = (file: LogFile, name: string, kind: string, title = ''): LogMember => {
        const existing = file.members.find((m) => m.name === name);
        if (existing) return existing;
        const member: LogMember = { id: newId(), name, kind, title, description: '' };
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

    const openNode = async (n: Node | undefined) => {
        if (!n || n.kind === 'folder') return;
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
            prompt: 'A short title (optional). Add a longer description in the Details panel.',
            ignoreFocusOut: true
        });

    // ---- details panel messages ----
    const onDetailsMessage = (msg: any) => {
        const n = msg?.id ? nodes.get(msg.id) : undefined;
        if (!n) return;
        if (msg.type === 'edit' && typeof msg.value === 'string') {
            const target: any = n.kind === 'folder' ? n.folder : n.kind === 'file' ? n.file : n.member;
            if (!['name', 'title', 'description'].includes(msg.field)) return;
            if (msg.field === 'name' && (n.kind !== 'folder' || !msg.value.trim())) return;
            target[msg.field] = msg.value;
            changed({ soon: true });
        } else if (msg.type === 'open') {
            openNode(n);
        }
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

    reg('addMembers', async (n?: Node) => {
        n = nodeArg(n);
        if (n?.kind !== 'file' && n?.kind !== 'member') return;
        const file = n.file;
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
                    { canPickMany: true, placeHolder: `Which ${isClass ? 'methods' : 'labels'} of ${file.doc}?`, ignoreFocusOut: true }
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
        changed();
        await select(added[0].id);
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

    reg('move', async (n?: Node) => {
        n = nodeArg(n);
        if (n?.kind === 'file') {
            const from = n.folder;
            const to = await pickFolder(`Move ${n.file.doc} to which folder?`, (f) => f !== from);
            if (!to) return;
            moveFile(n, to);
        } else if (n?.kind === 'folder') {
            const moving = n.folder;
            const TOP = { label: '$(root-folder) Top level', folder: undefined as LogFolder | undefined };
            const targets = allFolders().filter(({ folder }) => !isInside(folder, moving) && folder !== parentOf.get(moving));
            const picked = await vscode.window.showQuickPick(
                [
                    ...(parentOf.get(moving) ? [TOP] : []),
                    ...targets.map(({ folder, depth }) => ({ label: `${' '.repeat(depth)}$(folder) ${folder.name}`, folder: folder as LogFolder | undefined }))
                ],
                { placeHolder: `Move "${moving.name}" into which folder?`, ignoreFocusOut: true }
            );
            if (!picked) return;
            moveFolder(n, picked.folder);
        } else return;
        const id = n.id;
        changed();
        await select(id);
    });

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
        } else {
            const member = n.member;
            n.file.members = n.file.members.filter((m) => m !== member);
        }
        if (selected?.id === n.id) selected = undefined;
        changed();
    });

    const saveJson = async (title: string, fileName: string, payload: unknown) => {
        const target = await vscode.window.showSaveDialog({
            title,
            defaultUri: vscode.Uri.file(path.join(desktopDir(), fileName)),
            filters: { JSON: ['json'] }
        });
        if (!target) return undefined;
        await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(payload, null, 2), 'utf8'));
        return target;
    };

    reg('export', async () => {
        const target = await saveJson('Export Code Log', 'code-log.json', { ...data, scope: 'log' });
        if (target) vscode.window.showInformationMessage(`Code Log exported to ${target.fsPath}.`);
    });

    // A project export is a log holding just that project, so Import reads both.
    reg('exportProject', async (n?: Node) => {
        n = nodeArg(n);
        if (n?.kind !== 'folder' || n.parent) return;
        const safeName = n.folder.name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'project';
        const target = await saveJson(`Export project "${n.folder.name}"`, `${safeName}.json`, {
            version: 2,
            scope: 'project',
            folders: [n.folder]
        });
        if (target) vscode.window.showInformationMessage(`Project "${n.folder.name}" exported to ${target.fsPath}.`);
    });

    reg('import', async () => {
        const picked = await vscode.window.showOpenDialog({
            title: 'Import Code Log or project',
            defaultUri: vscode.Uri.file(desktopDir()),
            canSelectMany: false,
            filters: { JSON: ['json'] }
        });
        if (!picked?.[0]) return;
        let incoming: LogData;
        let isProject: boolean;
        try {
            const parsed = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(picked[0])).toString('utf8'));
            if (!isValidData(parsed)) throw new Error('not a Code Log export');
            incoming = normalize(parsed);
            isProject = parsed.scope === 'project' || (parsed.scope === undefined && incoming.folders.length === 1);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Couldn't import ${picked[0].fsPath}: ${e?.message || e}`);
            return;
        }
        // Fresh ids, so nothing imported can collide with what's already here.
        incoming.folders.forEach(reId);
        const count = incoming.folders.reduce((n, f) => n + countFiles(f), 0);

        if (isProject && incoming.folders.length === 1) {
            const project = incoming.folders[0];
            const existing = data.folders.find((f) => f.name === project.name);
            if (!existing) {
                data.folders.push(project);
            } else {
                const how = await vscode.window.showQuickPick(
                    [
                        { label: 'Merge', description: `Combine with your project "${project.name}"; matching subfolders, documents and members are combined.` },
                        { label: 'Replace', description: `Replace your project "${project.name}" with the imported one. Other projects are untouched.` },
                        { label: 'Add as a copy', description: `Keep both: add it as "${project.name} (imported)".` }
                    ],
                    { placeHolder: `You already have a project "${project.name}".`, ignoreFocusOut: true }
                );
                if (!how) return;
                if (how.label === 'Merge') {
                    mergeFolders(data.folders, [project]);
                } else if (how.label === 'Replace') {
                    const ok = await vscode.window.showWarningMessage(`Replace your project "${project.name}" with the imported one?`, { modal: true }, 'Replace');
                    if (ok !== 'Replace') return;
                    data.folders[data.folders.indexOf(existing)] = project;
                } else {
                    project.name = `${project.name} (imported)`;
                    data.folders.push(project);
                }
            }
            selected = undefined;
            changed();
            vscode.window.showInformationMessage(`Imported project "${project.name}" (${count} document(s)).`);
            await select(project.id);
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
    });
}

/** New ids for a folder and everything in it. */
function reId(f: LogFolder) {
    f.id = newId();
    f.folders.forEach(reId);
    for (const file of f.files) {
        file.id = newId();
        for (const m of file.members) m.id = newId();
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
        mergeFolders(f.folders, inF.folders);
        for (const inFile of inF.files) {
            const file = f.files.find((x) => sameDoc(x, inFile.server, inFile.ns, inFile.doc));
            if (!file) {
                f.files.push(inFile);
                continue;
            }
            file.title ||= inFile.title;
            file.description ||= inFile.description;
            for (const inM of inFile.members) {
                const m = file.members.find((x) => x.name === inM.name);
                if (!m) file.members.push(inM);
                else {
                    m.title ||= inM.title;
                    m.description ||= inM.description;
                }
            }
        }
    }
}

function escapeMd(s: string): string {
    return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Details panel
// ---------------------------------------------------------------------------

interface NodeView {
    id: string;
    kind: 'folder' | 'file' | 'member';
    /** Read-only context, top to bottom: namespace, folder path, document, member. */
    context: { label: string; value: string; mono?: boolean }[];
    fields: { key: 'name' | 'title' | 'description'; label: string; value: string; multiline: boolean }[];
    canOpen: boolean;
    openHint?: string;
}

function describeNode(n: Node, pathOf: (f: LogFolder) => string[]): NodeView {
    if (n.kind === 'folder') {
        const parents = pathOf(n.folder).slice(0, -1);
        return {
            id: n.id,
            kind: 'folder',
            context: parents.length ? [{ label: 'Inside', value: parents.join(' › ') }] : [],
            fields: [
                { key: 'name', label: n.parent ? 'Folder name' : 'Project name', value: n.folder.name, multiline: false },
                { key: 'description', label: 'Description', value: n.folder.description, multiline: true }
            ],
            canOpen: false
        };
    }
    const open = !!folderFor(n.file.server, n.file.ns);
    const ctx: NodeView['context'] = [
        { label: 'Namespace', value: `${n.file.ns}  ·  ${n.file.server}` },
        { label: 'Folder', value: pathOf(n.folder).join(' › ') },
        { label: 'Document', value: n.file.doc, mono: true }
    ];
    if (n.kind === 'member') ctx.push({ label: n.member.kind, value: n.member.name, mono: true });
    const target = n.kind === 'file' ? n.file : n.member;
    return {
        id: n.id,
        kind: n.kind,
        context: ctx,
        fields: [
            { key: 'title', label: 'Title', value: target.title, multiline: false },
            { key: 'description', label: 'Description', value: target.description, multiline: true }
        ],
        canOpen: open,
        openHint: open ? undefined : `Namespace ${n.file.ns} on ${n.file.server} isn't open in this workspace.`
    };
}

class DetailsView implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private pending: NodeView | undefined;

    constructor(private readonly onMessage: (msg: any) => void) {}

    resolveWebviewView(view: vscode.WebviewView) {
        this.view = view;
        view.webview.options = { enableScripts: true };
        view.webview.html = this.html();
        view.webview.onDidReceiveMessage((m) => {
            if (m?.type === 'ready') this.post();
            else this.onMessage(m);
        });
        view.onDidDispose(() => (this.view = undefined));
    }

    show(node: NodeView | undefined) {
        this.pending = node;
        this.post();
    }

    private post() {
        this.view?.webview.postMessage({ type: 'show', node: this.pending ?? null });
    }

    private html(): string {
        const nonce = newId() + newId();
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 10px 12px 16px; margin: 0; }
    .empty { color: var(--vscode-descriptionForeground); line-height: 1.5; }
    .ctx {
        border-left: 2px solid var(--vscode-textLink-foreground);
        background: var(--vscode-textBlockQuote-background, rgba(127,127,127,.08));
        border-radius: 0 4px 4px 0;
        padding: 6px 10px 8px;
        margin-bottom: 14px;
    }
    .ctx-row { padding: 3px 0; }
    .ctx-row + .ctx-row { border-top: 1px solid var(--vscode-widget-border, rgba(127,127,127,.18)); }
    .k { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); }
    .v { margin-top: 1px; overflow-wrap: anywhere; line-height: 1.35; }
    .mono { font-family: var(--vscode-editor-font-family); font-size: 12px; }
    .field { margin-top: 12px; }
    .field .k { display: block; margin-bottom: 4px; }
    input, textarea {
        width: 100%; box-sizing: border-box; padding: 6px 8px;
        color: var(--vscode-input-foreground); background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border, rgba(127,127,127,.25)); border-radius: 3px;
        font-family: inherit; font-size: inherit; line-height: 1.4;
    }
    input.title { font-size: 14px; font-weight: 600; }
    input:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    textarea { min-height: 120px; resize: vertical; }
    .actions { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
    button {
        color: var(--vscode-button-foreground); background: var(--vscode-button-background);
        border: none; padding: 5px 14px; border-radius: 3px; cursor: pointer; font-family: inherit;
    }
    button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: .45; cursor: default; }
    .saved { font-size: 12px; color: var(--vscode-descriptionForeground); transition: opacity .3s; }
    .hint { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 8px; }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('root');
    const EMPTY = 'Select a folder, document or member in the Code Log above to see and edit its notes.';
    let current = null;
    const timers = {};
    let savedTimer;

    function el(tag, props, ...kids) {
        const e = document.createElement(tag);
        Object.assign(e, props || {});
        for (const k of kids) e.append(k);
        return e;
    }

    function render(node) {
        current = node;
        root.textContent = '';
        if (!node) {
            root.append(el('div', { className: 'empty', textContent: EMPTY }));
            return;
        }
        if (node.context.length) {
            const box = el('div', { className: 'ctx' });
            for (const c of node.context) {
                box.append(el('div', { className: 'ctx-row' },
                    el('div', { className: 'k', textContent: c.label }),
                    el('div', { className: 'v' + (c.mono ? ' mono' : ''), textContent: c.value, dir: 'auto' })));
            }
            root.append(box);
        }
        const saved = el('span', { className: 'saved' });
        for (const f of node.fields) {
            const input = f.multiline
                ? el('textarea', { value: f.value, dir: 'auto', placeholder: 'What it does, where it is called from, notes...' })
                : el('input', { value: f.value, dir: 'auto', type: 'text', className: f.key === 'title' || f.key === 'name' ? 'title' : '' });
            input.addEventListener('input', () => {
                saved.textContent = '';
                clearTimeout(timers[f.key]);
                const id = node.id;
                timers[f.key] = setTimeout(() => {
                    vscode.postMessage({ type: 'edit', id, field: f.key, value: input.value });
                    saved.textContent = 'Saved';
                    clearTimeout(savedTimer);
                    savedTimer = setTimeout(() => (saved.textContent = ''), 1500);
                }, 400);
            });
            root.append(el('div', { className: 'field' }, el('span', { className: 'k', textContent: f.label }), input));
        }
        const actions = el('div', { className: 'actions' });
        if (node.kind !== 'folder') {
            const open = el('button', { textContent: 'Go to code \\u2192', disabled: !node.canOpen });
            open.addEventListener('click', () => vscode.postMessage({ type: 'open', id: node.id }));
            actions.append(open);
        }
        actions.append(saved);
        root.append(actions);
        if (node.openHint) root.append(el('div', { className: 'hint', textContent: node.openHint }));
    }

    window.addEventListener('message', (e) => {
        if (e.data?.type !== 'show') return;
        const node = e.data.node;
        // Don't wipe what's being typed when the same item is re-sent.
        const typing = document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
        if (node && current && node.id === current.id && typing) {
            current = node;
            return;
        }
        render(node);
    });
    render(null);
    vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
    }
}
