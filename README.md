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
npm test               # unit tests (semantic engine, CLI)
npm run build:cli      # command-line tool → dist-cli/yad-cli.mjs
```

Run with files or folders: `YAD.app/Contents/MacOS/yad left.yaml right.yaml`, `… stage/ prod/`

A folder with `kustomization.yaml` or `Chart.yaml` can be compared as its
rendered output (`kustomize build` / `helm template`); `helm` and `kustomize`
must be installed.

**Secrets**: values in `data` of a Kubernetes `Secret` are shown decoded from
base64 in the Semantic view and in the lists of changes, and edits there are
encoded back — files always keep base64. Values that are not text stay as
base64. Can be turned off in Settings → Comparison. `yad-cli` hides Secret
values in its reports (`--show-secrets` shows them decoded).

## Git

**YAD as `git difftool`** — the window opens with the changed files; edits
saved on the working-tree side go straight to your files:

```sh
git config --global difftool.yad.cmd '/Applications/YAD.app/Contents/MacOS/yad "$LOCAL" "$REMOTE"'
git difftool -t yad -d            # working tree vs index, all files at once
git difftool -t yad -d main       # working tree vs a branch
git difftool -t yad -d HEAD~3 HEAD
```

**YAD as `git mergetool`** — three-way merge of conflicted YAML/JSON. Changes
from both sides are combined by key (key order, list order and formatting
never conflict); real conflicts are listed with base / ours / theirs values and
resolved with one click. The left pane switches between theirs, ours and base;
the right pane is the result. *Finish merge* saves it and tells git the file is
merged; closing without saving leaves it unmerged.

```sh
git config --global mergetool.yad.cmd '/Applications/YAD.app/Contents/MacOS/yad --merge "$BASE" "$LOCAL" "$REMOTE" "$MERGED"'
git config --global mergetool.yad.trustExitCode true
git mergetool -t yad
```

**Semantic merges in `git merge` / `git rebase`** (needs `yad-cli`): files are
merged by key automatically; only real conflicts get the usual markers (then
`git mergetool -t yad`):

```sh
git config --global merge.yad.driver 'yad-cli merge-driver %O %A %B %P %L'
printf '*.yaml merge=yad\n*.yml merge=yad\n' >> .gitattributes
```

**Semantic `git diff` in the terminal** (needs `yad-cli`, see below):

```sh
git config --global diff.yad.command 'yad-cli git-diff'
printf '*.yaml diff=yad\n*.yml diff=yad\n' >> .gitattributes
git diff                          # YAML files now show key-level changes
git log -p --ext-diff -- k8s/
```

## Command line: `yad-cli`

The same comparison engine without a window — for terminals and CI. It is a
single JavaScript file (Node.js 18+), attached to every release as
`yad-cli.mjs` (or build it: `npm run build:cli`). To have it as a command:

```sh
curl -sSLo ~/.local/bin/yad-cli https://github.com/pivnoebidlo/yad/releases/latest/download/yad-cli.mjs
chmod +x ~/.local/bin/yad-cli     # any folder on PATH
```

```sh
node yad-cli.mjs diff stage/ prod/                  # report; exit 1 if anything differs
node yad-cli.mjs diff a.yaml b.yaml --output json   # or --output markdown (for PR comments)
node yad-cli.mjs format k8s/                        # exit 1 if files need formatting
node yad-cli.mjs format --write k8s/                # fix them
node yad-cli.mjs merge base.yaml ours.yaml theirs.yaml -o out.yaml   # three-way merge
node yad-cli.mjs --help
```

Exit codes: `0` — no differences / already formatted / merged, `1` —
differences / needs formatting / merge conflicts (nothing is written; or settle
them with `--prefer ours|theirs`), `2` — error. Files that differ only in key order or
formatting are not a difference (use `--order-matters` to change that).

Example CI step (GitHub Actions) that fails when environments drift:

```yaml
- run: curl -sSLo yad-cli.mjs https://github.com/pivnoebidlo/yad/releases/latest/download/yad-cli.mjs
- run: node yad-cli.mjs diff --ignore spec.replicas envs/stage envs/prod
```

Pre-commit hook (`.git/hooks/pre-commit`) that keeps manifests formatted:

```sh
#!/bin/sh
files=$(git diff --cached --name-only --diff-filter=ACM -- '*.yaml' '*.yml' '*.json')
[ -z "$files" ] || node yad-cli.mjs format $files
```

## Settings

⌘, (or the gear in the bottom bar): language (English / Русский), theme,
ignored server-managed fields, and keyboard shortcuts — every shortcut below
can be reassigned. Shortcuts match physical keys, so they work with any
keyboard layout.

## Project settings: `.yad.yaml`

Put a `.yad.yaml` in the repository (root or any folder) so everyone compares
and formats manifests the same way. YAD and `yad-cli` look for it next to the
compared files and in the folders above, up to the repository root; its
settings take precedence over personal ones (the footer shows ⚑ `.yad.yaml`
when it is used). Every key is optional:

```yaml
ignore:                  # paths ignored in addition to the usual ones
  - metadata.labels.team
  - spec.replicas
defaultIgnore: true      # false: also compare status, managedFields, uid…
emptyEqualsMissing: true # {} and [] are the same as a missing key
crossNamespace: true     # pair stage/api with prod/api
decodeSecrets: true
format:
  indent: 2              # 2 or 4
  indentLists: true      # false: "key:\n- item"
  sortKubernetesKeys: true
```

`yad-cli` fails (exit 2) on a mistake in `.yad.yaml`; `--no-config` skips the
file, and explicit flags win over it.

## Shortcuts

| Key | Action |
|---|---|
| ⌘O / ⇧⌘O | Open file left / right (add ⌥ for a folder) |
| ⌘S | Save focused side (⇧⌘S — all changed files) |
| ⌥⌘↓ / ⌥⌘↑ | Next / previous file (folder mode) |
| ⌘1 / ⌘2 | Semantic view (normalized, editable) / Source view (files as on disk) |
| ⌘J | Show the place under the cursor in Source |
| ⌘B | Toggle side panel |
| ⇧⌘F | Filter files (folder mode), press again — filter changes |
| ⌘, | Settings |
| ⌥↓ / ⌥↑ | Next / previous difference |
| ⌘F | Search |
| ⌘Z / ⇧⌘Z | Undo / redo |

## Updates

YAD checks GitHub for a new release on start and offers to install it
(Settings → General; About → *Check for updates*). Packages are signed: the
public key is in `src-tauri/tauri.conf.json`, the private key and its
password are the repository secrets `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` used by the release workflow. Losing the
private key means installed copies can no longer update (they would have to
be reinstalled by hand), so keep a backup of it.

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
