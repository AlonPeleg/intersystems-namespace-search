// Text for "Open in Editor" and "Compare with now" on a search (Current Search or a Search History entry).
// Plain functions with no VS Code dependency: they turn a search run into the text of a read-only document and say,
// for each line of it, which server document and line that line opens.

/** One match as the sidebar keeps it (the data-matches JSON of a result row). member / offset only come from a
 *  server-side search, when the server tags the match with the method or label it is in (offset from its start). */
export interface SearchMatch {
    line: number;           // 0-based
    column: number;
    lineText: string;
    uri: string;
    member?: string;
    offset?: number;
}

export interface SearchGroup {
    fileName: string;       // as the sidebar shows it (utils.cls)
    docName?: string;       // full document name when known (Tafnit.App.VirtualMortgage.utils.cls)
    uri: string;
    matches: SearchMatch[];
}

export interface SearchRun {
    namespace: string;      // the namespace folder's name, e.g. phoenix-dev-29:UHMXLQDMZTBRRDDXRTNRHBK
    query: string;
    masks: string[];
    useWildcards: boolean;
    when: string;           // how the run's time is shown, e.g. "22 Oct 2026 12:04" (old entries: "12:04")
    totalMatches?: number;
    groups: SearchGroup[];
}

/** Where a line of the document leads: the document (line 0 for its name row) and the match position. */
export interface SearchTarget { uri: string; line: number; column: number; }

export interface RenderedSearch {
    text: string;
    /** One entry per line of `text`; undefined for lines that open nothing (the header, blank lines). */
    targets: (SearchTarget | undefined)[];
}

const BAR = '│';

function nameOf(g: SearchGroup): string { return g.docName || g.fileName; }

/** label+offset the way the server's own log writes it: getSchema+4, or the label alone at offset 0. */
export function memberLabel(m: SearchMatch): string {
    if (!m.member) return '';
    return m.offset ? m.member + '+' + m.offset : m.member;
}

/** Groups sorted by name and each group's matches by line, with a line that matched more than once shown once. */
export function tidyGroups(groups: SearchGroup[]): SearchGroup[] {
    return groups
        .map(g => {
            const seen = new Set<number>();
            const matches = g.matches
                .slice()
                .sort((a, b) => a.line - b.line || a.column - b.column)
                .filter(m => { if (seen.has(m.line)) return false; seen.add(m.line); return true; });
            return { ...g, matches };
        })
        .filter(g => g.matches.length > 0)
        .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
}

function countOf(run: SearchRun): { matches: number; docs: number } {
    const matches = typeof run.totalMatches === 'number' ? run.totalMatches : run.groups.reduce((n, g) => n + g.matches.length, 0);
    return { matches, docs: run.groups.filter(g => g.matches.length).length };
}

function header(run: SearchRun, extra?: string): string[] {
    const c = countOf(run);
    const lines = [
        '# Namespace Search · ' + run.namespace,
        '# Search:   ' + run.query,
        '# Mask:     ' + (run.masks.length ? run.masks.join(', ') : '(default)') + '    Wildcards: ' + (run.useWildcards ? 'on' : 'off'),
        '# Run:      ' + run.when + ' · ' + c.matches + ' match' + (c.matches === 1 ? '' : 'es') + ' in ' + c.docs + ' document' + (c.docs === 1 ? '' : 's')
    ];
    if (extra) lines.push('# ' + extra);
    return lines;
}

/** "Open in Editor": the search as a document - its settings, then each document with its matching lines as
 *  "line │ label+offset │ code". */
export function renderSearch(run: SearchRun): RenderedSearch {
    const lines: string[] = [];
    const targets: (SearchTarget | undefined)[] = [];
    const push = (text: string, t?: SearchTarget) => { lines.push(text); targets.push(t); };

    header(run, 'Ctrl+Click, F12 or Enter on a line opens it').forEach(h => push(h));
    const groups = tidyGroups(run.groups);
    const numW = Math.max(1, ...groups.flatMap(g => g.matches.map(m => String(m.line + 1).length)));
    const memW = Math.max(0, ...groups.flatMap(g => g.matches.map(m => memberLabel(m).length)));
    if (!groups.length) { push(''); push('(no matches)'); }
    for (const g of groups) {
        push('');
        push(nameOf(g) + '  (' + g.matches.length + ')', { uri: g.uri, line: 0, column: 0 });
        for (const m of g.matches) {
            const num = String(m.line + 1).padStart(numW + 2);
            const mem = memW ? ' ' + memberLabel(m).padEnd(memW) + ' ' + BAR : '';
            push(num + ' ' + BAR + mem + ' ' + m.lineText, { uri: m.uri || g.uri, line: m.line, column: m.column });
        }
    }
    return { text: lines.join('\n') + '\n', targets };
}

/** One side of "Compare with now". No line numbers and no offsets, so a match that only moved (lines added above
 *  it) is the same text on both sides and the diff does not report it; the label stays, so a changed line pairs with
 *  its old self. Each line still opens the real position. */
export function renderForCompare(run: SearchRun, side: string): RenderedSearch {
    const lines: string[] = [];
    const targets: (SearchTarget | undefined)[] = [];
    const push = (text: string, t?: SearchTarget) => { lines.push(text); targets.push(t); };

    header(run, side).forEach(h => push(h));
    const groups = tidyGroups(run.groups);
    const memW = Math.max(0, ...groups.flatMap(g => g.matches.map(m => (m.member || '').length)));
    if (!groups.length) { push(''); push('(no matches)'); }
    for (const g of groups) {
        push('');
        push(nameOf(g), { uri: g.uri, line: 0, column: 0 });
        for (const m of g.matches) {
            const mem = memW ? (m.member || '').padEnd(memW) + ' ' + BAR + ' ' : '';
            push('  ' + mem + m.lineText, { uri: m.uri || g.uri, line: m.line, column: m.column });
        }
    }
    return { text: lines.join('\n') + '\n', targets };
}

/** Full document name from its isfs path below the namespace folder (Tafnit/App/X.cls -> Tafnit.App.X.cls). Web
 *  files (under /csp/...) keep their path. */
export function docNameFromPath(path: string, folderPath: string): string {
    let rel = path;
    const base = folderPath.replace(/\/+$/, '');
    if (base && rel.toLowerCase().startsWith(base.toLowerCase() + '/')) rel = rel.slice(base.length + 1);
    rel = rel.replace(/^\/+/, '');
    if (/\.(cls|mac|int|inc|bas|mvb|mvi)$/i.test(rel)) return rel.replace(/\//g, '.');
    return '/' + rel;
}

/** A file-name-safe short title for a tab: the search text cut to `max` characters. */
export function shortTitle(text: string, max = 40): string {
    const t = text.replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    return (t.length > max ? t.slice(0, max - 1) + '…' : t) || 'search';
}
