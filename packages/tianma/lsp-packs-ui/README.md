---
description: "Tianma language-pack card on the Web GUI Plugins page: lists the desktop's optional code-intelligence packs and installs or removes them through the desktop bridge."
kind: "package-reference"
---

# @tianma/dsh-lsp-packs-ui

English | [中文](README.zh.md)

## Summary

Adds a Plugins-page card that manages the desktop shell's optional language packs. The card renders only when the desktop shell exposes `dshDesktop.lspPacks`; in a plain browser it registers nothing, so Web deployments that never install packs do not show an empty page.

Each row reports the pack's state from the shell (`missing`, `installed`, `broken`) and offers one action: install a missing or incomplete pack, or remove an installed one. The shell owns the download, the rollback on failure, and the profile patch row; the card only renders state and forwards the request.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

List the plugin in a web bundle's patch, or mount it from a profile:

```yaml
- insert:
    - id: lsp-packs-ui
      name: '@tianma/dsh-lsp-packs-ui'
```

The card appears under the Plugins page in the desktop app only. Installing a pack changes the desktop profile's user patch; a running conversation may need to be reopened before the new language appears in the tool description.

<a id="understand-the-implementation"></a>
## Understand the implementation

The browser half registers one `plugins.item` entry after checking for the desktop bridge. State lives in the shell: the card re-reads the list after every action, so a failed install leaves the previous state visible along with the failure message. Copy is locale-owned through the `settings.lsp-packs` namespace.

<a id="model-experience"></a>
## Model Experience

### Language pack management card

#### What the model sees

Nothing. The card is a browser-side page; it contributes no prompt text, no tool, and no session event.

#### Token effect

None. The package assembles no prompt and issues no request. Installing a pack changes which tools a later session lists — for example `lsp` — and that is the pack's effect rather than this card's.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No cancellation** — the card cannot cancel an install that is already running; the shell bounds each install with its own timeout.
- **Java needs a recent JDK** — the catalog's Eclipse JDT snapshot requires JDK 25; the card reports `java-missing` or `java-too-old` and blocks installation instead of mounting a server that cannot start.
- **Local styling** — the card uses its own CSS module classes and does not yet adopt the shared primitives' spacing scale.

### Dev Note

The card reads the bridge on every render instead of caching it, so a renderer reload inside the desktop shell observes the API exactly as the preload exposes it.
