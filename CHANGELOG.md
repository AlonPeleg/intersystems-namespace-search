# Change Log

## [1.2.0]

- Added Studio-style **Go To** (`Ctrl+Alt+G`, or "InterSystems: Go To" in the Command Palette).
  Accepts `label^routine`, `label+offset^routine`, `$$label^routine(args)`, `^routine`, `^routine.int`,
  `+N^routine`, `##class(Pkg.Cls).Method`, `Pkg.Cls.cls`, a bare `label` / `label+offset` in the
  current file, or a line number. Prefills with the `label^routine` reference under the cursor.
  Works on every server version - it reads the document directly and never uses the search API.
- Namespace search (`Ctrl+Alt+S`) is unchanged.
