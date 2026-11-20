# dsh-plugins

DeepSeek Harness（DSH）插件集合。

## 插件

| 目录 | 包名 | 说明 |
|---|---|---|
| [`workspace-folders/`](workspace-folders/) | `@local/workspace-folders` | 在左侧边栏把已有工作区收进虚拟文件夹（文件夹 → 工作区 → 会话），只在浏览器里记录分类，不改动磁盘目录。 |

## 安装

插件是本地 bundle（`package.json` 里声明 `dsh.bundle.patch` 与 `dsh.client`），安装方式二选一：

```sh
# 命令行（把 <profile> 换成 web/desktop 等）
dsh plugin --profile web add /absolute/path/to/dsh-plugins/workspace-folders
```

或在 DSH 图形界面 **设置 → 插件 → 添加插件**，选择对应插件目录。

安装后按插件 README 使用；停用插件即可恢复内置界面，插件数据仍保留在浏览器中。

## 目录约定

每个插件一个子目录，包含：

- `package.json`：包名、`dsh.bundle.patch`、`dsh.client` 声明；
- `cordis.patch.yml`：向 profile 插入的插件行；
- `index.js`：Host 半（可为空实现）；
- `client.js`：Client 半（`window.__ModuleLoader__.load` 工厂）；
- `locale/*.json`：插件标题、描述与语言资源；
- `icon.svg`：插件图标；
- `README.md`：使用说明与已知限制。
