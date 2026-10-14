// Builds what "Copy as Code Block" puts on the clipboard: code as HTML with the colors of a chosen theme (by default
// InterSystems Default Light Modern), in a light box that Outlook, Teams and Word keep when pasted, plus the same code
// as plain text. No VS Code API here, so it can be tested on its own.

/** A colored piece of the copied text: [start, end) within one line (UTF-16 indexes, as VS Code gives them). */
export interface ColorSpan { start: number; end: number; color?: string; bold?: boolean; italic?: boolean; }

export interface CodeBlockOptions {
    tabSize: number;
    dedent: boolean;           // drop the indentation all copied lines share
    box: boolean;              // the light box with a border around the code
    background: string;        // box background
    border: string;            // box border color
    foreground: string;        // color of text no token colors
    fontSize: string;          // e.g. "10pt"
}

/** Expands tabs to spaces (tab stops every tabSize columns) and keeps the spans pointing at the same characters. */
function expandTabs(line: string, spans: ColorSpan[], tabSize: number): { text: string; spans: ColorSpan[] } {
    if (!line.includes('\t')) return { text: line, spans };
    const map: number[] = [];              // old index -> new index
    let text = '';
    for (let i = 0; i < line.length; i++) {
        map.push(text.length);
        if (line[i] === '\t') text += ' '.repeat(tabSize - (text.length % tabSize));
        else text += line[i];
    }
    map.push(text.length);
    return { text, spans: spans.map(s => ({ ...s, start: map[s.start], end: map[s.end] })) };
}

/** Escapes text for HTML and writes every non-ASCII character as &#N; so the HTML is plain ASCII (the clipboard's
 *  HTML format counts bytes; ASCII keeps that simple and Hebrew safe on every code page). */
function esc(s: string): string {
    let out = '';
    for (const ch of s) {
        const cp = ch.codePointAt(0) as number;
        if (ch === '&') out += '&amp;';
        else if (ch === '<') out += '&lt;';
        else if (ch === '>') out += '&gt;';
        else if (ch === '"') out += '&quot;';
        else if (cp > 126) out += '&#' + cp + ';';
        else out += ch;
    }
    return out;
}

/** Spaces as the mail programs keep them: leading spaces and runs of spaces as &nbsp; (a single space between
 *  words stays a normal space, so long lines can still wrap). */
function spaces(htmlText: string, leading: boolean): string {
    return htmlText.replace(/ {2,}|^ /g, m => (leading || m.length > 1) ? '&nbsp;'.repeat(m.length) : m);
}

/** Lines + their color spans -> { html, text }. */
export function buildCodeBlock(lines: string[], spansPerLine: ColorSpan[][], o: CodeBlockOptions): { html: string; text: string } {
    let rows = lines.map((l, i) => expandTabs(l, spansPerLine[i] || [], Math.max(1, o.tabSize)));
    // trailing whitespace and empty lines at the ends are dropped
    rows = rows.map(r => ({ text: r.text.replace(/\s+$/, ''), spans: r.spans }));
    while (rows.length && !rows[0].text) rows.shift();
    while (rows.length && !rows[rows.length - 1].text) rows.pop();
    if (o.dedent) {
        const ind = rows.filter(r => r.text).map(r => (/^ */.exec(r.text) as RegExpExecArray)[0].length);
        const cut = ind.length ? Math.min(...ind) : 0;
        if (cut) rows = rows.map(r => ({
            text: r.text.slice(Math.min(cut, r.text.length)),
            spans: r.spans.map(s => ({ ...s, start: Math.max(0, s.start - cut), end: Math.max(0, s.end - cut) })).filter(s => s.end > s.start)
        }));
    }
    const text = rows.map(r => r.text).join('\n');

    const font = "font-family:Consolas,'Courier New',monospace;font-size:" + o.fontSize + ';';
    // Each line is a left-to-right paragraph. In the box, the paragraphs carry the background (Word shades
    // paragraphs, not divs) and the div around them the border: Word's own HTML for a bordered block of paragraphs
    // (mso-element:para-border-div), which Outlook keeps when pasting; browsers and Teams draw the same box.
    const shade = o.box ? 'background:' + o.background + ';' : '';
    const pStyle = 'margin:0;' + shade + 'border:none;padding:0;' + font + 'color:' + o.foreground + ';text-align:left;direction:ltr;unicode-bidi:embed;';
    const htmlLines = rows.map(r => {
        if (!r.text) return '<p dir="ltr" style="' + pStyle + '">&nbsp;</p>';
        const spans = r.spans.filter(s => s.start < r.text.length).map(s => ({ ...s, end: Math.min(s.end, r.text.length) })).sort((a, b) => a.start - b.start);
        let out = '', at = 0;
        const plain = (from: number, to: number) => { if (to > from) out += spaces(esc(r.text.slice(from, to)), from === 0); };
        for (const s of spans) {
            if (s.start < at) continue;                 // overlapping span: the first one wins
            plain(at, s.start);
            let st = s.color ? 'color:' + s.color + ';' : '';
            if (s.bold) st += 'font-weight:bold;';
            if (s.italic) st += 'font-style:italic;';
            const inner = spaces(esc(r.text.slice(s.start, s.end)), s.start === 0);
            out += st ? '<span style="' + st + '">' + inner + '</span>' : inner;
            at = s.end;
        }
        plain(at, r.text.length);
        return '<p dir="ltr" style="' + pStyle + '">' + out + '</p>';
    }).join('\n');

    const block = o.box
        ? '<div dir="ltr" style="mso-element:para-border-div;border:solid ' + o.border + ' 1.0pt;padding:4.0pt 6.0pt 4.0pt 6.0pt;background:' +
          o.background + ';direction:ltr;text-align:left;">\n' + htmlLines + '\n</div>'
        : '<div dir="ltr" style="direction:ltr;text-align:left;">\n' + htmlLines + '\n</div>';
    // Word / Outlook merge the last pasted paragraph into the one the cursor is in (in a Hebrew mail: right-to-left,
    // so the last code line jumped right). This empty paragraph is the one that merges; the code keeps its own.
    const body = block + '\n<p style="margin:0;">&nbsp;</p>';
    return { html: body, text };
}

/** The Windows clipboard's HTML format: a header with byte offsets of the HTML and of the fragment. `fragment` must
 *  be ASCII (buildCodeBlock makes it so), so offsets are character counts. */
export function toCfHtml(fragment: string): string {
    const pre = '<html><body>\r\n<!--StartFragment-->';
    const post = '<!--EndFragment-->\r\n</body></html>';
    const header = (a: number, b: number, c: number, d: number) =>
        'Version:0.9\r\nStartHTML:' + pad(a) + '\r\nEndHTML:' + pad(b) + '\r\nStartFragment:' + pad(c) + '\r\nEndFragment:' + pad(d) + '\r\n';
    const pad = (n: number) => String(n).padStart(10, '0');
    const h = header(0, 0, 0, 0).length;
    const startHtml = h;
    const startFrag = h + pre.length;
    const endFrag = startFrag + fragment.length;
    const endHtml = endFrag + post.length;
    return header(startHtml, endHtml, startFrag, endFrag) + pre + fragment + post;
}

/** Parses a theme file (JSON with comments and trailing commas, as VS Code allows). */
export function parseJsonc(text: string): any {
    let out = '', inStr = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inStr) { out += c; if (c === '\\') { out += text[++i] || ''; } else if (c === '"') inStr = false; continue; }
        if (c === '"') { inStr = true; out += c; continue; }
        if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
        if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 1; continue; }
        out += c;
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** A theme's color for a semantic token type: its own entry, else its supertype's, and so on (as VS Code does). */
export function tokenStyle(type: string, colors: Record<string, any>, superTypes: Record<string, string | undefined>):
    { color?: string; bold?: boolean; italic?: boolean } | undefined {
    let t: string | undefined = type;
    for (let guard = 0; t && guard < 20; guard++) {
        const v = colors[t];
        if (typeof v === 'string') return { color: v };
        if (v && typeof v === 'object') return { color: v.foreground, bold: !!v.bold, italic: !!v.italic };
        t = superTypes[t];
    }
    return undefined;
}
