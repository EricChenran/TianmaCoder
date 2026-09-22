# TianmaCoder Web → Electron desktop client migration design (PR document)

English | [中文](desktop-client-migration-plan.zh.md)

> Status: design review draft (Draft PR); Date: 2026-09-22; Scope: `apps/desktop`, `apps/desktop-host`, `apps/web`, `apps/cli`, root scripts and docs; Related decisions: `apps/desktop/README.md` (thin-wrapper, packaging & updates, primary-runtime — three archived decisions)

## 1. Requirement restatement and goals

User requirement: reshape TianmaCoder from the "browser-accessed web service" form into an "independently installed, standalone-window Electron desktop client" form, and produce this design document as a PR for review first.

### Goals

1. **Form goal**: users double-click a desktop icon and go — no browser, no manual `dsh web` startup; native window, system-tray semantics (application menu), auto-update, offline installability.
2. **Reuse goal**: no business rewrite — the web frontend (the Vite build of `apps/web`) and the Host backend serve unchanged as the client's render and service layers; Electron is only the "shell".
3. **Security goal**: zero Node capability and zero arbitrary IPC in the renderer; every privileged capability converges into the preload allowlist bridge plus the main process.
4. **Quality goal**: web and desktop forms share one frontend and Host implementation, so any functional change lands in both forms at once with no form divergence.

### Non-goals (explicitly out of scope)

- No separate UI built for the desktop form.
- No rewrite of the Host backend as an embedded main-process service (it stays an independent subprocess; crash isolation is unchanged).
- This PR does not purchase code-signing certificates or store listing (the packaging pipeline already reserves an unsigned channel).

## 2. Current state (key facts)

Investigation confirms the **Electron desktop form's infrastructure largely exists** in the repository; this plan is not built from zero but "fills gaps, closes seams, and verifies":

| Asset | Location | State |
|---|---|---|
| Electron main process | `apps/desktop/src/` | Full main/preload set (window, single-instance lock, updates, welcome window, force update, directory picker, microphone permission, in-platform webview view, Windows title-bar layout, and 40+ more modules) |
| Private Host process | `apps/desktop-host/` | RunAsNode subprocess launching the shared profile runner |
| Web frontend | `apps/web/` | Vite builds `@deepseek-ai/dsh-web-frontend`; the desktop shell loads the dist through the `dsh-app://app/` custom protocol |
| Packaging and updates | `apps/desktop/electron-builder.config.mjs` + root `package:desktop*` scripts | mac arm64/x64, win x64 (unsigned included), `electron-updater` |
| Standalone runtime | `scripts/primary-runtime/` | The desktop ships its own Python/Node/pnpm payload, free of system dependencies |
| Web-form entry | `apps/cli` (`dsh web`, port 3080) | Retained; never conflicts with the desktop port 19387 |

The core work of this plan is therefore four things: **close brand and identity, close experience gaps, close the verification loop, and open the release pipeline**.

## 3. Overall architecture

```
┌─ Electron main process (apps/desktop, main.ts) ──────────────┐
│  Single-instance lock → owns $DSH_HOME/profiles/desktop      │
│  BrowserWindow loads dsh-app://app/ (packaged apps/web dist) │
│  dsh-app://shell/ → local update/welcome assets (no Host)    │
│  IPC allowlist bridge (boot injection/ready/shutdown/picker/ │
│  update confirmation)                                        │
└──────────────┬──────────────────────────────────────────────┘
               │ RunAsNode subprocess (ELECTRON_RUN_AS_NODE=1)
┌─ Private Host (apps/desktop-host, port 19387) ───────────────┐
│  Shared profile runner + Web Host: authenticated HTTP API +  │
│  WebSocket. Desktop-only profile: apps/desktop deps come     │
│  from app.asar/dsh; only external plugins install through    │
│  the shared Plugin Manager + bundled pnpm                    │
└──────────────────────────────────────────────────────────────┘
```

Key principles (carried over from existing decisions; acceptance constraints in this PR):

1. **Thin shell**: the desktop shell implements no business logic; shared web behavior plus desktop adapters.
2. **Single version**: the Electron shell releases at the same version as `@deepseek-ai/dsh` — one upgrade unit — so shell/kernel version drift is impossible.
3. **Process ownership**: desktop exclusively owns `profiles/desktop`; CLI/Web and desktop share product data but not executable packages, plugin activation, or lockfiles, and the two processes never race one profile.
4. **Transport reuse**: load the packaged web static assets through the custom protocol; authenticated API/WS run through the same Host implementation.

## 4. Work breakdown

### P0 — Brand and identity closure (the main new work of this PR)

The brand is already TianmaCoder (see `brand/` and the TianmaLogo in `packages/client/ui-primitives`), but "DeepSeek Harness" identity remains inside the desktop shell; close it:

1. `apps/desktop` product name, About panel, application menu copy, welcome/update dialog copy: DeepSeek Harness → TianmaCoder (en/zh, passing the `verify-client-ui-i18n` gate).
2. Icons: replace `resources/icon.png/svg` and platform variants with exports of the signal-wave mark from `brand/assets/` (Windows multi-size ICO, macOS inset-rounded 1024px ICNS, installer side BMP 164×314), following the icon conventions in `apps/desktop/README.md`.
3. `electron-builder` `productName`/`appId`/update-feed metadata and installer copy move to the brand in lockstep.
4. Update channel and `x-client-platform` mapping mechanics are unchanged; only the displayed names change.

### P1 — Experience gap closure

1. **Window and title bar**: the Windows 40-DIP native title-bar tint sources from the app palette — confirm the source is the TianmaCoder theme tokens, not legacy brand colors.
2. **Loading page**: brand the shared loading page (logo/copy); start the client in place after the Host boot injection, with no document jump.
3. **First run**: verify the welcome-window flow (language zh_CN/en_US, update notes) and brand the copy.
4. **Deep links/file associations**: if the product needs them (e.g. `tianmacoder://`), filed as a later PR — not this one.

### P2 — Verification loop (executed after review approval)

1. `pnpm build:lib && pnpm build:web && pnpm dev:desktop` developer smoke: window loads, sign-in, sessions, plugin pages, directory picker, F12 DevTools.
2. `pnpm package:desktop:win:x64:unsigned` local package + `check:package`; install/launch/uninstall smoke.
3. Local update-chain verification: `pnpm --filter @deepseek-ai/dsh-desktop run test:updates:local`.
4. Existing test surfaces: `apps/desktop/tests`, `apps/desktop-host`, web frontend vitest all green; i18n gate passes.
5. Dual-form regression: `apps/cli` `dsh web` (port 3080) and desktop (19387) run in parallel without interference; profiles never cross-contaminate.

### P3 — Release pipeline (later PR)

Signing (the Windows hardware-token flow is already implemented in the packaging scripts; a certificate is needed), macOS notarization, update-feed go-live. This phase only produces unsigned packages for internal testing.

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Brand replacement touches many i18n assertions and fails gates | Replace per package and run `verify-client-ui-i18n`; update snapshots uniformly with vitest -u |
| Windows packaging PE scan/signing behavior differs when unsigned | Internal testing standardizes on `package:desktop:win:x64:unsigned`; the signing flow gets dedicated P3 verification |
| Web and desktop share a frontend, so changes may break the `dsh web` form | Dual-form parallel regression is on the acceptance checklist (P2.5) |
| Stale leftovers in `profiles/desktop` (profiles from the original DeepSeek naming era) | Startup runtime-descriptor validation already refuses incompatible payloads; upgrade notes mention a profile reset when needed |

## 6. Acceptance criteria

1. The Windows x64 unsigned package installs, launches, and completes one full conversation with no browser and no system Node/Python anywhere.
2. App icon, name, About, menus, and loading page are all TianmaCoder brand; en/zh follows the shell locale.
3. `apps/desktop`, `apps/desktop-host`, and `apps/web` tests all green; the i18n gate passes.
4. Desktop and web forms are functionally identical: the same functional change behaves identically under `dsh web`.
5. The local update-chain smoke passes (test:updates:local).

## 7. Implementation order and commit split

1. `feat(desktop): rebrand shell identity to TianmaCoder` (P0.1–P0.3, including icon assets)
2. `feat(desktop): polish loading/welcome experience under new brand` (P1)
3. `chore(desktop): migration verification checklist and docs` (P2 results + this document finalized)
4. P3 signing/notarization/release ships as a separate PR.
