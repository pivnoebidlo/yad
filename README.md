# YAD — YAML Ain't Different

A recursive acronym (and «яд», "poison", in Russian).

Diff tool for YAML/JSON, focused on Kubernetes manifests: compares files or
whole directories semantically (key order, list order and server noise do not
matter) and applies changes from one side to the other with arrows.
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

Run with files or folders: `YAD.app/Contents/MacOS/YAD left.yaml right.yaml`, `… stage/ prod/`

## Shortcuts

| Key | Action |
|---|---|
| ⌘O / ⇧⌘O | Open file left / right (add ⌥ for a folder) |
| ⌘S | Save focused side (⇧⌘S — all changed files) |
| ⌥⌘↓ / ⌥⌘↑ | Next / previous file (folder mode) |
| ⌘1 / ⌘2 | Semantic view (normalized, editable) / Source view (files as on disk) |
| ⌘J | Show the place under the cursor in Source |
| ⌘B | Toggle changes panel |
| ⌥↓ / ⌥↑ | Next / previous difference |
| ⌘F | Search |
| ⌘Z / ⇧⌘Z | Undo / redo |

## Releases

CI (`.github/workflows/ci.yml`) runs tests, type check and build on every PR
and push to `main`.

To publish installers, bump `version` in `package.json`,
`src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, then:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/release.yml` builds macOS (arm64 + x64) `.dmg`, Linux
(`.AppImage`/`.deb`/`.rpm`) and Windows (`.msi`/`.exe`) and attaches them to a
**draft** GitHub release — review and publish it on the Releases page.
