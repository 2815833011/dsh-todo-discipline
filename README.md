# dsh-todo-discipline

让 todo 清单在长会话里活下来。

> English: keeps the todo list alive across long DSH sessions — a standing
> policy in the system prompt (never summarized away) plus a runtime-context
> state line restated from the session projection, so the list survives
> compaction and goes stale loudly instead of silently.

---

## 它解决两个独立故障

**一、清单写一次就不动了。**
`todo_write` 是整表替换，追加进会话，最后一次写入生效。只调一次的模型会让后面所有步骤都
不可见——面板一直停在第 1 步，而活早就干完了。

**二、上下文压缩把清单从历史里删了。**
`todos` 这个 session projection 仍然能从事件日志里折出清单，所以 UI 还在渲染它；但模型
已经看不见了。模型没有任何线索知道自己计划过什么，于是要么重头再来，要么忘了收尾。

### 解法

| 手段 | 挂载点 | 为什么有效 |
|---|---|---|
| 常驻策略 | `ctx.systemPrompt.section({ name: 'todo:policy', order: 400 })` | 系统消息，压缩时不会被摘要掉 |
| 状态重述 | `ctx.systemPrompt.context({ name: 'todo:state', order: 130 })` | 从 projection 折出清单，压缩后重新出现在模型眼前 |
| 陈旧提醒 | 同上，`staleSteps` 步没写入就换一版文本 | 文本变了才注入，不刷屏 |
| 收工闸门 | `agent/turn-stopping` + `agent.steer` | 还有未完成项就想收工，把话推回去 |

`order: 400` 在 persona(0) 之后、plan(500) 和 team(600) 之前——这是一条工作规则，不是人格。

---

## 工作原理

状态行由 `foldDiscipline` 从两个来源折出：

```js
{ turnSteps, lastWriteStep, compactions }   // 本插件自己的 projection
todos                                        // todo 工具拥有的 projection，只读
```

- `turnSteps` 每次 `agent/pre-step` 加一；
- 模型调 `todo_write` 时 `lastWriteStep = turnSteps`（`isWriteLike` 判工具名）；
- `compaction/summary` 时 `compactions` 加一，状态行因此变化一次——这就是「压缩后重述」的触发点；
- `turnSteps - lastWriteStep >= staleSteps`（默认 8）时，状态行多一句提醒，并且**每个窗口只提醒一次**
  （用 `listFingerprint` 去重：清单没改就继续等，改了才重置）。

### 为什么不用每步计数的倒计时

runtime-context 的接纳规则是「拼接文本与保留快照不同才注入一条新消息」。一个每步都变的
倒计时会让每一步都多烧一条用户消息。所以状态行只允许在事件发生时变。

### 收工闸门

`agent/turn-stopping` 触发时，如果清单还有未完成项、且本轮从没更新过清单，就 `agent.steer()`
一条 `form: 'notice'` 消息把轮次推回去。`gateMaxBlocks`（默认 3）限制连续阻止次数——被卡住的
模型不会无限烧预算，闸门自己也会停。

---

## 装

```bash
cd ~/.dsh/profiles/desktop
pnpm add link:~/Documents/dsh-workspace/link-plugins/dsh-todo-discipline
```

profile 的 `dsh.profile.bundles` 里加 `dsh-todo-discipline`。bundle 的
`cordis.patch.yml` 自动加载；要覆盖配置就在 profile patch 里加**顶层** `- id: todo-discipline`。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `staleSteps` | `8` | 多少步没 `todo_write` 就提醒一次 |
| `gateMaxBlocks` | `3` | 收工闸门最多连续阻止几次 |

---

## 三个会让人卡半天的坑

1. **注入消息必须带 `id`。** loop 按身份去重待投递消息
   （`if (ids.has(message.id)) throw new Error(...)`），没有 id 的消息第一次能过，第二次直接抛。
2. **`source.kind` 必须是 producer-owned，不能写 `{ kind: 'plugin' }`。** session format v4
   会拒绝这个包装（`format v4 message requires a producer-owned source kind`），而且失败表现为
   **整轮死掉**，不是被 catch 住的异常。参考内核自己的 `dsh-repeat-tool-reminder`：
   `const REMINDER_SOURCE = { kind: 'repeat-tool-reminder' }`。
3. **`form: 'notice'` 配一行 `summary`**，否则这行会在派生历史里渲染成用户提示词而不是注入行。
   `summary` 长度上限 120 字符（对齐 `dsh-llm` 的 `CONTEXT_SUMMARY_MAX_CHARS`，因为 link 安装
   无法 import 它）。

另外：用 `pnpm add link:<dir>` 装的插件走真实路径解析，对 `@deepseek-ai/*` 的裸导入会
`ERR_MODULE_NOT_FOUND`。所以 projection 的 schema 是手写在 `schema.js` 里的，只实现注册表
真正会调用的 `parse`。

## 排错

| 症状 | 原因 |
|---|---|
| 清单一直停在第 1 步 | 模型没再调 `todo_write`；`staleSteps` 到了会提醒，但改不了它不写 |
| 压缩后模型重头规划 | 状态行没生效（`inject` 里漏了 `sessionProjections`，或 projection key 写错） |
| 每步都多一条用户消息 | 状态行里混进了每步都变的数值 |
| 收工被反复推回 | 清单确实没做完；`gateMaxBlocks` 到上限后会自动放行 |
| 整轮直接死掉、无报错 | 注入消息缺 `id` 或用了 `kind: 'plugin'` |

## 测试

```bash
node test-state.mjs    # 折叠、指纹、提醒窗口
node test-host.mjs     # 注册、注入消息形态
node test-v4.mjs       # v4 消息格式兼容性
```

## License

MIT
