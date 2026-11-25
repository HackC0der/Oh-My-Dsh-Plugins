# model-balance

DSH 插件：在一个右侧栏页签里集中查询各模型服务商的套餐额度与账户余额——GLM Coding Plan 的 **5 小时窗口**、**每周窗口**与工具调用窗口（百分比、剩余量、重置倒计时、分工具用量）、DeepSeek 钱包余额、OpenRouter 余额；智能体可通过 `balance_query` 工具读取同样的数据。

## 功能

- **GLM Coding Plan**（`api.z.ai` / `open.bigmodel.cn`）：套餐档位、每个额度窗口的用量进度条、已用/总量、剩余次数、重置倒计时；工具调用窗口附分工具用量明细；未知窗口形态照常展示，不静默丢弃。
- **DeepSeek 开放平台**：`/user/balance` 按币种的余额行，含赠送 / 充值拆分与"可继续调用"状态点。
- **OpenRouter**：`/api/v1/credits` 剩余额度与已用进度条。
- **账号管理**：每个服务商可保存多个账号（显示名、可选基础地址覆盖、API 密钥或环境变量名、启用开关），全部在面板内增删改；`apiKeyEnv` 指向的环境变量在查询时由 Host 读取（如 `ZAI_CODING_CN_API_KEY`），已保存的密钥优先。
- **输入框下方仪表**：统计条（tokens/s、缓存命中、上下文圆环旁）为当前会话所用的 GLM 账号显示一对 270° 弧形仪表（5 小时 / 每周窗口），**阴影弧占比 = 已用百分比**，百分比数字按阈值变色；点击弹出面板查看完整数字；账号通过 `matchRoutes` 绑定模型路由（空格分隔、精确匹配，如 `zai-coding-cn`）。
- **自动发现 DSH 模型密钥**：无需手动添加入口——插件直接读取 Models 页写入的 `llm-pi-ai/<路由>` 凭证记录（`ctx.credentials`），按路由自动映射到 GLM / DeepSeek / OpenRouter 并查询余额；已手动添加的同厂商账号优先。环境变量（`DEEPSEEK_API_KEY`、`OPENROUTER_API_KEY`、`ZAI_*`、`BIGMODEL_API_KEY`）作为后备。自动账号在面板中以「自动」徽标显示，不可编辑/删除。
- **智能体工具**：`balance_query [account] [refresh]`，返回所有（或指定）启用账号的标准化数据（含自动发现的账号）。
- **缓存**：结果缓存 30 秒、失败结果 15 秒，面板轮询（60 秒）与智能体调用共享，避免频繁请求控制台。

## 端点

GLM 的额度端点 `/api/monitor/usage/quota/limit` 是控制台自用端点（社区工具通用），不在官方公开 API 文档中，字段可能变化。DeepSeek 与 OpenRouter 端点是官方文档公开接口。

## 数据与安全

- 账号保存在 `~/.dsh/model-balance/accounts.json`（原子写入，0600 权限）；
- API 密钥只在 Host 侧保存与使用，浏览器只收到 `…末4位`，也从不直接访问服务商控制台（由 Host 代理）；也可只存环境变量名，密钥不落盘；
- 删除账号即删除其密钥；移除插件保留数据文件。

## 安装

参见仓库根 README；目录为 `~/.local/share/dsh-plugins/model-balance`，然后：

```sh
dsh plugin --profile web add ~/.local/share/dsh-plugins/model-balance
```
