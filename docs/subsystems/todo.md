# Todo

English | [中文](todo.zh.md)

The durable todo vocabulary owned by [`@deepseek-ai/dsh-tool-todo`](../../packages/todo/tool-todo/README.md). The model-facing tool replaces one agent session's whole list; the package also owns the event declaration, replay projection, and invariant companion. Tool behavior and configuration are on the [package README](../../packages/todo/tool-todo/README.md).

Source: [`packages/todo/tool-todo/src/types.ts`](../../packages/todo/tool-todo/src/types.ts)

## `TodoItem` — one list entry

```ts type-equiv
/**
 * One entry in an agent's todo list — the unit of the `todo/write`
 * whole-list snapshot declared by this package.
 *
 * Deliberately minimal: a human-readable `content` line and a three-state
 * `status`. No id, priority, or `activeForm` — the list is replaced wholesale
 * on every write (last-write-wins), so entries need no stable identity. The
 * three statuses describe the complete portable lifecycle needed by model and
 * UI consumers.
 */
interface TodoItem {
  /** What this task is — a short imperative line shown in the UI. */
  content: string
  /** Lifecycle state. `in_progress` marks a task being worked now; parallel work may mark several. */
  status: 'pending' | 'in_progress' | 'completed'
}
```

## `TodoStaleness` — how far the plan has drifted

```ts type-equiv
/**
 * How far the standing list has drifted from the work: the agent steps
 * committed since the newest whole-list write, plus whether that list still
 * carries an unfinished entry. A UI marker derived from the log, never written
 * back — it exists because a list the model stopped updating otherwise reads
 * as current, and no fold can tell which task the work actually reached (the
 * entries carry no identity a tool call could be matched against).
 */
interface TodoStaleness {
  /** Agent steps committed since the newest `todo/write`; 0 while that write is the newest step boundary. */
  stepsSinceWrite: number
  /** Whether the newest `todo/write` list still carries a `pending` or `in_progress` entry. */
  unfinished: boolean
}
```

The `todos` projection unit carries the plan; `todoStaleness` carries its drift. Entries have no identity a tool call could be matched against, so nothing can derive which task the work reached — the drift is what a carrier shows instead when steps keep committing and the list does not move. A turn start resets both: the plan to `null`, the drift to zero with no unfinished work. A fully completed list reports `unfinished: false` however old it is.

## Durable event and invariant

The package declaration-merges `todo/write: { todos: TodoItem[] }` into `SessionEventMap`. The event is log-only and carries the complete replacement list; the generated [persistence catalog](../persistence-catalog.md#todowrite--log-only) records its declaration site. The package's invariant companion validates existing and newly announced sessions in one pass, then tracks committed turn boundaries incrementally so every live `todo/write` is checked before append without rescanning the log.
