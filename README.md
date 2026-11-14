# yad

Diff tool for YAML/JSON, focused on Kubernetes manifests.
Stack: Tauri 2 (Rust) + Svelte 5 + CodeMirror 6.

## Requirements

- Node.js 20+
- Rust (`brew install rustup && rustup default stable`;
  rustup is keg-only, add `/opt/homebrew/opt/rustup/bin` to `PATH`)

## Commands

```sh
npm install
npm run tauri dev      # dev mode with hot reload
npm run tauri build    # release .app + .dmg in src-tauri/target/release/bundle/
npm run check          # type check
npm test               # unit tests (semantic engine)
```

Run with files: `yad.app/Contents/MacOS/yad left.yaml right.yaml`

## Shortcuts

| Key | Action |
|---|---|
| ⌘O / ⇧⌘O | Open left / right |
| ⌘S | Save focused side (⇧⌘S — both) |
| ⌘1 / ⌘2 | Text mode (original, editable) / Semantic mode (normalized) |
| ⌘B | Toggle changes panel |
| ⌥↓ / ⌥↑ | Next / previous difference |
| ⌘F | Search |
| ⌘Z / ⇧⌘Z | Undo / redo |
