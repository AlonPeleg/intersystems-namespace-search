import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Bookmarks for server-side (isfs) documents.
//
//   Ctrl+F2       toggle a bookmark on the cursor line
//   F2            jump to the next bookmark in this file (wraps around)
//   Ctrl+Alt+F2   clear this file's bookmarks
//
// Bookmarks follow the text as you edit: lines added or removed above a
// bookmark move it with its line; deleting the bookmarked line removes it.
// They're listed in the "ISFS Bookmarks" sidebar, grouped
// namespace -> file -> bookmark, and saved per workspace.
//
// Also pins isfs documents as regular tabs when they open (instead of
// preview tabs), controlled by isfsNamespaceSearch.pinIsfsEditors.
// ---------------------------------------------------------------------------

type Logger = (message: string) => void;
type BookmarkMap = { [uri: string]: number[] };

const STORAGE_KEY = 'isfsNamespaceSearch.bookmarks';
const VIEW_ID = 'isfsNamespaceSearch.bookmarksView';
const CMD = 'isfsNamespaceSearch.bookmarks';

const GUTTER_ICON =
    'data:image/svg+xml;base64,' +
    Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
        '<path fill="#FFD04D" d="M3 2H13V14L10 11L7 14V2Z"/></svg>'
    ).toString('base64');

function isIsfs(uri: vscode.Uri): boolean {
    return uri.scheme === 'isfs' || uri.scheme === 'isfs-readonly';
}

function newlineCount(text: string): number {
    let n = 0;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
    return n;
}

/**
 * Where a bookmark on `line` ends up after one content change, or -1 if its
 * line was deleted.
 */
export function shiftLine(line: number, change: { range: vscode.Range; text: string }): number {
    const s = change.range.start;
    const e = change.range.end;
    const delta = newlineCount(change.text) - (e.line - s.line);

    if (line < s.line) return line;

    if (line === s.line) {
        // Whole lines removed or replaced, starting with this one:
        // range runs from column 0 of this line to column 0 of a later line.
        if (s.character === 0 && e.character === 0 && e.line > s.line) return -1;
        // Text inserted at the very start of the line (Enter, pasted lines):
        // the line's own text moves down below it, and so does the bookmark.
        if (s.character === 0 && e.line === s.line) return line + newlineCount(change.text);
        return line; // an edit on this line (or after its start) keeps it
    }

    if (line < e.line) return -1; // strictly inside the replaced range

    if (line === e.line) {
        // The start of this line was part of the range. Column 0 means the
        // line itself is intact (e.g. a join via Backspace): it just moves.
        return line + delta;
    }

    return line + delta; // below the change
}

export function registerBookmarks(context: vscode.ExtensionContext, log: Logger) {
    let bookmarks: BookmarkMap = context.workspaceState.get<BookmarkMap>(STORAGE_KEY, {});

    const decoration = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.parse(GUTTER_ICON),
        gutterIconSize: 'contain',
        overviewRulerColor: 'rgba(255, 208, 77, 0.8)',
        overviewRulerLane: vscode.OverviewRulerLane.Right
    });
    context.subscriptions.push(decoration);

    // ---- persistence (debounced: typing can fire many changes a second) ----
    let saveTimer: NodeJS.Timeout | undefined;
    const save = (immediate = false) => {
        if (saveTimer) clearTimeout(saveTimer);
        const doSave = () => {
            saveTimer = undefined;
            for (const k of Object.keys(bookmarks)) if (!bookmarks[k].length) delete bookmarks[k];
            context.workspaceState.update(STORAGE_KEY, bookmarks);
        };
        if (immediate) doSave();
        else saveTimer = setTimeout(doSave, 500);
    };
    context.subscriptions.push({ dispose: () => saveTimer && save(true) });

    // ---- tree view ----
    class NamespaceItem extends vscode.TreeItem {
        constructor(public readonly authority: string, count: number) {
            super(decodeURIComponent(authority), vscode.TreeItemCollapsibleState.Expanded);
            this.iconPath = new vscode.ThemeIcon('server');
            this.description = `${count} bookmark${count === 1 ? '' : 's'}`;
            this.contextValue = 'namespaceItem';
        }
    }

    class FileItem extends vscode.TreeItem {
        constructor(public readonly uri: vscode.Uri, count: number) {
            super(docNameOf(uri), vscode.TreeItemCollapsibleState.Collapsed);
            this.resourceUri = uri;
            this.iconPath = vscode.ThemeIcon.File;
            this.description = `${count} bookmark${count === 1 ? '' : 's'}`;
            this.tooltip = docNameOf(uri);
            this.contextValue = 'fileItem';
        }
    }

    class BookmarkItem extends vscode.TreeItem {
        constructor(label: string, public readonly uri: vscode.Uri, public readonly line: number, preview: string) {
            super(label, vscode.TreeItemCollapsibleState.None);
            this.description = `line ${line + 1}`;
            this.tooltip = preview || `line ${line + 1}`;
            this.iconPath = new vscode.ThemeIcon('bookmark');
            this.contextValue = 'bookmarkItem';
            this.command = { command: `${CMD}.reveal`, title: 'Go to bookmark', arguments: [uri, line] };
        }
    }

    type Node = NamespaceItem | FileItem | BookmarkItem;

    class BookmarkProvider implements vscode.TreeDataProvider<Node> {
        private emitter = new vscode.EventEmitter<Node | undefined | void>();
        readonly onDidChangeTreeData = this.emitter.event;
        refresh() { this.emitter.fire(); }
        getTreeItem(el: Node) { return el; }

        async getChildren(el?: Node): Promise<Node[]> {
            const uris = Object.keys(bookmarks).filter((u) => bookmarks[u].length);
            if (!el) {
                const byNs = new Map<string, number>();
                for (const u of uris) {
                    const a = vscode.Uri.parse(u).authority;
                    byNs.set(a, (byNs.get(a) ?? 0) + bookmarks[u].length);
                }
                return [...byNs.entries()]
                    .sort((a, b) => a[0].localeCompare(b[0]))
                    .map(([a, n]) => new NamespaceItem(a, n));
            }
            if (el instanceof NamespaceItem) {
                return uris
                    .map((u) => vscode.Uri.parse(u))
                    .filter((u) => u.authority === el.authority)
                    .sort((a, b) => docNameOf(a).localeCompare(docNameOf(b)))
                    .map((u) => new FileItem(u, bookmarks[u.toString()].length));
            }
            if (el instanceof FileItem) {
                const lines = [...(bookmarks[el.uri.toString()] ?? [])].sort((a, b) => a - b);
                let text: string[] = [];
                try {
                    text = (await vscode.workspace.openTextDocument(el.uri)).getText().split(/\r?\n/);
                } catch {
                    // Document unavailable (server down, deleted): still list the lines.
                }
                const isClass = /\.cls$/i.test(el.uri.path);
                return lines.map((l) => new BookmarkItem(labelFor(text, l, isClass), el.uri, l, (text[l] ?? '').trim()));
            }
            return [];
        }
    }

    const provider = new BookmarkProvider();
    context.subscriptions.push(vscode.window.registerTreeDataProvider(VIEW_ID, provider));

    // ---- decorations ----
    const decorate = (editor: vscode.TextEditor) => {
        if (!isIsfs(editor.document.uri)) return;
        const lines = bookmarks[editor.document.uri.toString()] ?? [];
        editor.setDecorations(decoration, lines.map((l) => new vscode.Range(l, 0, l, 0)));
    };
    const decorateUri = (uri: string) => {
        for (const ed of vscode.window.visibleTextEditors) if (ed.document.uri.toString() === uri) decorate(ed);
    };
    const changed = (uri: string, immediate = false) => {
        decorateUri(uri);
        provider.refresh();
        save(immediate);
    };
    vscode.window.visibleTextEditors.forEach(decorate);

    // ---- follow the text as it's edited ----
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (!e.contentChanges.length || !isIsfs(e.document.uri)) return;
            const key = e.document.uri.toString();
            const current = bookmarks[key];
            if (!current?.length) return;

            // Changes don't overlap and refer to the pre-edit document, so
            // apply them bottom-up to keep earlier positions valid.
            const changes = [...e.contentChanges].sort((a, b) => b.range.start.compareTo(a.range.start));
            let lines = current;
            for (const c of changes) lines = lines.map((l) => shiftLine(l, c)).filter((l) => l >= 0);
            const maxLine = e.document.lineCount - 1;
            lines = [...new Set(lines.map((l) => Math.min(l, maxLine)))].sort((a, b) => a - b);

            const same = lines.length === current.length && lines.every((l, i) => l === current[i]);
            if (same) return;
            if (lines.length < current.length) log(`Bookmarks: ${current.length - lines.length} removed with deleted line(s) in ${docNameOf(e.document.uri)}.`);
            bookmarks[key] = lines;
            changed(key);
        }),
        vscode.window.onDidChangeVisibleTextEditors((eds) => eds.forEach(decorate))
    );

    // ---- pin isfs documents (no preview tabs) ----
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async (editor) => {
            if (!editor || !isIsfs(editor.document.uri)) return;
            decorate(editor);
            if (!vscode.workspace.getConfiguration('isfsNamespaceSearch').get<boolean>('pinIsfsEditors', true)) return;
            await vscode.commands.executeCommand('workbench.action.keepEditor');
            // Some openers mark the tab as preview a moment later; pin again.
            setTimeout(() => {
                if (vscode.window.activeTextEditor === editor) {
                    vscode.commands.executeCommand('workbench.action.keepEditor');
                }
            }, 150);
        })
    );

    // ---- commands ----
    const reveal = async (uri: vscode.Uri, line: number) => {
        const editor = await vscode.window.showTextDocument(uri, { preview: false });
        const safe = Math.max(0, Math.min(line, editor.document.lineCount - 1));
        const pos = new vscode.Position(safe, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    };

    context.subscriptions.push(
        vscode.commands.registerCommand(`${CMD}.toggle`, () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !isIsfs(editor.document.uri)) return;
            const key = editor.document.uri.toString();
            const set = new Set(bookmarks[key] ?? []);
            // Every cursor's line; with one cursor that's just the current line.
            const cursorLines = [...new Set(editor.selections.map((s) => s.active.line))];
            const allMarked = cursorLines.every((l) => set.has(l));
            for (const l of cursorLines) allMarked ? set.delete(l) : set.add(l);
            bookmarks[key] = [...set].sort((a, b) => a - b);
            changed(key, true);
        }),

        vscode.commands.registerCommand(`${CMD}.next`, () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !isIsfs(editor.document.uri)) return;
            const lines = bookmarks[editor.document.uri.toString()] ?? [];
            if (!lines.length) return;
            const cur = editor.selection.active.line;
            const next = lines.find((l) => l > cur) ?? lines[0];
            reveal(editor.document.uri, next);
        }),

        vscode.commands.registerCommand(`${CMD}.clearFile`, (item?: FileItem) => {
            const uri = item instanceof FileItem ? item.uri : vscode.window.activeTextEditor?.document.uri;
            if (!uri || !isIsfs(uri)) return;
            delete bookmarks[uri.toString()];
            changed(uri.toString(), true);
        }),

        vscode.commands.registerCommand(`${CMD}.clearNamespace`, (item: NamespaceItem) => {
            if (!(item instanceof NamespaceItem)) return;
            for (const k of Object.keys(bookmarks)) {
                if (vscode.Uri.parse(k).authority === item.authority) {
                    delete bookmarks[k];
                    decorateUri(k);
                }
            }
            provider.refresh();
            save(true);
        }),

        vscode.commands.registerCommand(`${CMD}.delete`, (item: BookmarkItem) => {
            if (!(item instanceof BookmarkItem)) return;
            const key = item.uri.toString();
            bookmarks[key] = (bookmarks[key] ?? []).filter((l) => l !== item.line);
            changed(key, true);
        }),

        vscode.commands.registerCommand(`${CMD}.reveal`, (uri: vscode.Uri, line: number) =>
            reveal(uri, line).catch((e: any) => vscode.window.showErrorMessage(`Couldn't open bookmark: ${e?.message || e}`))
        )
    );
}

/** "Pkg.Sub.Cls.cls" / "ROUTINE.mac" from an isfs uri. */
function docNameOf(uri: vscode.Uri): string {
    return uri.path.replace(/^\//, '').split('/').join('.');
}

/**
 * "label", "label+3" or "Method+2" for the bookmarked line, found by walking
 * up to the nearest routine label (column 1) or class member declaration.
 */
function labelFor(text: string[], line: number, isClass: boolean): string {
    const member = /^\s*(?:ClassMethod|ClientMethod|Method|Query|Trigger)\s+(%?\w+)/i;
    const label = /^(%?[A-Za-z0-9]+)(?:\(|\s|;|$)/;
    for (let i = Math.min(line, text.length - 1); i >= 0; i--) {
        const t = text[i];
        const m = isClass ? member.exec(t) : /^ROUTINE\s/i.test(t) ? null : label.exec(t);
        if (m) return line === i ? m[1] : `${m[1]}+${line - i}`;
    }
    return `Line ${line + 1}`;
}
