import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { chooseDocuments, docNameToUri } from './docPicker';
import { findLabelLine } from './goto';

// ---------------------------------------------------------------------------
// Code Log: your own notes about server-side code, organised in folders.
//
//   folder (any name, Hebrew / English)
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
    files: LogFile[];
}

interface LogData {
    version: 1;
    folders: LogFolder[];
}

type Node =
    | { kind: 'folder'; id: string; folder: LogFolder }
    | { kind: 'file'; id: string; folder: LogFolder; file: LogFile }
    | { kind: 'member'; id: string; folder: LogFolder; file: LogFile; member: LogMember };

const STORAGE_KEY = 'isfsNamespaceSearch.codeLog';
const TREE_ID = 'isfsNamespaceSearch.codeLogTree';
const DETAILS_ID = 'isfsNamespaceSearch.codeLogDetails';
const CMD = 'isfsNamespaceSearch.codeLog';
const DRAG_MIME = `application/vnd.code.tree.${TREE_ID.toLowerCase()}`;

const CLASS_MEMBER = /^\s*(ClassMethod|ClientMethod|Method|Query|Trigger)\s+(%?\w+)/i;
const ROUTINE_LABEL = /^(%?[A-Za-z0-9]+)(?:\(|\s|;|$)/;

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

function isValidData(d: any): d is LogData {
    return (
        d && Array.isArray(d.folders) &&
        d.folders.every((f: any) =>
            typeof f?.name === 'string' && Array.isArray(f.files) &&
            f.files.every((x: any) =>
                typeof x?.doc === 'string' && typeof x?.server === 'string' && typeof x?.ns === 'string' &&
                (x.members === undefined || Array.isArray(x.members))
            )
        )
    );
}

/** Fills in anything missing (ids, empty strings) so imported data is safe to use. */
function normalize(d: LogData): LogData {
    return {
        version: 1,
        folders: d.folders.map((f) => ({
            id: f.id || newId(),
            name: f.name,
            description: f.description || '',
            files: f.files.map((x) => ({
                id: x.id || newId(),
                server: x.server,
                ns: x.ns.toUpperCase(),
                doc: x.doc,
                title: x.title || '',
                description: x.description || '',
                members: (x.members || []).filter((m: any) => typeof m?.name === 'string').map((m) => ({
                    id: m.id || newId(),
                    name: m.name,
                    kind: m.kind || 'Label',
                    title: m.title || '',
                    description: m.description || ''
                }))
            }))
        }))
    };
}

export function registerCodeLog(context: vscode.ExtensionContext, log: Logger) {
    let data: LogData = normalize(context.globalState.get<LogData>(STORAGE_KEY, { version: 1, folders: [] }));
    const nodes = new Map<string, Node>();

    const persist = () => context.globalState.update(STORAGE_KEY, data);

    const rebuildIndex = () => {
        nodes.clear();
        for (const folder of data.folders) {
            nodes.set(folder.id, { kind: 'folder', id: folder.id, folder });
            for (const file of folder.files) {
                nodes.set(file.id, { kind: 'file', id: file.id, folder, file });
                for (const member of file.members) nodes.set(member.id, { kind: 'member', id: member.id, folder, file, member });
            }
        }
    };
    rebuildIndex();

    // ---- tree ----
    const treeChanged = new vscode.EventEmitter<Node | undefined | void>();
    const provider: vscode.TreeDataProvider<Node> = {
        onDidChangeTreeData: treeChanged.event,
        getParent: (n) =>
            n.kind === 'member' ? nodes.get(n.file.id) : n.kind === 'file' ? nodes.get(n.folder.id) : undefined,
        getChildren: (n) => {
            if (!n) return data.folders.map((f) => nodes.get(f.id)!);
            if (n.kind === 'folder') return n.folder.files.map((f) => nodes.get(f.id)!);
            if (n.kind === 'file') return n.file.members.map((m) => nodes.get(m.id)!);
            return [];
        },
        getTreeItem: (n) => {
            if (n.kind === 'folder') {
                const item = new vscode.TreeItem(n.folder.name, vscode.TreeItemCollapsibleState.Expanded);
                item.id = n.id;
                item.iconPath = new vscode.ThemeIcon('folder');
                item.description = `${n.folder.files.length} file${n.folder.files.length === 1 ? '' : 's'}`;
                item.tooltip = n.folder.description || n.folder.name;
                item.contextValue = 'logFolder';
                return item;
            }
            if (n.kind === 'file') {
                const open = !!folderFor(n.file.server, n.file.ns);
                const item = new vscode.TreeItem(
                    n.file.doc,
                    n.file.members.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
                );
                item.id = n.id;
                const icon = /\.cls$/i.test(n.file.doc) ? 'symbol-class' : 'file-code';
                item.iconPath = open ? new vscode.ThemeIcon(icon) : new vscode.ThemeIcon(icon, new vscode.ThemeColor('disabledForeground'));
                item.description = (open ? '' : '(not open) ') + n.file.title;
                const md = new vscode.MarkdownString();
                if (n.file.title) md.appendMarkdown(`**${escapeMd(n.file.title)}**\n\n`);
                if (n.file.description) md.appendText(n.file.description + '\n\n');
                md.appendMarkdown(`\`${escapeMd(n.file.doc)}\` · ${escapeMd(n.file.server)} · ${escapeMd(n.file.ns)}`);
                if (!open) md.appendMarkdown(`\n\n_Namespace ${escapeMd(n.file.ns)} on ${escapeMd(n.file.server)} isn't open in this workspace._`);
                item.tooltip = md;
                item.contextValue = open ? 'logFile' : 'logFileClosed';
                return item;
            }
            const open = !!folderFor(n.file.server, n.file.ns);
            const item = new vscode.TreeItem(n.member.name, vscode.TreeItemCollapsibleState.None);
            item.id = n.id;
            const icon = n.member.kind === 'Label' ? 'symbol-function' : 'symbol-method';
            item.iconPath = open ? new vscode.ThemeIcon(icon) : new vscode.ThemeIcon(icon, new vscode.ThemeColor('disabledForeground'));
            item.description = n.member.title;
            item.tooltip = [n.member.kind + ' ' + n.member.name, n.member.title, n.member.description].filter(Boolean).join('\n\n');
            item.contextValue = open ? 'logMember' : 'logMemberClosed';
            return item;
        }
    };

    const dnd: vscode.TreeDragAndDropController<Node> = {
        dragMimeTypes: [DRAG_MIME],
        dropMimeTypes: [DRAG_MIME],
        handleDrag(source, transfer) {
            const files = source.filter((n) => n.kind === 'file').map((n) => n.id);
            if (files.length) transfer.set(DRAG_MIME, new vscode.DataTransferItem(files));
        },
        async handleDrop(target, transfer) {
            const ids: string[] | undefined = transfer.get(DRAG_MIME)?.value;
            if (!ids?.length || !target) return;
            const to = target.folder; // dropped on a folder, or on something inside one
            for (const id of ids) {
                const n = nodes.get(id);
                if (n?.kind === 'file') moveFile(n, to);
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

    // ---- details panel ----
    const details = new DetailsView(context, (msg) => onDetailsMessage(msg));
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(DETAILS_ID, details));
    let selected: Node | undefined;
    const showDetails = () => details.show(selected ? describeNode(selected) : undefined);
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
    const pickFolder = async (placeHolder: string, exclude?: (f: LogFolder) => boolean): Promise<LogFolder | undefined> => {
        const NEW = '$(new-folder) New folder...';
        const choices = data.folders.filter((f) => !exclude?.(f));
        const picked = await vscode.window.showQuickPick(
            [...choices.map((f) => ({ label: `$(folder) ${f.name}`, folder: f as LogFolder | undefined })), { label: NEW, folder: undefined }],
            { placeHolder, ignoreFocusOut: true }
        );
        if (!picked) return undefined;
        return picked.folder ?? newFolder();
    };

    const newFolder = async (): Promise<LogFolder | undefined> => {
        const name = (await vscode.window.showInputBox({
            title: 'New Code Log folder',
            prompt: 'Folder name (Hebrew, English or both)',
            ignoreFocusOut: true,
            validateInput: (v) => (v.trim() ? undefined : 'Enter a name')
        }))?.trim();
        if (!name) return undefined;
        const folder: LogFolder = { id: newId(), name, description: '', files: [] };
        data.folders.push(folder);
        changed();
        return folder;
    };

    const addFile = (folder: LogFolder, server: string, ns: string, doc: string): LogFile => {
        const existing = folder.files.find(
            (x) => x.doc.toLowerCase() === doc.toLowerCase() && x.server.toLowerCase() === server.toLowerCase() && x.ns.toLowerCase() === ns.toLowerCase()
        );
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

    const moveFile = (n: Extract<Node, { kind: 'file' }>, to: LogFolder) => {
        if (n.folder === to) return;
        const dup = to.files.find((x) => x.doc === n.file.doc && x.server === n.file.server && x.ns === n.file.ns);
        if (dup) {
            vscode.window.showWarningMessage(`${n.file.doc} is already in "${to.name}".`);
            return;
        }
        n.folder.files = n.folder.files.filter((x) => x !== n.file);
        to.files.push(n.file);
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
        const f = await newFolder();
        if (f) await select(f.id);
    });

    reg('renameFolder', async (n?: Node) => {
        n = nodeArg(n);
        if (n?.kind !== 'folder') return;
        const name = (await vscode.window.showInputBox({ title: 'Rename folder', value: n.folder.name, ignoreFocusOut: true }))?.trim();
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
        let picks: { name: string; kind: string }[] = [];
        if (ws) {
            try {
                const text = (await vscode.workspace.openTextDocument(docNameToUri(ws.uri, file.doc))).getText().split(/\r?\n/);
                const logged = new Set(file.members.map((m) => m.name));
                const TYPE = '$(edit) Type a name...';
                const chosen = await vscode.window.showQuickPick(
                    [
                        ...membersIn(text, isClass)
                            .filter((m) => !logged.has(m.name))
                            .map((m) => ({ label: m.name, description: `${m.kind} · line ${m.line + 1}`, m })),
                        { label: TYPE, description: '', m: undefined }
                    ],
                    { canPickMany: true, placeHolder: `Which ${isClass ? 'methods' : 'labels'} of ${file.doc}?`, ignoreFocusOut: true }
                );
                if (!chosen?.length) return;
                picks = chosen.filter((c) => c.m).map((c) => ({ name: c.m!.name, kind: c.m!.kind }));
                if (chosen.some((c) => !c.m)) {
                    const typed = (await vscode.window.showInputBox({ prompt: 'Label or method name', ignoreFocusOut: true }))?.trim();
                    if (typed) picks.push({ name: typed, kind: isClass ? 'Method' : 'Label' });
                }
            } catch (e: any) {
                log(`Code Log: couldn't read ${file.doc}: ${e?.message || e}`);
            }
        }
        if (!ws || !picks.length) {
            if (!ws) {
                const typed = (await vscode.window.showInputBox({
                    prompt: `Label or method name in ${file.doc} (its namespace isn't open, so it can't be listed)`,
                    ignoreFocusOut: true
                }))?.trim();
                if (typed) picks.push({ name: typed, kind: isClass ? 'Method' : 'Label' });
            }
            if (!picks.length) return;
        }
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

        const sameDoc = (f: LogFolder) =>
            f.files.some((x) => x.doc.toLowerCase() === doc.toLowerCase() && x.server.toLowerCase() === server.toLowerCase() && x.ns === ns);
        let folder: LogFolder | undefined;
        if (addMemberToo) {
            // A member goes under its document; use the folder(s) that already have it.
            const holders = data.folders.filter(sameDoc);
            folder =
                holders.length === 1 ? holders[0]
                : holders.length > 1
                    ? (await vscode.window.showQuickPick(holders.map((f) => ({ label: `$(folder) ${f.name}`, f })), {
                        placeHolder: `${doc} is in several folders. Add ${member!.name} to which?`
                    }))?.f
                    : await pickFolder(`Add ${member!.name} (${doc}) to which folder?`);
        } else {
            folder = await pickFolder(`Add ${doc} to which folder?`, sameDoc);
        }
        if (!folder) return;

        const title = await askTitle(addMemberToo ? member!.name : doc);
        if (title === undefined) return;
        const file = addFile(folder, server, ns, doc);
        let newId_: string;
        if (addMemberToo) {
            newId_ = addMember(file, member!.name, member!.kind, title.trim()).id;
        } else {
            if (title.trim()) file.title = title.trim();
            newId_ = file.id;
        }
        changed();
        await vscode.commands.executeCommand(`${TREE_ID}.focus`);
        await select(newId_);
    });

    reg('open', (n?: Node) => openNode(nodeArg(n)));

    reg('moveFile', async (n?: Node) => {
        n = nodeArg(n);
        if (n?.kind !== 'file') return;
        const from = n.folder;
        const to = await pickFolder(`Move ${n.file.doc} to which folder?`, (f) => f === from);
        if (!to) return;
        moveFile(n, to);
        changed();
        await select(n.id);
    });

    reg('remove', async (n?: Node) => {
        n = nodeArg(n);
        if (!n) return;
        if (n.kind === 'folder') {
            const ok = await vscode.window.showWarningMessage(
                `Delete folder "${n.folder.name}"${n.folder.files.length ? ` and its ${n.folder.files.length} logged document(s)` : ''}?`,
                { modal: true },
                'Delete'
            );
            if (ok !== 'Delete') return;
            data.folders = data.folders.filter((f) => f !== n!.folder);
        } else if (n.kind === 'file') {
            const ok = await vscode.window.showWarningMessage(
                `Remove ${n.file.doc} from "${n.folder.name}"${n.file.members.length ? ` with its ${n.file.members.length} logged member(s)` : ''}?`,
                { modal: true },
                'Remove'
            );
            if (ok !== 'Remove') return;
            n.folder.files = n.folder.files.filter((x) => x !== n!.file);
        } else {
            n.file.members = n.file.members.filter((m) => m !== n!.member);
        }
        if (selected?.id === n.id) selected = undefined;
        changed();
    });

    reg('export', async () => {
        const target = await vscode.window.showSaveDialog({
            title: 'Export Code Log',
            defaultUri: vscode.Uri.file(path.join(os.homedir(), 'code-log.json')),
            filters: { JSON: ['json'] }
        });
        if (!target) return;
        await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(data, null, 2), 'utf8'));
        vscode.window.showInformationMessage(`Code Log exported to ${target.fsPath}.`);
    });

    reg('import', async () => {
        const picked = await vscode.window.showOpenDialog({
            title: 'Import Code Log',
            canSelectMany: false,
            filters: { JSON: ['json'] }
        });
        if (!picked?.[0]) return;
        let incoming: LogData;
        try {
            const parsed = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(picked[0])).toString('utf8'));
            if (!isValidData(parsed)) throw new Error('not a Code Log export');
            incoming = normalize(parsed);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Couldn't import ${picked[0].fsPath}: ${e?.message || e}`);
            return;
        }
        const count = incoming.folders.reduce((n, f) => n + f.files.length, 0);
        const how = data.folders.length
            ? await vscode.window.showQuickPick(
                [
                    { label: 'Merge', description: 'Add to your current log. Matching folders, documents and members are combined.' },
                    { label: 'Replace', description: 'Discard your current log and use the imported one.' }
                ],
                { placeHolder: `Import ${incoming.folders.length} folder(s), ${count} document(s)`, ignoreFocusOut: true }
            )
            : { label: 'Replace' };
        if (!how) return;
        if (how.label === 'Replace') {
            if (data.folders.length) {
                const ok = await vscode.window.showWarningMessage('Replace your current Code Log with the imported one?', { modal: true }, 'Replace');
                if (ok !== 'Replace') return;
            }
            data = incoming;
        } else {
            mergeInto(data, incoming);
        }
        selected = undefined;
        changed();
        vscode.window.showInformationMessage(`Imported ${incoming.folders.length} folder(s), ${count} document(s).`);
    });
}

/** Merge by folder name, then document (server + namespace + name), then member name. Non-empty text wins. */
function mergeInto(target: LogData, incoming: LogData) {
    for (const inF of incoming.folders) {
        let f = target.folders.find((x) => x.name === inF.name);
        if (!f) {
            target.folders.push(inF);
            continue;
        }
        f.description ||= inF.description;
        for (const inFile of inF.files) {
            const file = f.files.find(
                (x) => x.doc.toLowerCase() === inFile.doc.toLowerCase() && x.server.toLowerCase() === inFile.server.toLowerCase() && x.ns === inFile.ns
            );
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
    heading: string;
    info: string[];
    fields: { key: 'name' | 'title' | 'description'; label: string; value: string; multiline: boolean }[];
    canOpen: boolean;
    openHint?: string;
}

function describeNode(n: Node): NodeView {
    if (n.kind === 'folder') {
        return {
            id: n.id,
            kind: 'folder',
            heading: n.folder.name,
            info: [`${n.folder.files.length} logged document(s)`],
            fields: [
                { key: 'name', label: 'Folder name', value: n.folder.name, multiline: false },
                { key: 'description', label: 'Description', value: n.folder.description, multiline: true }
            ],
            canOpen: false
        };
    }
    const open = !!folderFor(n.file.server, n.file.ns);
    const where = `Server: ${n.file.server} · Namespace: ${n.file.ns}`;
    const hint = open ? undefined : `Namespace ${n.file.ns} on ${n.file.server} isn't open in this workspace.`;
    if (n.kind === 'file') {
        return {
            id: n.id,
            kind: 'file',
            heading: n.file.doc,
            info: [where, `Folder: ${n.folder.name}`],
            fields: [
                { key: 'title', label: 'Title', value: n.file.title, multiline: false },
                { key: 'description', label: 'Description', value: n.file.description, multiline: true }
            ],
            canOpen: open,
            openHint: hint
        };
    }
    return {
        id: n.id,
        kind: 'member',
        heading: `${n.member.name}`,
        info: [`${n.member.kind} in ${n.file.doc}`, where],
        fields: [
            { key: 'title', label: 'Title', value: n.member.title, multiline: false },
            { key: 'description', label: 'Description', value: n.member.description, multiline: true }
        ],
        canOpen: open,
        openHint: hint
    };
}

class DetailsView implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private pending: NodeView | undefined;

    constructor(private readonly context: vscode.ExtensionContext, private readonly onMessage: (msg: any) => void) {}

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
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 8px 12px; }
    .empty { color: var(--vscode-descriptionForeground); margin-top: 8px; }
    h3 { margin: 4px 0 6px; font-size: 13px; word-break: break-all; }
    .info { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 2px 0; }
    label { display: block; margin: 12px 0 4px; font-size: 12px; color: var(--vscode-descriptionForeground); }
    input, textarea {
        width: 100%; box-sizing: border-box; padding: 4px 6px;
        color: var(--vscode-input-foreground); background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
        font-family: inherit; font-size: inherit;
    }
    input:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    textarea { min-height: 110px; resize: vertical; }
    .row { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
    button {
        color: var(--vscode-button-foreground); background: var(--vscode-button-background);
        border: none; padding: 4px 12px; border-radius: 2px; cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: .5; cursor: default; }
    .saved { font-size: 12px; color: var(--vscode-descriptionForeground); }
    .hint { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 6px; }
</style>
</head>
<body>
<div id="root"><div class="empty">Select a folder, document or member in the Code Log above to see and edit its notes.</div></div>
<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('root');
    let current = null;
    let timers = {};
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
            root.append(el('div', { className: 'empty', textContent: 'Select a folder, document or member in the Code Log above to see and edit its notes.' }));
            return;
        }
        root.append(el('h3', { textContent: node.heading, dir: 'auto' }));
        for (const line of node.info) root.append(el('div', { className: 'info', textContent: line, dir: 'auto' }));
        const saved = el('span', { className: 'saved' });
        for (const f of node.fields) {
            root.append(el('label', { textContent: f.label }));
            const input = f.multiline ? el('textarea', { value: f.value, dir: 'auto' }) : el('input', { value: f.value, dir: 'auto', type: 'text' });
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
            root.append(input);
        }
        const row = el('div', { className: 'row' });
        if (node.kind !== 'folder') {
            const open = el('button', { textContent: 'Go to code', disabled: !node.canOpen });
            open.addEventListener('click', () => vscode.postMessage({ type: 'open', id: node.id }));
            row.append(open);
        }
        row.append(saved);
        root.append(row);
        if (node.openHint) root.append(el('div', { className: 'hint', textContent: node.openHint }));
    }

    window.addEventListener('message', (e) => {
        if (e.data?.type !== 'show') return;
        const node = e.data.node;
        // Don't wipe what's being typed when the same item is re-sent.
        if (node && current && node.id === current.id && root.contains(document.activeElement) && document.activeElement !== document.body) {
            current = node;
            return;
        }
        render(node);
    });
    vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
    }
}
