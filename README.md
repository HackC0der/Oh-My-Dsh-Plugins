# dsh-plugins

DeepSeek Harness（DSH）插件的**打包副本**集合，用于版本管理与 GitHub 分享。

每个子目录都是一个完整、可安装的本地 bundle：`package.json` 声明 `dsh.bundle.patch` 与 `dsh.client`，`cordis.patch.yml` 向 profile 插入插件行，`index.js`/`client.js` 分别是 Host 半与 Client 半。

## 插件

| 目录 | 包名 | 版本 | 说明 |
|---|---|---|---|
| [`workspace-suite/`](workspace-suite/) | `@local/workspace-suite` | 1.0.0 | 侧栏工作区套件：可嵌套的虚拟分组（分组 → 工作区 → 会话，已归档会话默认隐藏）＋“新建临时会话”按钮（每次在 `~/.dsh/temp-workspace` 下新建 `tmp-NN` 目录及其工作区并创建会话）；`tmp-*` 临时工作区统一收进置顶的“临时工作区”分组（隐藏即删除、可恢复）。由 `workspace-folders` 1.2.0 与 `dsh-temp-workspace` 1.1.0 合并而来。 |
| [`session-shared-blackboard/`](session-shared-blackboard/) | `@local/session-shared-blackboard` | 2.0.0 | 两种协作面：智能体群聊（多成员聊天室，Markdown 气泡+头像+@提及主动唤醒）与黑板（共享 Markdown 文档，人人可读、编辑排队且轮到时必得最新内容）；会话以“工作区-会话”命名。 |

## 仓库与运行时副本

插件**运行时始终放在插件目录**，DSH 通过 `pnpm link` 从那里加载：

```
~/.local/share/dsh-plugins/workspace-suite/              # 运行时副本（DSH 实际加载）
~/.local/share/dsh-plugins/session-shared-blackboard/    # 运行时副本（DSH 实际加载）
```

本仓库保存同一份内容的打包副本，用于提交、分享与回溯。两者内容相同但不共享文件，更新时同步一次：

```sh
# 仓库 -> 运行时；DSH 会热重载被改动的 client.js
rsync -a --delete --exclude .git workspace-suite/ ~/.local/share/dsh-plugins/workspace-suite/
rsync -a --delete --exclude .git session-shared-blackboard/ ~/.local/share/dsh-plugins/session-shared-blackboard/

# 运行时 -> 仓库（在插件目录里调试后回写）
rsync -a --delete --exclude .git ~/.local/share/dsh-plugins/workspace-suite/ workspace-suite/
rsync -a --delete --exclude .git ~/.local/share/dsh-plugins/session-shared-blackboard/ session-shared-blackboard/
```

## 安装

运行时副本放到插件目录后，在 DSH 中注册一次：

```sh
# 命令行（profile 按需替换，如 web / desktop）
dsh plugin --profile web add ~/.local/share/dsh-plugins/workspace-suite
dsh plugin --profile web add ~/.local/share/dsh-plugins/session-shared-blackboard
```

或使用图形界面 **设置 → 插件 → 添加插件**，选择对应插件目录。停用插件即恢复内置界面，插件数据（如浏览器里的分组）仍保留。

## 打包分发

`npm pack` 会把 bundle 打成可分发归档：

```sh
cd workspace-suite && npm pack
# local-workspace-suite-1.0.0.tgz
```

也可以把本仓库目录直接作为 GitHub 仓库推送，或在 Release 中附上该 tgz。

## 目录约定

- `package.json`：包名、版本、`dsh.bundle.patch`、`dsh.client`；
- `cordis.patch.yml`：插件行；
- `index.js`：Host 半（可为空实现）；
- `client.js`：Client 半（`window.__ModuleLoader__.load` 工厂）；
- `locale/*.json`：插件标题、描述与语言资源；
- `icon.svg`：插件图标；
- `docs/`：详情页文档与预览图（可选）；
- `README.md`：使用说明、数据位置与已知限制。

## 历史

- `workspace-folders` 1.0.0–1.2.0 与 `dsh-temp-workspace` 1.0.0–1.1.0 已合并为 `workspace-suite` 1.0.0，原目录已移除（见 git 历史）。
