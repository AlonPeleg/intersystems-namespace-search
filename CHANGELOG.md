# Change Log

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
