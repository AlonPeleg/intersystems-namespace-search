// Search results in an editor: "Open in Editor" (a search as a read-only document) and "Compare with now" (that
// search next to a fresh run of it, in VS Code's diff editor - its Inline / Side by Side switch gives both views).
// The text comes from searchFormat.ts; this file serves it, colors the search term and opens the code a line points at.
import * as vscode from 'vscode';
import { RenderedSearch, SearchRun, SearchTarget, renderForCompare, renderSearch, shortTitle } from './searchFormat';

export const SEARCH_DOC_SCHEME = 'isfs-search';
const KEEP = 40;   // documents kept in memory (each Open / Compare makes new ones)

interface Served extends RenderedSearch { pattern?: RegExp; }
const docs = new Map<string, Served>();
let seq = 0;
const changed = new vscode.EventEmitter<vscode.Uri>();

function serve(title: string, r: RenderedSearch, pattern?: RegExp): vscode.Uri {
    const id = String(++seq);
    docs.set(id, { ...r, pattern });
    while (docs.size > KEEP) docs.delete(docs.keys().next().value as string);
    return vscode.Uri.from({ scheme: SEARCH_DOC_SCHEME, path: '/' + title + '.isfs-search', query: id });
}
function servedFor(uri: vscode.Uri): Served | undefined {
    return uri.scheme === SEARCH_DOC_SCHEME ? docs.get(uri.query) : undefined;
}
function targetAt(uri: vscode.Uri, line: number): SearchTarget | undefined {
    return servedFor(uri)?.targets[line];
}

/** Opens a match the way a click on it in the sidebar does. */
export async function openSearchTarget(t: SearchTarget, preview = true) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(t.uri));
    const editor = await vscode.window.showTextDocument(doc, { preview, viewColumn: vscode.ViewColumn.Active });
    const pos = new vscode.Position(t.line, t.column);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

// ---- the search term, highlighted in the code lines ----
const termDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    borderRadius: '2px'
});
function decorate(editor: vscode.TextEditor) {
    const s = servedFor(editor.document.uri);
    if (!s || !s.pattern) return;
    const ranges: vscode.Range[] = [];
    const doc = editor.document;
    for (let i = 0; i < doc.lineCount && ranges.length < 5000; i++) {
        const text = doc.lineAt(i).text;
        if (!s.targets[i] || !/^\s/.test(text)) continue;   // only code lines (indented); not names or the header
        const codeAt = text.lastIndexOf('│ ') >= 0 ? text.lastIndexOf('│ ') + 2 : (text.match(/^\s*/) || [''])[0].length;
        const re = new RegExp(s.pattern.source, 'gi');
        re.lastIndex = codeAt;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            if (m[0].length === 0) { re.lastIndex++; continue; }
            ranges.push(new vscode.Range(i, m.index, i, m.index + m[0].length));
        }
    }
    editor.setDecorations(termDecoration, ranges);
}

/** Open in Editor: the run as a read-only document. `pattern`: the search as a regex, to highlight it. */
export async function openSearchDocument(run: SearchRun, pattern?: RegExp) {
    const uri = serve(shortTitle(run.query) + ' · ' + shortTitle(run.when, 20).replace(/:/g, '-'), renderSearch(run), pattern);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
}

/** Compare with now: `then` and `now` in the diff editor (Inline = changes in one column, Side by Side = both). */
export async function openSearchCompare(then: SearchRun, now: SearchRun, pattern?: RegExp) {
    const left = serve(shortTitle(then.query) + ' (then)', renderForCompare(then, 'Then: the search as it was'), pattern);
    const right = serve(shortTitle(then.query) + ' (now)', renderForCompare(now, 'Now: the same search, run again'), pattern);
    const title = shortTitle(then.query, 30) + ' · ' + then.when + ' ↔ now';
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: false });
}

export function registerSearchEditor(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        changed,
        termDecoration,
        vscode.workspace.registerTextDocumentContentProvider(SEARCH_DOC_SCHEME, {
            onDidChange: changed.event,
            provideTextDocumentContent: uri => servedFor(uri)?.text
                ?? '# This search result is no longer in memory (VS Code was restarted or many results were opened since).\n# Open it again from the Search panel.\n'
        }),
        // F12 / Ctrl+Click / Peek on any line of a result: goes to that document and line.
        vscode.languages.registerDefinitionProvider({ scheme: SEARCH_DOC_SCHEME }, {
            provideDefinition(doc, pos) {
                const t = targetAt(doc.uri, pos.line);
                return t ? new vscode.Location(vscode.Uri.parse(t.uri), new vscode.Position(t.line, t.column)) : undefined;
            }
        }),
        // Enter on a line (the documents are read-only, so Enter has nothing else to do there).
        vscode.commands.registerCommand('isfsNamespaceSearch.openSearchResultLine', async () => {
            const ed = vscode.window.activeTextEditor;
            if (!ed) return;
            const t = targetAt(ed.document.uri, ed.selection.active.line);
            if (t) await openSearchTarget(t, false);
            else vscode.window.setStatusBarMessage('This line does not point at a document.', 2500);
        }),
        vscode.window.onDidChangeVisibleTextEditors(eds => eds.forEach(decorate)),
        vscode.workspace.onDidOpenTextDocument(doc => {
            if (doc.uri.scheme !== SEARCH_DOC_SCHEME) return;
            if (doc.languageId !== 'isfs-search') vscode.languages.setTextDocumentLanguage(doc, 'isfs-search').then(undefined, () => undefined);
        })
    );
    vscode.window.visibleTextEditors.forEach(decorate);
}
