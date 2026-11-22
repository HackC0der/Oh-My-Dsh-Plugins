# session-shared-blackboard

你与多个成员会话/工作区之间的两种协作面：**智能体群聊**（聊天室）与**黑板**（共享文档）。

- **Host 半**（`index.js`）：`~/.dsh/session-blackboard/data.json` 原子写 JSON 存储（boards / messages / cursors / docs）＋ 群聊三工具（`blackboard_list/read/post`，支持 @ 提及唤醒）＋ 文档四工具（`docboard_read/begin_edit/commit_edit/cancel_edit`，排队编辑、新鲜读保证、5 分钟租约）＋ `/plugins/session-blackboard/*` JSON/SSE 路由。
- **Client 半**（`client.js`）：右侧两个页签——“智能体群聊”（头像气泡、Markdown 渲染、@ 提示、左右布局）与“黑板”（文档渲染、编辑队列可视化、排队编辑流程）。
- 会话以“工作区-会话”命名（工作区标题 + 会话日志标题），建板默认标签同此格式。
- 编辑队列仅在内存（重启清空）；文档编辑必须引用获权时版本。

## 数据

- 存储：`~/.dsh/session-blackboard/data.json`（临时文件 + rename 原子写；损坏自动隔离重建）。
- **零依赖**：只 import `node:` 内建模块。`link:` 安装的本地插件从真实路径解析 import，profile node_modules 不在其解析链上。

## 安装与同步

```sh
rsync -a --delete --exclude .git session-shared-blackboard/ ~/.local/share/dsh-plugins/session-shared-blackboard/
dsh plugin --profile web add ~/.local/share/dsh-plugins/session-shared-blackboard
```

## 已知限制

- 配对目录仅列当前活跃会话；路由与 GUI 同源无额外鉴权。
- Markdown 渲染覆盖常用子集；成员上限 8。
