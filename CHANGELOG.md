# Change Log

## [1.7.9]

- Code Log **Details** redesigned, with two tabs:
  - **Overview**: a status tree of the whole log with roll-ups, open to-do counts, and filters by status, open to-dos
    and #tag.
  - **Item**: editable title, status badge, tags (add / remove / rename everywhere), a link to the code, and sub-tabs
    **Notes** (bullets, `code`, **bold**), **Journal**, **To-do** and **Info** (clickable Document / Method cards
    replace the Go to code button).
- Status, tags, journal and to-dos apply to documents and labels / methods. Projects, folders and groups keep name + notes.
- New **Export Log / Import Log** in the Details title bar (all projects or one). Import creates missing tree items and
  asks Overwrite all / Keep mine / Choose… for items that already have a log.
- Tree Export / Import now carry titles and notes only. Importing a single project shows a checklist of its subfolders
  and documents (new / already exists) and which existing ones to replace; the rest merge. Replacing keeps your
  status, tags, journal and to-dos.

## [1.7.8]

- Code Log: closing a row now also closes everything inside it. The Expand / Collapse All Below buttons are removed.

## [1.7.7]

- Code Log opens with everything collapsed.
- **Expand All Below / Collapse All Below** button on projects, folders and documents that have foldable rows under
  them (also on right-click): opens or folds that row and everything beneath it.

## [1.7.6]

- Code Log: the button on a group is now **Choose Members**: a checklist of the document's already-logged labels /
  methods, with the group's members ticked. Tick / untick to arrange the group; members from another group move over.
  Adding not-yet-logged members is the last entry of the list.

## [1.7.5]

- Code Log: **groups** inside a document, to organise many labels / methods. New Group (right-click a document),
  Move to Group (right-click a member), drag and drop to join, leave or reorder, count badges, and adding members
  straight into a group. Removing a group keeps its members. Groups are kept when copying, exporting and importing
  (same-named groups merge).

## [1.7.4]

- Code Log: **Copy to Folder...** (right-click on a document or subfolder) copies it with all its notes; a copied
  subfolder can also become a new project.
- Projects (top-level folders) no longer offer Move to Folder and can't be dragged.

## [1.7.3]

- Code Log: top-level folders are **projects**, with their own icon and emphasised name.
- **Export Project**: export a single project (with its subfolders) as JSON.
- Import reads both whole-log and project exports:
  - a single project with the same name as one of yours can be merged, replace just that project, or be added as a copy;
  - a file with several projects shows a checklist of which to import, then which of the ones you already have to
    overwrite (the rest are merged). Projects not in the file are never touched.
- Imported items get fresh ids, so re-importing your own export can't clash.
- Export and import dialogs start in your Desktop (including a OneDrive Desktop).

## [1.7.2]

- Fixed Code Log (and Bookmarks) staying on "loading" when no namespace folder is open: the extension now also starts
  once VS Code has finished starting up, not only when an isfs folder opens. It still only wakes the InterSystems
  extension when a namespace folder is open.
- Each feature starts independently, so a problem in one can't stop the others from loading.
- Code Log: empty folders show "empty".

## [1.7.1]

- Code Log: `Ctrl+Alt+L` opens the Code Log sidebar.
- Folder document counts moved to a badge at the right edge of the row; Hebrew folder names no longer pull the number
  into the name ("תיק2 files").
- Hebrew titles and the English document / method names beside them no longer run into each other.

## [1.7.0]

- Code Log: **subfolders** to any depth (New Subfolder on a folder), and folders can be moved by drag and drop or
  "Move to Folder..." (including back to the top level). Existing logs are upgraded automatically.
- Adding a document or member (editor right-click or panel) only picks an existing folder or subfolder; folders are
  created in the panel.
- Tree shows the title as the main text when there is one, with the document / method name beside it.
- Redesigned Details panel: namespace, folder path, document and method at the top, then title and description.

## [1.6.0]

- Added **Code Log**, with its own sidebar icon: folders (Hebrew / English names) of server-side documents and their
  labels / methods, each with a title and description edited in a Details panel. Add from the editor's right-click menu
  (it detects the label or method at the cursor) or from the panel. Go to code opens the document, or the member by
  name. Entries whose namespace isn't open are greyed out but kept. Drag and drop between folders. JSON export / import
  (merge or replace).

## [1.5.0]

- Open Document: **checkbox mode** for opening several files at once. Turn it on with the checklist button, tick files by
  clicking them or with `Ctrl+Enter`, and press Enter to open them all. Ticks survive moving between packages and
  switching Tree / Flat. Clicking a package or `..` in checkbox mode navigates instead of ticking.

## [1.4.3]

- Open Document no longer needs a password or VS Code's "Allow" dialog: without a password it lists documents
  through the isfs folder (the InterSystems extension's own connection). With a password available without asking
  (settings.json, or an already-allowed Server Manager login), it still lists directly from the server, which is faster.
- The flat list through the isfs folder fills in as packages are read, is kept for 3 minutes, and has a Reload button.
- Nothing in this extension prompts for a password or triggers "wants to sign in" any more.

## [1.4.2]

- Fixed the Server Manager sign-in showing every InterSystems login ("Sign in to pery-test with... / phoenix-29 with...")
  after Allow: the exact server + user account is now requested, the same way the ObjectScript extension does it.

## [1.4.1]

- Fixed Open Document failing with HTTP 401 when the password isn't in settings.json (vscode-objectscript 3.8.x hands
  out an incomplete login in that case). Server-side search had the same problem and silently fell back to the local scan.
- Passwords are now found in settings.json, then Server Manager's saved login (the one from "Add Server Namespace to
  Workspace"), then this extension's Secret Storage. Open Document asks if none is found and can remember it securely,
  and asks again if the server rejects it.
- Added "InterSystems: Forget Stored Password...".

## [1.4.0]

- Added **Bookmarks** for server-side (isfs) documents, with their own **ISFS Bookmarks** sidebar:
  `Ctrl+F2` toggle, `F2` next bookmark, `Ctrl+Alt+F2` clear the file's bookmarks.
  Bookmarks follow edits: lines added or removed above move them, and deleting the bookmarked line removes it.
- isfs documents open as regular tabs instead of preview tabs (setting `isfsNamespaceSearch.pinIsfsEditors`, on by default).

## [1.3.4]

- Added a README.
- Extension icon (Extensions view / Marketplace) now uses the same glyph as the ISFS Search sidebar icon.

## [1.3.3]

- Open Document: holding `Backspace` deletes the filter text and stops at the empty filter;
  release and press it again to go up one package. (A held Backspace on an empty filter goes up one level, not all the way.)

## [1.3.2]

- Open Document keys: `Ctrl+H` (was `Alt+Home`) goes back to the namespace root; removed `Ctrl+Left`
  so it keeps jumping by word in the filter box. `Alt+Left` and `Backspace` on an empty filter still go up one package.

## [1.3.1]

- Open Document: switching Flat -> Tree always starts at the namespace root.
- Tree view: fixed **Back** button (left of the title) and **Root** button in the title bar, so going up never needs scrolling.
- Keys while the picker is open: `Ctrl+T` switch Tree/Flat; `Alt+Left` up one package
  (also `Ctrl+Left` / `Backspace` when the filter box is empty); `Alt+Home` back to the namespace root.

## [1.3.0]

- Added **Open Document (Tree / Flat)** ("InterSystems: Open Document (Tree / Flat)", command
  `isfsNamespaceSearch.openDocument`, no default keybinding). Same job as the ObjectScript extension's
  "Open InterSystems Document...", but you can switch between the package tree (vscode-objectscript 3.8.2 and earlier)
  and the flat list (3.8.3 and later) with the title-bar button, or by running the command again while the picker is open.
  Works with any installed vscode-objectscript version. Setting `isfsNamespaceSearch.openDocument.defaultMode`
  picks the starting view (`last`, `tree` or `flat`).

## [1.2.2]

- Go To: keyboard focus lands in the editor after the jump (it could end up in the Explorer), so you can keep typing.

## [1.2.1]

- Go To: when more than one namespace is open, a picker asks which namespace to open the document in.
  The current file's namespace is listed first, then the last one picked, so Enter alone stays put.

## [1.2.0]

- Added Studio-style **Go To** (`Ctrl+Alt+G`, or "InterSystems: Go To" in the Command Palette).
  Accepts `label^routine`, `label+offset^routine`, `$$label^routine(args)`, `^routine`, `^routine.int`,
  `+N^routine`, `##class(Pkg.Cls).Method`, `Pkg.Cls.cls`, a bare `label` / `label+offset` in the
  current file, or a line number. Prefills with the `label^routine` reference under the cursor.
  Works on every server version - it reads the document directly and never uses the search API.
- Namespace search (`Ctrl+Alt+S`) is unchanged.
