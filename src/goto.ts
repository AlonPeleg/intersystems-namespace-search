import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Go To (Studio Ctrl+G equivalent) - bound to Ctrl+Alt+G.
//
// Accepts the same references Studio's "Go To" dialog does:
//   SetTavla^WBLRSHOWFF              -> open WBLRSHOWFF, jump to label SetTavla
//   SetTavla+3^WBLRSHOWFF            -> 3 lines below that label
//   $$call^Tafnit.App.UI.bl.func.setApp(x) -> "$$" and the argument list are ignored
//   ^WBLRSHOWFF / ^WBLRSHOWFF.int    -> open the routine at the top (or the exact type)
//   +12^WBLRSHOWFF                   -> 12th line of the routine (M-style, +1 = first line)
//   ##class(Tafnit.App.X).Method     -> open the class, jump to the method
//   Tafnit.App.X.cls                 -> open the class at the top
//   SetTavla / SetTavla+3            -> label in the current file
//   42                               -> line 42 of the current file
//
// Deliberately independent of the search code: it never calls the Atelier
// search API. It only turns the name into an ISFS path (dots -> folders, the
// same mapping ISFS itself uses), confirms it with a cheap stat(), reads that
// one document and finds the label - so it behaves identically on every
// server version, including old ones where server-side search is unreliable.
// ---------------------------------------------------------------------------

type Logger = (message: string) => void;

interface GoToTarget {
    /** Document name without extension, e.g. "WBLRSHOWFF" or "Tafnit.App.X". Undefined = current file. */
    docName?: string;
    /** Explicit extension typed by the user (".mac", ".int", ".cls", ".inc"), if any. */
    explicitExt?: string;
    /** True for ##class(...) / Pkg.Cls.cls references - only .cls is tried. */
    isClassRef: boolean;
    label?: string;
    offset: number;
    /** A bare line number for the current file (1-based). */
    lineNumber?: number;
}

const DOC_EXTENSIONS = ['.mac', '.int', '.inc', '.cls'];
const LAST_INPUT_KEY = 'isfsNamespaceSearch.goTo.lastInput';

function isIsfsUri(uri: vscode.Uri | undefined): boolean {
    return !!uri && (uri.scheme === 'isfs' || uri.scheme === 'isfs-readonly');
}

export function parseGoToInput(raw: string): GoToTarget | undefined {
    let s = raw.trim();
    if (!s) return undefined;

    // Leading command keywords someone may have copied along with the reference.
    s = s.replace(/^(do|d|job|j|goto|g)\s+/i, '');

    if (/^\d+$/.test(s)) {
        return { isClassRef: false, offset: 0, lineNumber: parseInt(s, 10) };
    }

    // ##class(Pkg.Cls).Method(args)  or  ##class(Pkg.Cls)
    const classMatch = /^##class\(\s*([%\w.]+)\s*\)(?:\s*\.\s*(?:#)?([%\w]+))?/i.exec(s);
    if (classMatch) {
        return { docName: classMatch[1], isClassRef: true, label: classMatch[2], offset: 0 };
    }

    // Extrinsic function prefix ($$label^rtn) and argument list (label^rtn(a,b)).
    s = s.replace(/^\$\$/, '');
    s = s.replace(/\(.*$/, '').trim();

    const caret = s.indexOf('^');
    if (caret >= 0) {
        const left = s.substring(0, caret).trim();
        let doc = s.substring(caret + 1).trim();
        if (!doc) return undefined;

        let explicitExt: string | undefined;
        const extMatch = /\.(mac|int|inc|cls)$/i.exec(doc);
        if (extMatch) {
            explicitExt = '.' + extMatch[1].toLowerCase();
            doc = doc.substring(0, doc.length - extMatch[0].length);
        }

        const { label, offset } = parseLabelAndOffset(left);
        return { docName: doc, explicitExt, isClassRef: explicitExt === '.cls', label, offset };
    }

    // No caret: either a full document name with an extension (open that
    // document), or a label[+offset] in the current file.
    const docWithExt = /^([%\w.]+)\.(mac|int|inc|cls)$/i.exec(s);
    if (docWithExt && docWithExt[1].length) {
        const ext = '.' + docWithExt[2].toLowerCase();
        return { docName: docWithExt[1], explicitExt: ext, isClassRef: ext === '.cls', offset: 0 };
    }

    // A dotted name with no extension (e.g. "Tafnit.App.X") can't be a
    // label, so treat it as a document name and try every type.
    if (/^%?[\w]+(\.[\w]+)+$/.test(s)) {
        return { docName: s, isClassRef: false, offset: 0 };
    }

    const { label, offset } = parseLabelAndOffset(s);
    if (!label && offset === 0) return undefined;
    return { isClassRef: false, label, offset };
}

function parseLabelAndOffset(text: string): { label?: string; offset: number } {
    const m = /^([%\w]*)\s*(?:\+\s*(\d+))?$/.exec(text.trim());
    if (!m) return { label: text.trim() || undefined, offset: 0 };
    return { label: m[1] || undefined, offset: m[2] ? parseInt(m[2], 10) : 0 };
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Finds the 0-based line of a label (routines) or member (classes).
 * Exact case first (ObjectScript labels are case-sensitive), then a
 * case-insensitive pass so a mistyped case still lands somewhere useful.
 */
export function findLabelLine(lines: string[], label: string, isClass: boolean): number | null {
    const escaped = escapeRegExp(label);
    const patterns: RegExp[] = [];
    if (isClass) {
        patterns.push(new RegExp(
            `^\\s*(ClassMethod|ClientMethod|Method|Parameter|Property|Query|Relationship|XData|Trigger|Index|ForeignKey|Storage|Projection)\\s+${escaped}\\b`,
            'i'
        ));
    }
    // An M label: starts in column 1, followed by an argument list,
    // whitespace, a comment, or end of line. Also applies to labels inside
    // class method bodies.
    patterns.push(new RegExp(`^${escaped}(?:\\(|\\s|;|$)`));

    for (const caseInsensitive of [false, true]) {
        for (const p of patterns) {
            const re = caseInsensitive ? new RegExp(p.source, 'i') : p;
            for (let i = 0; i < lines.length; i++) {
                if (re.test(lines[i])) return i;
            }
        }
    }
    return null;
}

async function statIsFile(uri: vscode.Uri): Promise<boolean> {
    try {
        const st = await vscode.workspace.fs.stat(uri);
        return (st.type & vscode.FileType.File) !== 0;
    } catch {
        return false;
    }
}

function candidateExtensions(target: GoToTarget): string[] {
    if (target.explicitExt) return [target.explicitExt];
    if (target.isClassRef) return ['.cls'];
    // label^name is a routine reference in ObjectScript, so routine types
    // come first; .cls last for anyone typing a class name this way.
    return DOC_EXTENSIONS;
}

/** Resolves a document name to an existing ISFS file URI, or undefined. */
async function resolveDocumentUri(
    root: vscode.Uri,
    docName: string,
    exts: string[],
    log: Logger
): Promise<vscode.Uri | undefined> {
    const segments = docName.split('.').filter(Boolean);
    if (!segments.length) return undefined;

    // 1. Exact path, dots -> folders (how ISFS lays out classes and dotted routines).
    for (const ext of exts) {
        const uri = vscode.Uri.joinPath(root, ...segments.slice(0, -1), segments[segments.length - 1] + ext);
        if (await statIsFile(uri)) return uri;
    }

    // 2. Flat file at the root with the dotted name kept intact.
    if (segments.length > 1) {
        for (const ext of exts) {
            const uri = vscode.Uri.joinPath(root, docName + ext);
            if (await statIsFile(uri)) return uri;
        }
    }

    // 3. Case-insensitive walk, one directory listing per segment - only
    //    reached when the name was typed with different casing.
    log(`Go To: exact path for "${docName}" not found, trying a case-insensitive lookup.`);
    let current = root;
    for (let i = 0; i < segments.length - 1; i++) {
        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(current);
        } catch {
            return undefined;
        }
        const dir = entries.find(([n, t]) => (t & vscode.FileType.Directory) !== 0 && n.toLowerCase() === segments[i].toLowerCase());
        if (!dir) return undefined;
        current = vscode.Uri.joinPath(current, dir[0]);
    }
    try {
        const entries = await vscode.workspace.fs.readDirectory(current);
        const base = segments[segments.length - 1].toLowerCase();
        for (const ext of exts) {
            const hit = entries.find(([n, t]) => (t & vscode.FileType.File) !== 0 && n.toLowerCase() === base + ext);
            if (hit) return vscode.Uri.joinPath(current, hit[0]);
        }
    } catch {
        // fall through
    }
    return undefined;
}

const LAST_NAMESPACE_KEY = 'isfsNamespaceSearch.goTo.lastNamespace';

/**
 * With one isfs namespace open, uses it directly. With several, always asks
 * which one to open the document in. The namespace of the file you're in is
 * listed first (then the one picked last time), so Enter alone keeps you in
 * the current namespace.
 */
async function pickNamespaceFolder(context: vscode.ExtensionContext, docName: string): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(f => isIsfsUri(f.uri));
    if (folders.length <= 1) return folders[0];

    const active = vscode.window.activeTextEditor?.document.uri;
    const currentFolder = isIsfsUri(active) ? vscode.workspace.getWorkspaceFolder(active!) : undefined;
    const lastId = context.workspaceState.get<string>(LAST_NAMESPACE_KEY);

    const rank = (f: vscode.WorkspaceFolder) =>
        currentFolder && f.uri.toString() === currentFolder.uri.toString() ? 0
        : f.uri.toString() === lastId ? 1
        : 2;
    const ordered = [...folders].sort((a, b) => rank(a) - rank(b) || a.index - b.index);

    const picked = await vscode.window.showQuickPick(
        ordered.map(f => {
            const tags: string[] = [];
            if (rank(f) === 0) tags.push('current file');
            else if (rank(f) === 1) tags.push('last used');
            return {
                label: f.name,
                description: [decodeURIComponent(f.uri.authority), ...tags].join('  ·  '),
                folder: f
            };
        }),
        { title: `Go To: ${docName}`, placeHolder: 'Open it in which namespace?' }
    );
    if (picked) await context.workspaceState.update(LAST_NAMESPACE_KEY, picked.folder.uri.toString());
    return picked?.folder;
}

/** Prefill: a label^routine reference under the cursor, else the selection, else the last input. */
function getInitialValue(context: vscode.ExtensionContext): string {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        const sel = editor.selection;
        if (!sel.isEmpty) {
            const text = editor.document.getText(sel).trim();
            if (text && !text.includes('\n')) return text;
        }
        const refRange = editor.document.getWordRangeAtPosition(
            sel.active,
            /(?:\$\$)?[%\w]*(?:\+\d+)?\^[%\w.]+|##class\([%\w.]+\)(?:\.#?[%\w]+)?/i
        );
        if (refRange) return editor.document.getText(refRange);
    }
    return context.workspaceState.get<string>(LAST_INPUT_KEY, '');
}

async function revealLine(uri: vscode.Uri, line: number) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
    const safeLine = Math.max(0, Math.min(line, doc.lineCount - 1));
    const pos = new vscode.Position(safeLine, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    await focusEditor(editor);
}

/**
 * Closing the input box / namespace picker hands focus back to whatever had
 * it before (Explorer, the search panel, ...), and on ISFS that restore can
 * land after the document has opened, stealing focus from the editor. So
 * focus the editor explicitly, and once more shortly after to win that race.
 */
async function focusEditor(editor: vscode.TextEditor) {
    const refocus = async () => {
        await vscode.window.showTextDocument(editor.document, {
            viewColumn: editor.viewColumn,
            preview: false,
            preserveFocus: false,
            selection: editor.selection
        });
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    };
    await refocus();
    await new Promise(resolve => setTimeout(resolve, 150));
    if (vscode.window.activeTextEditor?.document.uri.toString() === editor.document.uri.toString()) {
        await refocus();
    }
}

function computeTargetLine(lines: string[], target: GoToTarget, isClass: boolean, docLabel: string): number | null {
    if (target.lineNumber !== undefined) return target.lineNumber - 1;
    if (!target.label) {
        // "+N^rtn": M-style, +1 is the first line. "^rtn" alone: top.
        return target.offset > 0 ? target.offset - 1 : 0;
    }
    const labelLine = findLabelLine(lines, target.label, isClass);
    if (labelLine === null) {
        vscode.window.showWarningMessage(`Label "${target.label}" not found in ${docLabel}.`);
        return null;
    }
    return labelLine + target.offset;
}

async function runGoTo(context: vscode.ExtensionContext, log: Logger) {
    const input = await vscode.window.showInputBox({
        title: 'Go To (InterSystems)',
        prompt: 'label^routine, label+offset^routine, ^routine, ##class(Pkg.Cls).Method, Pkg.Cls.cls, label, or a line number',
        placeHolder: 'SetTavla^WBLRSHOWFF',
        value: getInitialValue(context),
        valueSelection: undefined,
        ignoreFocusOut: false
    });
    if (input === undefined) return;

    const target = parseGoToInput(input);
    if (!target) {
        vscode.window.showWarningMessage(`Go To: couldn't understand "${input}".`);
        return;
    }
    await context.workspaceState.update(LAST_INPUT_KEY, input.trim());
    log(`Go To: "${input}" -> ${JSON.stringify(target)}`);

    // Current-file jump (bare label or line number).
    if (!target.docName) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('Go To: no open file to jump within. Use label^routine to open another document.');
            return;
        }
        const doc = editor.document;
        const isClass = /\.cls$/i.test(doc.uri.path);
        const lines = doc.getText().split(/\r?\n/);
        const line = computeTargetLine(lines, target, isClass, doc.uri.path.split('/').pop() || 'this file');
        if (line !== null) await revealLine(doc.uri, line);
        return;
    }

    const folder = await pickNamespaceFolder(context, input.trim());
    if (!folder) {
        // Escape on the namespace picker is a cancel, not an error.
        if ((vscode.workspace.workspaceFolders ?? []).some(f => isIsfsUri(f.uri))) return;
        vscode.window.showWarningMessage('Go To: no InterSystems (isfs) namespace folder is open in this workspace.');
        return;
    }

    const docName = target.docName;
    const uri = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `Go To: locating ${docName}...` },
        () => resolveDocumentUri(folder.uri, docName, candidateExtensions(target), log)
    );
    if (!uri) {
        log(`Go To: "${docName}" not found in ${folder.name}.`);
        vscode.window.showWarningMessage(`Go To: "${docName}" was not found in ${folder.name}.`);
        return;
    }
    log(`Go To: resolved to ${uri.toString()}`);

    const doc = await vscode.workspace.openTextDocument(uri);
    const isClass = /\.cls$/i.test(uri.path);
    const lines = doc.getText().split(/\r?\n/);
    const line = computeTargetLine(lines, target, isClass, uri.path.split('/').pop() || docName);
    // Label missing: still open the document at the top rather than doing nothing.
    await revealLine(uri, line ?? 0);
}

export function registerGoTo(context: vscode.ExtensionContext, log: Logger) {
    context.subscriptions.push(
        vscode.commands.registerCommand('isfsNamespaceSearch.goTo', () =>
            runGoTo(context, log).catch((e: any) => {
                log(`Go To failed: ${e?.message || e}`);
                vscode.window.showErrorMessage(`Go To failed: ${e?.message || e}`);
            })
        )
    );
}
