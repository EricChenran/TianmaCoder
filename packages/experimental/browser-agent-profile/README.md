---
description: "Drive the Desktop browser from agent tools and watch it work live."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-browser-agent-profile

English | [中文](README.zh.md)

## Summary

Add the `browser_*` tools to every Agent on Desktop and let one Human watch the same page the Agent drives. The bundle mounts the [browser-use service](../../browser-use/browser-use/README.md) and the [Desktop guest provider](../browser-use-desktop-guest/README.md), whose guests reuse the sidebar browser's storage partition and login state. It ships switched off in Web and Desktop; select it in Plugins to enable it on Desktop.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

On Desktop, open Plugins and enable **Browser automation** in Official. Switch it off to remove its profile layer. The provider only mounts where the Desktop Host provides its browser control seam, so the Web profile leaves the row disabled with a report instead of failing to boot.

The guests reuse the `default` workspace partition, so a page you already signed into in the sidebar browser is signed in for the Agent too.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts the browser-use service and the Desktop guest provider with its `workspaceKey`. Later profile patches can override both rows by id. The [profile composer](../../boot/app-boot/README.md) owns patch ordering and errors; the [Desktop application](../../../apps/desktop/README.md) owns the control seam its Host provides.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Desktop guest provider](../browser-use-desktop-guest/README.md) · [Session browser resources](../browser-use-runtime/README.md) · [Browser use service](../../browser-use/browser-use/README.md)

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the [Desktop guest provider](../browser-use-desktop-guest/README.md), which owns the tool catalog, results, and page-content trust rules.

#### KV Cache effect

The layer adds no request content directly; the provider owns cache effects from its tools and prompt. Toggling the bundle changes the tool list of live Sessions, which invalidates their cached request prefix once.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The bundle ships switched off: no shipped profile selects it, so a person enables it in Plugins before the tools exist.
- Guests need the Desktop Host: the Web profile has no browser control seam, and the row reports the missing service instead of driving a browser.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context — click to expand</summary>

None.

</details>
