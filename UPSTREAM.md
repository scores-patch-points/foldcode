# opencode-fold — vendor contract

opencode-fold is a white-label of **opencode** (`anomalyco/opencode`), MIT licensed.
This repository is a vendor fork: the upstream tree with a thin, documented brand
patch on top, so upstream updates merge cleanly and the fork stays honest.

## What this repo is

- **Upstream**: https://github.com/anomalyco/opencode (branch `dev`)
- **Pinned commit**: `907b3bc518fa48e90e8ec24dd327d13eee71c36c` (1.18.34)
- **License**: MIT — `LICENSE` is upstream's file, byte-for-byte. The MIT copyright
  notice is the attribution this white-label is built on ("citing it as a real
  app" is not optional; it is the license).
- **The Fold context**: per the Adaptive Agent Runtime spec (§1, §12), opencode is
  an execution substrate, never the epistemic architecture. It executes filesystem,
  shell, process, git, and test work behind Machine Doors; it does not decide what
  is true or what material external models receive.

## The brand patch

The entire white-label lives in these files. Nothing else is renamed, so merges
from upstream stay mechanical.

| File | What it changes |
|---|---|
| `package.json` (root) | name → `opencode-fold` |
| `bun.lock` | workspace entries renamed (`opencode@workspace:` → `opencode-fold@workspace:`); a fresh clone needs this to resolve the renamed workspace. Dependency versions unchanged. |
| `packages/opencode/package.json` | name → `opencode-fold`; `bin.opencode-fold` → `./bin/opencode-fold` |
| `packages/opencode/bin/opencode-fold` | launcher (renamed from `bin/opencode`); error string says `opencode-fold CLI` |
| `packages/opencode/src/index.ts` | CLI self-identification: `scriptName("opencode-fold")` + help-output prefix check |
| `packages/web/package.json` | workspace dep `opencode` → `opencode-fold` (web imports CLI types) |
| `packages/web/src/pages/s/[id].astro`, `.../share/part.tsx`, `.../Share.tsx` | import sites `opencode/session/...` → `opencode-fold/session/...` |
| `README.md` | attribution block at the top (this white-label, upstream credit, MIT) |
| `UPSTREAM.md` | this contract |
| `brand/manifest.json` | machine-checkable manifest (upstream pin, brand-patch file list, verify command) |

Rule: **upstream merges must never touch the brand files.** If an upstream change
conflicts with a brand file, the brand file wins — re-apply the brand change by
hand, never accept the upstream content.

## Getting updates

```sh
git remote -v            # upstream → anomalyco/opencode (dev), origin → this repo
git fetch upstream dev
git merge upstream/dev
# resolve conflicts; brand files always keep the brand content
git push origin dev
```

After each merge:

1. bump `pinnedCommit` in `brand/manifest.json` to the new `HEAD`;
2. bump the `version` field in `packages/opencode/package.json` to upstream's;
3. verify: `bun run --cwd packages/opencode src/index.ts --version`.

## Brand surfaces not yet applied (packaged installs)

`packages/opencode/bin/opencode-fold` is a launcher for a prebuilt platform binary
(`opencode-<platform>-<arch>` npm packages, or `OPENCODE_BIN_PATH`). Source runs
(`bun dev`, `bun run src/index.ts`) bypass it entirely, so the launcher is
unchanged apart from its name and error string. If opencode-fold is ever published
as installable binary packages, the launcher's platform-map names and the binary
package names must be rebranded in the same patch — that is a brand-file change,
documented here, not an upstream change.

## Falsifying control

If `git diff upstream/dev..HEAD` touches any file outside the brand list above,
the brand patch has leaked into the vendor tree and the merge discipline is broken.