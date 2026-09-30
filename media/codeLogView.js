// Code Log panel (Overview + Item), below the Projects tree.
// The extension sends the whole state; this page renders it and sends back
// small edit messages. The extension saves them and sends the new state.
(function () {
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('root');

    const STATUS = {
        check: { label: 'To check', cls: 's-check' },
        progress: { label: 'In progress', cls: 's-progress' },
        ok: { label: 'Understood', cls: 's-ok' },
        fix: { label: 'Needs fix', cls: 's-fix' }
    };
    const STATUS_ORDER = ['fix', 'progress', 'check', 'ok'];

    let state = { selected: null, projects: [], tags: [] };
    const saved = vscode.getState() || {};
    const ui = {
        main: 'overview', // 'overview' | 'item'
        sub: saved.sub || 'notes', // notes | journal | todo | info
        lastSelected: null,
        expanded: new Set(saved.expanded || []),
        filter: { status: new Set(), todos: false, tag: '' },
        editingNotes: false,
        editingJournal: null,
        editingTodo: null,
        tagInput: false,
        renamingTag: null,
        statusMenu: false,
        focusAfter: null, // selector to focus after the next render
        pending: false
    };
    let toastTimer;

    const post = (msg) => vscode.postMessage(msg);
    const persistUi = () => vscode.setState({ sub: ui.sub, expanded: [...ui.expanded] });

    // ---------- tiny DOM helper ----------
    function h(tag, props, ...kids) {
        const e = document.createElement(tag);
        if (props) {
            for (const [k, v] of Object.entries(props)) {
                if (v === undefined || v === null || v === false) continue;
                if (k === 'class') e.className = v;
                else if (k === 'onblur') e.addEventListener('blur', (ev) => { if (!rendering) v(ev); });
                else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
                else if (k === 'text') e.textContent = v;
                else if (k in e && k !== 'list') e[k] = v;
                else e.setAttribute(k, v === true ? '' : v);
            }
        }
        for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid);
        return e;
    }

    function fmtDate(iso) {
        if (!iso) return '—';
        const d = new Date(iso);
        const now = new Date();
        const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
        const diff = Math.round((day(now) - day(d)) / 86400000);
        if (diff === 0) return 'today ' + hm;
        if (diff === 1) return 'yesterday ' + hm;
        return d.toLocaleDateString('en-GB');
    }

    // Notes: simple formatting - "- " / "* " bullets, "1. " numbered, `code`, **bold**.
    function renderNotes(text) {
        const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
        let html = '';
        let list = null;
        const close = () => {
            if (list) html += `</${list}>`;
            list = null;
        };
        for (const line of text.split(/\r?\n/)) {
            const ul = /^\s*[-*]\s+(.*)$/.exec(line);
            const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
            if (ul || ol) {
                const want = ul ? 'ul' : 'ol';
                if (list !== want) {
                    close();
                    html += `<${want} dir="auto">`;
                    list = want;
                }
                html += `<li dir="auto">${inline((ul || ol)[1])}</li>`;
            } else {
                close();
                if (line.trim()) html += `<p dir="auto">${inline(line)}</p>`;
            }
        }
        close();
        return html;
    }

    // ---------- rendering ----------
    let rendering = false; // blurs caused by our own DOM rebuild are ignored
    function render() {
        const scroll = document.scrollingElement.scrollTop;
        const prev = document.activeElement && document.activeElement.id && root.contains(document.activeElement) ? '#' + document.activeElement.id : null;
        rendering = true;
        try { root.textContent = ''; } finally { rendering = false; }
        root.append(
            h('div', { class: 'maintabs' },
                h('button', { class: ui.main === 'overview' ? 'on' : '', text: 'Overview', onclick: () => { ui.main = 'overview'; render(); } }),
                h('button', { class: ui.main === 'item' ? 'on' : '', text: 'Item', onclick: () => { ui.main = 'item'; render(); } })
            )
        );
        root.append(ui.main === 'overview' ? renderOverview() : renderItem());
        document.scrollingElement.scrollTop = scroll;
        const want = ui.focusAfter || prev;
        if (want) {
            const el = root.querySelector(want);
            ui.focusAfter = null;
            if (el) {
                el.focus();
                if (el.setSelectionRange && el.value !== undefined) el.setSelectionRange(el.value.length, el.value.length);
            }
        }
    }

    // ----- Item -----
    function renderItem() {
        const s = state.selected;
        if (!s) return h('div', { class: 'empty', text: 'Select a folder, document or label / method in Projects above to see its log.' });
        const wrap = h('div');
        wrap.append(renderHeader(s));
        const tabs = s.work
            ? [['notes', 'Notes'], ['journal', 'Journal', s.journal.length || ''], ['todo', 'To-do', s.todos.length ? `${s.todos.filter((t) => t.done).length}/${s.todos.length}` : ''], ['info', 'Info']]
            : [['notes', 'Notes'], ['info', 'Info']];
        if (!tabs.some(([k]) => k === ui.sub)) ui.sub = 'notes';
        wrap.append(
            h('div', { class: 'subtabs' },
                tabs.map(([k, label, c]) =>
                    h('button', { class: ui.sub === k ? 'on' : '', onclick: () => { ui.sub = k; persistUi(); render(); } }, label, c ? h('span', { class: 'cnt', text: String(c), title: k === 'todo' ? 'done / total' : '' }) : null)
                )
            )
        );
        const pane = h('div', { class: 'pane' });
        if (ui.sub === 'notes') pane.append(renderNotesPane(s));
        else if (ui.sub === 'journal') pane.append(renderJournal(s));
        else if (ui.sub === 'todo') pane.append(renderTodos(s));
        else pane.append(renderInfo(s));
        wrap.append(pane);
        return wrap;
    }

    function renderHeader(s) {
        const hdr = h('div', { class: 'hdr' });
        if (s.path.length) hdr.append(h('div', { class: 'path', dir: 'auto', text: s.path.join(' › ') }));
        const field = s.work ? 'title' : 'name';
        const value = s.work ? s.title : s.name;
        const title = h('input', {
            class: 'titlein', id: 'titlein', dir: 'auto', value,
            placeholder: s.work ? 'Add a title…' : 'Name',
            oninput: debounce((e) => post({ type: 'edit', id: s.id, field, value: e.target.value }), 400)
        });
        title.addEventListener('input', (e) => {
            if (s.work) s.title = e.target.value;
            else s.name = e.target.value;
        });
        hdr.append(title);
        if (!s.work) {
            hdr.append(h('div', { class: 'small muted', text: s.kind === 'group' ? `Group in ${s.doc}` : s.isProject ? 'Project' : 'Folder' }));
            return hdr;
        }
        // status + link to the code
        const target = s.member ? s.member.name : s.doc;
        hdr.append(
            h('div', { class: 'hline' },
                renderStatus(s),
                h('span', {
                    class: 'link mono' + (s.nsOpen ? '' : ' off'),
                    title: s.nsOpen ? 'Go to the code' : `Namespace ${s.ns} isn't open in this workspace`,
                    text: target + ' ↗',
                    onclick: () => s.nsOpen && post({ type: 'open', id: s.id, target: s.member ? 'member' : 'file' })
                })
            )
        );
        hdr.append(renderTags(s));
        return hdr;
    }

    function renderStatus(s) {
        const cur = s.status ? STATUS[s.status] : null;
        const box = h('div', { class: 'status' });
        box.append(
            h('button', { class: 'badge', title: 'Change status', onclick: (e) => { e.stopPropagation(); ui.statusMenu = !ui.statusMenu; render(); } },
                h('span', { class: 'dot ' + (cur ? cur.cls : 'none') }), cur ? cur.label : 'No status', ' ▾')
        );
        if (ui.statusMenu) {
            const menu = h('div', { class: 'menu' });
            const opt = (key, label, cls) =>
                h('button', { class: (s.status || null) === key ? 'cur' : '', onclick: () => { ui.statusMenu = false; post({ type: 'setStatus', id: s.id, status: key }); } },
                    h('span', { class: 'dot ' + cls }), label);
            menu.append(opt(null, 'No status', 'none'));
            for (const k of ['check', 'progress', 'ok', 'fix']) menu.append(opt(k, STATUS[k].label, STATUS[k].cls));
            box.append(menu);
        }
        return box;
    }

    function renderTags(s) {
        const row = h('div', { class: 'tags' });
        for (const t of s.tags) {
            if (ui.renamingTag === t) {
                row.append(h('input', {
                    class: 'taginput', id: 'renametag', value: t, dir: 'auto',
                    onkeydown: (e) => {
                        if (e.key === 'Enter') { ui.renamingTag = null; post({ type: 'renameTag', id: s.id, from: t, to: e.target.value }); }
                        if (e.key === 'Escape') { ui.renamingTag = null; render(); }
                    },
                    onblur: () => { if (ui.renamingTag === t) { ui.renamingTag = null; render(); } }
                }));
                ui.focusAfter = '#renametag';
                continue;
            }
            row.append(
                h('span', { class: 'tag', dir: 'auto', title: 'Double-click to rename', ondblclick: () => { ui.renamingTag = t; render(); } },
                    t, h('button', { class: 'x', title: 'Remove tag', text: '✕', onclick: () => post({ type: 'removeTag', id: s.id, tag: t }) }))
            );
        }
        if (ui.tagInput) {
            const listId = 'alltags';
            row.append(h('datalist', { id: listId }, state.tags.filter((t) => !s.tags.includes(t.tag)).map((t) => h('option', { value: t.tag }))));
            row.append(h('input', {
                class: 'taginput', id: 'newtag', placeholder: '#tag', dir: 'auto', list: listId,
                onkeydown: (e) => {
                    if (e.key === 'Enter' && e.target.value.trim()) { ui.focusAfter = '#newtag'; post({ type: 'addTag', id: s.id, tag: e.target.value }); e.target.value = ''; }
                    if (e.key === 'Escape') { ui.tagInput = false; render(); }
                },
                onblur: (e) => { if (!e.target.value.trim()) { ui.tagInput = false; setTimeout(render, 0); } }
            }));
            ui.focusAfter = '#newtag';
        } else {
            row.append(h('button', { class: 'addtag', text: '+ tag', onclick: () => { ui.tagInput = true; render(); } }));
        }
        return row;
    }

    function renderNotesPane(s) {
        if (ui.editingNotes) {
            const ta = h('textarea', {
                class: 'notesedit', id: 'notesedit', dir: 'auto', value: s.description,
                placeholder: 'What it does, where it is called from…  (- bullets, `code`, **bold**)',
                oninput: debounce((e) => post({ type: 'edit', id: s.id, field: 'description', value: e.target.value }), 400),
                onblur: () => { ui.editingNotes = false; setTimeout(render, 0); }
            });
            ta.addEventListener('input', (e) => { s.description = e.target.value; autosize(e.target); });
            ui.focusAfter = '#notesedit';
            setTimeout(() => autosize(ta), 0);
            return h('div', null, ta, h('div', { class: 'hint', text: 'Formatting: "- " bullets, "1. " numbered, `code`, **bold**. Click outside to finish.' }));
        }
        const view = h('div', { class: 'notes', title: 'Click to edit', onclick: () => { ui.editingNotes = true; render(); } });
        if (s.description.trim()) view.innerHTML = renderNotes(s.description);
        else view.append(h('span', { class: 'ph', text: s.work ? 'Add notes: what it does, where it is called from…' : 'Add notes…' }));
        return view;
    }

    function renderJournal(s) {
        const wrap = h('div');
        wrap.append(h('input', {
            id: 'jnew', dir: 'auto', placeholder: 'Add an entry… (Enter)',
            onkeydown: (e) => {
                if (e.key === 'Enter' && e.target.value.trim()) { ui.focusAfter = '#jnew'; post({ type: 'addJournal', id: s.id, text: e.target.value.trim() }); e.target.value = ''; }
            }
        }));
        const list = h('div', { style: 'margin-top:10px' });
        if (!s.journal.length) list.append(h('div', { class: 'hint', text: 'Quick dated notes: what you found, fixed or changed. Newest first.' }));
        [...s.journal].sort((a, b) => b.at.localeCompare(a.at)).forEach((j) => {
            const index = s.journal.indexOf(j);
            if (ui.editingJournal === j.id) {
                list.append(h('div', { class: 'jentry' },
                    h('div', { class: 'jwhen' }, h('span', { text: fmtDate(j.at) })),
                    h('input', {
                        id: 'jedit', dir: 'auto', value: j.text,
                        onkeydown: (e) => {
                            if (e.key === 'Enter') { ui.editingJournal = null; post({ type: 'editJournal', id: s.id, entryId: j.id, text: e.target.value }); }
                            if (e.key === 'Escape') { ui.editingJournal = null; render(); }
                        },
                        onblur: () => { if (ui.editingJournal === j.id) { ui.editingJournal = null; render(); } }
                    })));
                ui.focusAfter = '#jedit';
                return;
            }
            list.append(h('div', { class: 'jentry' },
                h('div', { class: 'jwhen' },
                    h('span', { text: fmtDate(j.at), title: new Date(j.at).toLocaleString() }),
                    h('span', { class: 'acts' },
                        h('button', { title: 'Edit', text: '✎', onclick: () => { ui.editingJournal = j.id; render(); } }),
                        h('button', {
                            title: 'Delete', text: '🗑',
                            onclick: () => { post({ type: 'deleteJournal', id: s.id, entryId: j.id }); toast('Journal entry deleted', () => post({ type: 'restoreJournal', id: s.id, entry: j, index })); }
                        }))),
                h('div', { class: 'jtext', dir: 'auto', text: j.text })));
        });
        wrap.append(list);
        return wrap;
    }

    function renderTodos(s) {
        const wrap = h('div');
        const open = s.todos.filter((t) => !t.done);
        const done = s.todos.filter((t) => t.done);
        let dragId = null;
        const row = (t) => {
            const index = s.todos.indexOf(t);
            if (ui.editingTodo === t.id) {
                ui.focusAfter = '#tedit';
                return h('div', { class: 'todo' + (t.done ? ' done' : '') },
                    h('span', { class: 'box' + (t.done ? ' done' : ''), text: t.done ? '✓' : '' }),
                    h('input', {
                        id: 'tedit', dir: 'auto', value: t.text,
                        onkeydown: (e) => {
                            if (e.key === 'Enter') { ui.editingTodo = null; post({ type: 'editTodo', id: s.id, todoId: t.id, text: e.target.value }); }
                            if (e.key === 'Escape') { ui.editingTodo = null; render(); }
                        },
                        onblur: () => { if (ui.editingTodo === t.id) { ui.editingTodo = null; render(); } }
                    }));
            }
            const el = h('div', { class: 'todo' + (t.done ? ' done' : ''), draggable: !t.done ? 'true' : null },
                !t.done ? h('span', { class: 'grip', title: 'Drag to reorder', text: '⋮⋮' }) : null,
                h('button', { class: 'box' + (t.done ? ' done' : ''), text: t.done ? '✓' : '', title: t.done ? 'Mark as not done' : 'Mark as done', onclick: () => post({ type: 'toggleTodo', id: s.id, todoId: t.id }) }),
                h('span', { class: 'ttext', dir: 'auto', text: t.text, title: 'Double-click to edit', ondblclick: () => { ui.editingTodo = t.id; render(); } }),
                h('span', { class: 'acts' },
                    h('button', { title: 'Edit', text: '✎', onclick: () => { ui.editingTodo = t.id; render(); } }),
                    h('button', {
                        title: 'Delete', text: '🗑',
                        onclick: () => { post({ type: 'deleteTodo', id: s.id, todoId: t.id }); toast('To-do deleted', () => post({ type: 'restoreTodo', id: s.id, todo: t, index })); }
                    })));
            if (!t.done) {
                el.addEventListener('dragstart', (e) => { dragId = t.id; e.dataTransfer.effectAllowed = 'move'; });
                el.addEventListener('dragover', (e) => { if (dragId && dragId !== t.id) { e.preventDefault(); el.classList.add('dragover'); } });
                el.addEventListener('dragleave', () => el.classList.remove('dragover'));
                el.addEventListener('drop', (e) => {
                    e.preventDefault();
                    el.classList.remove('dragover');
                    if (dragId && dragId !== t.id) post({ type: 'moveTodo', id: s.id, todoId: dragId, beforeId: t.id });
                    dragId = null;
                });
            }
            return el;
        };
        open.forEach((t) => wrap.append(row(t)));
        wrap.append(h('input', {
            id: 'tnew', dir: 'auto', placeholder: '+ add a to-do (Enter)', style: 'margin-top:6px',
            onkeydown: (e) => {
                if (e.key === 'Enter' && e.target.value.trim()) { ui.focusAfter = '#tnew'; post({ type: 'addTodo', id: s.id, text: e.target.value.trim() }); e.target.value = ''; }
            }
        }));
        if (done.length) {
            wrap.append(h('div', { class: 'sec', text: `Done · ${done.length}` }));
            done.forEach((t) => wrap.append(row(t)));
        }
        return wrap;
    }

    function renderInfo(s) {
        const wrap = h('div');
        if (s.work) {
            const off = !s.nsOpen;
            const offTip = `Namespace ${s.ns} on ${s.server} isn't open in this workspace`;
            wrap.append(h('div', {
                class: 'card' + (off ? ' off' : ''), title: off ? offTip : 'Open the document',
                onclick: () => !off && post({ type: 'open', id: s.id, target: 'file' })
            },
                h('span', { class: 'ico ' + (s.docType === 'cls' ? 'cls' : 'rtn'), text: s.docType === 'cls' ? 'C' : 'R', title: s.docType === 'cls' ? 'Class' : 'Routine' }),
                h('div', { style: 'flex:1;min-width:0' }, h('div', { class: 'ck', text: 'Document' }), h('div', { class: 'cv', text: s.doc })),
                h('span', { class: 'link' + (off ? ' off' : ''), text: '↗' })));
            if (s.member) {
                wrap.append(h('div', {
                    class: 'card' + (off ? ' off' : ''), title: off ? offTip : 'Go to it in the code',
                    onclick: () => !off && post({ type: 'open', id: s.id, target: 'member' })
                },
                    h('span', { class: 'ico mth', text: s.member.kind === 'Label' ? 'L' : 'M', title: s.member.kind }),
                    h('div', { style: 'flex:1;min-width:0' }, h('div', { class: 'ck', text: s.member.kind }), h('div', { class: 'cv', text: s.member.name })),
                    h('span', { class: 'link' + (off ? ' off' : ''), text: '↗' })));
            }
            const kv = h('div', { class: 'kv' });
            const add = (k, v) => kv.append(h('div', { class: 'k', text: k }), v instanceof Node ? v : h('div', { class: 'v', dir: 'auto', text: v }));
            if (s.group) add('Group', s.group);
            add('Folder', s.path.join(' › ') || '—');
            add('Namespace', s.ns);
            add('Server', h('div', { class: 'v' }, s.server + ' ', s.nsOpen ? h('span', { class: 'open', text: '● open' }) : h('span', { class: 'muted small', text: '○ not open' })));
            add('Added', fmtDate(s.created));
            add('Last edited', fmtDate(s.edited));
            wrap.append(kv);
            if (s.contents && s.contents.length) wrap.append(renderContents('Members', s.contents));
        } else {
            const kv = h('div', { class: 'kv', style: 'margin-top:0' });
            const add = (k, v) => kv.append(h('div', { class: 'k', text: k }), h('div', { class: 'v', dir: 'auto', text: v }));
            if (s.kind === 'group') {
                add('Document', s.doc);
            } else {
                add('Inside', s.path.length ? s.path.join(' › ') : '— (project)');
                add('Documents', String(s.counts.docs));
                add('Labels / methods', String(s.counts.members));
            }
            wrap.append(kv);
            wrap.append(renderContents(s.kind === 'group' ? 'Members' : 'Contents', s.contents || []));
        }
        return wrap;
    }

    // Clickable list of what's inside: click = show it here (and in the tree), ↗ = open the code.
    function renderContents(title, list) {
        const box = h('div', { class: 'contents' }, h('div', { class: 'sec', text: `${title} (${list.some((x) => x.kind === 'member') ? list.filter((x) => x.kind === 'member').length : list.length})` }));
        if (!list.length) {
            box.append(h('div', { class: 'muted small', style: 'padding:2px 4px', text: 'Nothing here yet.' }));
            return box;
        }
        for (const c of list) {
            const ico = c.kind === 'folder' ? h('span', { class: 'ico fld', text: '▤', title: 'Folder' })
                : c.kind === 'group' ? h('span', { class: 'ico grp', text: '≋', title: 'Group' })
                : c.kind === 'file' ? h('span', { class: 'ico ' + c.docType, text: c.docType === 'cls' ? 'C' : 'R', title: c.docType === 'cls' ? 'Class' : 'Routine' })
                : h('span', { class: 'ico mth', text: c.type === 'Label' ? 'L' : 'M', title: c.type });
            const row = h('div', {
                class: 'crow', style: `padding-left:${4 + c.depth * 18}px`, title: 'Show it in the Code Log',
                onclick: () => post({ type: 'select', id: c.id })
            }, ico);
            if (c.kind === 'file' || c.kind === 'member') row.append(h('span', { class: 'dot ' + (c.status ? STATUS[c.status].cls : 'none') }));
            row.append(h('span', { class: 'lbl', dir: 'auto', text: c.label }));
            if (c.sub) row.append(h('span', { class: 'sub mono', text: c.sub }));
            const right = h('span', { class: 'right' });
            if (c.openTodos) right.append(h('span', { class: 'td', text: '☐' + c.openTodos }));
            right.append(h('span', { class: 'ctype', text: c.type }));
            if (c.kind === 'file' || c.kind === 'member') {
                right.append(h('span', {
                    class: 'link' + (c.canOpen ? '' : ' off'), text: '↗',
                    title: c.canOpen ? 'Open the code' : "That namespace isn't open in this workspace",
                    onclick: (e) => { e.stopPropagation(); if (c.canOpen) post({ type: 'open', id: c.id, target: c.kind === 'file' ? 'file' : 'member' }); }
                }));
            }
            row.append(right);
            box.append(row);
        }
        return box;
    }

    // ----- Overview -----
    const isWork = (n) => n.kind === 'file' || n.kind === 'member';
    const matches = (n) => {
        const f = ui.filter;
        if (!isWork(n)) return false;
        if (f.status.size && !f.status.has(n.status || 'none')) return false;
        if (f.todos && !n.openTodos) return false;
        if (f.tag && !(n.tags || []).includes(f.tag)) return false;
        return true;
    };
    const filtering = () => ui.filter.status.size > 0 || ui.filter.todos || !!ui.filter.tag;

    function collect(n, out) {
        if (isWork(n)) out.push(n);
        (n.children || []).forEach((c) => collect(c, out));
        return out;
    }

    function renderOverview() {
        const wrap = h('div');
        const all = state.projects.flatMap((p) => collect(p, []));
        if (!state.projects.length) {
            wrap.append(h('div', { class: 'empty', text: 'No projects yet. Create one with New Folder in the Projects title bar.' }));
            return wrap;
        }
        const counts = { check: 0, progress: 0, ok: 0, fix: 0 };
        let openTodos = 0;
        for (const n of all) {
            if (n.status) counts[n.status]++;
            openTodos += n.openTodos || 0;
        }
        const chips = h('div', { class: 'chips' });
        for (const k of STATUS_ORDER) {
            const on = ui.filter.status.has(k);
            chips.append(h('button', {
                class: 'chip' + (on ? ' on' : ''), title: STATUS[k].label + (on ? ' (click to remove filter)' : ' (click to filter)'),
                onclick: () => { on ? ui.filter.status.delete(k) : ui.filter.status.add(k); render(); }
            }, h('span', { class: 'dot ' + STATUS[k].cls }), String(counts[k])));
        }
        chips.append(h('button', {
            class: 'chip' + (ui.filter.todos ? ' on' : ''), title: 'Only items with open to-dos',
            onclick: () => { ui.filter.todos = !ui.filter.todos; render(); }
        }, '☐ ' + openTodos));
        if (state.tags.length) {
            const sel = h('select', { title: 'Filter by tag', onchange: (e) => { ui.filter.tag = e.target.value; render(); } },
                h('option', { value: '', text: '#tags' }),
                state.tags.map((t) => h('option', { value: t.tag, text: `${t.tag} (${t.count})`, selected: ui.filter.tag === t.tag })));
            if (ui.filter.tag) sel.classList.add('on');
            chips.append(sel);
        }
        wrap.append(chips);

        const list = h('div', { style: 'padding:0 4px 8px' });
        const f = filtering();
        let shown = 0;
        const keep = (n) => (f ? matches(n) || (n.children || []).some(keep) : true);
        const walk = (n, depth) => {
            if (!keep(n)) return;
            if (f && matches(n)) shown++;
            const kids = (n.children || []).filter(keep);
            const open = f || ui.expanded.has(n.id);
            list.append(renderOvRow(n, depth, kids.length > 0, open));
            if (open) kids.forEach((c) => walk(c, depth + 1));
        };
        state.projects.forEach((p) => walk(p, 0));
        wrap.append(list);
        if (f) {
            wrap.append(h('div', { class: 'foot' },
                h('span', { text: `${shown} matching · everything else hidden` }),
                h('button', { class: 'link', text: 'clear', onclick: () => { ui.filter = { status: new Set(), todos: false, tag: '' }; render(); } })));
        }
        return wrap;
    }

    function renderOvRow(n, depth, hasKids, open) {
        const sel = (ui.ovSel || (state.selected && state.selected.id)) === n.id;
        const toggle = () => {
            if (!hasKids || filtering()) return;
            ui.expanded.has(n.id) ? ui.expanded.delete(n.id) : ui.expanded.add(n.id);
            persistUi();
        };
        const row = h('div', {
            class: 'ovrow' + (sel ? ' sel' : ''), style: `padding-left:${4 + depth * 14}px`,
            title: tooltip(n) + '\n(double-click to open it in Item)',
            // One click: open / close (or just highlight a row with nothing inside). Double click: show it in Item.
            onclick: (e) => {
                if (e.detail === 2) {
                    toggle(); // undo the first click's open / close
                    ui.ovSel = null;
                    ui.main = 'item';
                    render();
                    post({ type: 'select', id: n.id });
                    return;
                }
                if (e.detail > 2) return;
                ui.ovSel = n.id;
                toggle();
                render();
            }
        });
        row.append(h('span', { class: 'tw', text: hasKids ? (open ? '▾' : '▸') : '' }));
        if (isWork(n)) row.append(h('span', { class: 'dot ' + (n.status ? STATUS[n.status].cls : 'none') }));
        else if (n.kind === 'group') row.append(h('span', { class: 'muted', text: '≋' }));
        const label = h('span', { class: 'lbl', dir: 'auto', text: n.label });
        if (n.kind === 'folder' && n.project) label.style.fontWeight = '600';
        if (n.kind === 'file') label.classList.add('mono');
        row.append(label);
        if (n.sub) row.append(h('span', { class: 'sub mono', text: n.sub }));
        const right = h('span', { class: 'right' });
        if (!isWork(n) || n.kind === 'file') {
            // Roll-up of everything inside
            const items = collect(n, []).filter((x) => x !== n || n.kind === 'file');
            if (!isWork(n) && items.length) {
                const bar = h('span', { class: 'mini', title: rollupTitle(items) });
                for (const k of ['ok', 'progress', 'check', 'fix']) {
                    const c = items.filter((x) => x.status === k).length;
                    if (c) bar.append(h('span', { class: STATUS[k].cls, style: `width:${(c / items.length) * 100}%` }));
                }
                right.append(bar);
            }
            const todos = items.reduce((a, x) => a + (x.openTodos || 0), 0);
            if (todos) right.append(h('span', { class: 'td', text: '☐' + todos }));
        } else if (n.openTodos) {
            right.append(h('span', { class: 'td', text: '☐' + n.openTodos }));
        }
        row.append(right);
        return row;
    }

    function rollupTitle(items) {
        const parts = ['fix', 'progress', 'check', 'ok'].map((k) => `${STATUS[k].label}: ${items.filter((x) => x.status === k).length}`);
        parts.push(`No status: ${items.filter((x) => !x.status).length}`);
        return parts.join('\n');
    }

    function tooltip(n) {
        const lines = [n.title || n.label];
        if (n.sub && n.title) lines.push(n.sub);
        if (n.notes) lines.push('', n.notes.length > 200 ? n.notes.slice(0, 200) + '…' : n.notes);
        if (n.todoTexts && n.todoTexts.length) lines.push('', ...n.todoTexts.map((t) => '☐ ' + t));
        return lines.join('\n');
    }

    // ---------- helpers ----------
    function debounce(fn, ms) {
        let t;
        return (...a) => {
            clearTimeout(t);
            t = setTimeout(() => fn(...a), ms);
        };
    }

    function autosize(ta) {
        ta.style.height = 'auto';
        ta.style.height = Math.max(110, ta.scrollHeight + 2) + 'px';
    }

    function toast(text, undo) {
        document.querySelectorAll('.toast').forEach((t) => t.remove());
        clearTimeout(toastTimer);
        const el = h('div', { class: 'toast' }, h('span', { text }), h('button', { text: 'Undo', onclick: () => { el.remove(); undo(); } }));
        document.body.append(el);
        toastTimer = setTimeout(() => el.remove(), 6000);
    }

    const typing = () => {
        const a = document.activeElement;
        return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && root.contains(a) && a.id !== 'newtag' && a.id !== 'jnew' && a.id !== 'tnew';
    };

    document.addEventListener('click', (e) => {
        if (ui.statusMenu && !e.target.closest('.status')) {
            ui.statusMenu = false;
            render();
        }
    });
    document.addEventListener('focusout', () => {
        setTimeout(() => {
            if (ui.pending && !typing()) {
                ui.pending = false;
                render();
            }
        }, 0);
    });

    window.addEventListener('message', (e) => {
        const msg = e.data;
        if (msg?.type !== 'state') return;
        const prevId = state.selected ? state.selected.id : null;
        state = msg.state;
        const id = state.selected ? state.selected.id : null;
        if (id !== prevId) {
            // A different item: show it, and drop any half-finished edits.
            ui.editingNotes = false;
            ui.editingJournal = ui.editingTodo = ui.renamingTag = null;
            ui.tagInput = ui.statusMenu = false;
            if (id && msg.reason === 'selection') { ui.main = 'item'; ui.ovSel = null; }
        }
        if (typing() && id === prevId) {
            ui.pending = true; // don't disturb typing; render when focus leaves
            return;
        }
        render();
    });

    render();
    post({ type: 'ready' });
})();
