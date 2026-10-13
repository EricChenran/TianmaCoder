---
description: "Right-Sidebar tab that reports the embedded browser an agent automation is driving."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-agent-browser

English | [中文](README.zh.md)

## Summary

Report the embedded browser page an agent automation is currently driving, as a right-Sidebar tab beside the Session that started it. The tab type, its localized guide entry, and its title are registered here; the guest page itself is owned by the Desktop main process and reaches the tab through the Desktop carrier. The package never injects Electron or Node access into visited content.

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

Open **Agent Browser** from the right-Sidebar guide. The tab attaches to the agent browser lease of its Session, so the pane follows the page the automation is working on without a second navigation of its own. The tab is multiple-capable, matching the Browser tab next to it.

### When to choose it

Choose Agent Browser to watch or supervise an automation. Choose [Browser](../ui-sidebar-browser/README.md) when you want to visit an address yourself; the two coexist and share the workspace storage partition, so a page you are logged into is also logged in for the automation.

### Minimal configuration

The package has no plugin configuration. A profile enables the shipped entry through its bundle patch:

```yaml
- id: ui-agent-browser
```

Client plugins can open a tab through `ctx.sidebarRight.openTab('agent-browser')`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Tab definition

`agentBrowserDefinition` declares the tab kind `agent-browser` with `priority: 'builtin'` and one guide entry, and takes its label from the plugin's locale namespace so the copy stays locale-owned.

### Slot registration

The plugin registers through `ctx.slots.inject` against `'sidebar.right.pane.tab'` and `'sidebar.right.pane.tab.title'`, keyed by `AGENT_BROWSER_ID`. Injection waits for the Sidebar Right declaration, removes both contributions when it collapses, and leaves with the plugin fiber.

### Carrier

The guest is a hardened offscreen `WebContentsView` created by the Desktop main process. The tab's body measures its pane with a `ResizeObserver` and reports the rectangle over the application preload; main attaches the active tab's view at that rectangle, so the human watches the page the automation drives. The client half of this package stays presentation-only and holds no Electron or Node access.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Embedded browser subsystem](../../../docs/subsystems/browser-use.md) — providers, tools, and ownership.
- [Right Sidebar](../../../docs/subsystems/sidebar-right.md) — tab composition, navigation, and lifecycle.
- [browser-use-desktop-guest](../../experimental/browser-use-desktop-guest/README.md) — the model-facing tools that drive the guest.
- [host-browser-control](../../host/browser-control/README.md) — the Host-to-main command envelope.

-----

<a id="model-experience"></a>
## Model Experience

None, as the Agent Browser tab is user-facing presentation state and registers no tool, prompt section, or Session event.

#### KV Cache effect

None; watching a guest page does not enter a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The tab body measures its pane and reports the rectangle to the Desktop shell, which draws the agent guest over it; the pane itself draws no page content, and it stays empty until the automation opens a lease for the same Session.
- The pane reports geometry but does not yet show an in-flight indicator, element highlights, dialog prompts, or download progress.
- The tab attaches to a Session's agent browser lease and owns no navigation of its own: there is no address bar, and opening the tab never loads a URL the automation did not load.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The tab kind is registered in `packages/bundle/web-app/cordis.patch.yml`; a profile that omits that row has no Agent Browser tab and no behavior change elsewhere.

</details>
