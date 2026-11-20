# dsh-plugins

DeepSeek Harness（DSH）插件的**打包副本**集合，用于版本管理与 GitHub 分享。

每个子目录都是一个完整、可安装的本地 bundle：`package.json` 声明 `dsh.bundle.patch` 与 `dsh.client`，`cordis.patch.yml` 向 profile 插入插件行，`index.js`/`client.js` 分别是 Host 半与 Client 半。

## 插件

| 目录 | 包名 | 版本 | 说明 |
|---|---|---|---|
| [`workspace-folders/`](workspace-folders/) | `@local/workspace-folders` | 1.0.0 | 在左侧边栏把已有工作区收进虚拟文件夹（文件夹 → 工作区 → 会话），只在浏览器里记录分类，不改动磁盘目录。 |
| [`dsh-temp-workspace/`](dsh-temp-workspace/) | `@local/dsh-temp-workspace` | 1.0.0 | 侧栏“新建会话”旁的临时会话按钮：每次在 `~/.dsh/temp-workspace` 下新建 `tmp-NN` 目录及其工作区并创建会话，不依赖项目目录。 |

## 仓库与运行时副本

插件**运行时始终放在插件目录**，DSH 通过 `pnpm link` 从那里加载：

```
~/.local/share/dsh-plugins/workspace-folders/      # 运行时副本（DSH 实际加载）
~/.local/share/dsh-plugins/dsh-temp-workspace/     # 运行时副本（DSH 实际加载）
```

本仓库保存同一份内容的打包副本，用于提交、分享与回溯。两者内容相同但不共享文件，更新时同步一次：

```sh
# 仓库 -> 运行时；DSH 会热重载被改动的 client.js
rsync -a --delete --exclude .git workspace-folders/ ~/.local/share/dsh-plugins/workspace-folders/

# 运行时 -> 仓库（在插件目录里调试后回写）
rsync -a --delete --exclude .git ~/.local/share/dsh-plugins/workspace-folders/ workspace-folders/
```

以上同步命令以 `workspace-folders` 为例，`dsh-temp-workspace` 同理。

## 安装

运行时副本放到插件目录后，在 DSH 中注册一次：

```sh
# 命令行（profile 按需替换，如 web / desktop）
dsh plugin --profile web add ~/.local/share/dsh-plugins/workspace-folders
```

或使用图形界面 **设置 → 插件 → 添加插件**，选择对应插件目录。停用插件即恢复内置界面，插件数据（如浏览器里的文件夹分组）仍保留。

## 打包分发

`npm pack` 会把 bundle 打成可分发归档（已验证包含 8 个文件）：

```sh
cd workspace-folders && npm pack
# local-workspace-folders-1.0.0.tgz
```

也可以把本仓库目录直接作为 GitHub 仓库推送，或在 Release 中附上该 tgz。

## 目录约定

- `package.json`：包名、版本、`dsh.bundle.patch`、`dsh.client`；
- `cordis.patch.yml`：插件行；
- `index.js`：Host 半（可为空实现）；
- `client.js`：Client 半（`window.__ModuleLoader__.load` 工厂）；
- `locale/*.json`：插件标题、描述与语言资源；
- `icon.svg`：插件图标；
- `README.md`：使用说明、数据位置与已知限制。
