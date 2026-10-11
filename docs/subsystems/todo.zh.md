# Todo

[English](todo.md) | 中文

本页记录 [`@deepseek-ai/dsh-tool-todo`](../../packages/todo/tool-todo/README.zh.md) 拥有的持久 todo 词汇。面向模型的工具会整体替换一个 agent（智能体）会话的列表；该包还拥有事件声明、回放投影和不变量配套插件。工具行为与配置见[包 README](../../packages/todo/tool-todo/README.zh.md)。

源码：[`packages/todo/tool-todo/src/types.ts`](../../packages/todo/tool-todo/src/types.ts)

## `TodoItem`：一条列表项

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

## `TodoStaleness`：计划偏离了多少

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

`todos` 投影单元承载计划，`todoStaleness` 承载其偏离度。条目不具备可供工具调用匹配的身份，因此无法推导出工作究竟推进到哪一条；当步数持续提交而清单不再移动时，载体展示的就是这份偏离度。轮次开始会同时重置二者：计划变为 `null`，偏离度归零且无未完成工作。已全部完成的清单一律报告 `unfinished: false`，无论多旧。

## 持久事件与不变量

该包通过声明合并把 `todo/write: { todos: TodoItem[] }` 加入 `SessionEventMap`。此事件仅写入日志，并携带完整替换列表；生成的[持久化目录](../persistence-catalog.zh.md#todowrite--log-only)会记录其声明位置。该包的不变量配套插件会单次遍历校验现有会话和新发布的会话，随后增量追踪已提交的轮次边界，使每个实时 `todo/write` 都能在追加前得到校验，而无需重新扫描日志。
