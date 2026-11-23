# 模型别名（model-alias）

## 解决什么问题

DSH 内置的「设置 → 模型」页在**添加模型**时区分两种方式：

- **第三方模型提供商**（自定义路由）：可重复添加，因为每条路由写在 `llm-pi-ai.providers.<你起的名字>`；
- **标准厂商**（OpenAI、Anthropic、Moonshot 等内置目录里的厂商）：一旦配置过一次，就会从“可添加”列表中消失（`addable` 只列出未配置的厂商，全部配置完后“标准厂商”标签被禁用并提示 exhausted）。

因此同一个厂商没法配第二个 Key。本插件补上这个能力：

- 新增设置页 **「设置 → 模型别名」**（紧跟在「模型」之后）；
- 厂商下拉框**永远列出全部标准厂商**，已配置的用「已配置」标记，但仍可选——选项不会消失；
- 每条配置带**别名**（写入 profile 的 `displayName`，即模型选择器里显示的名字）和**独立的 API Key**（存在该路由派生的凭据引用下，如 `OPENAI_WORK_API_KEY`）。

## 工作原理

写入的就是 pi-ai 适配器的标准配置形状（与「第三方模型提供商」完全同一条通路）：

```yaml
# settings 用户层 llm-pi-ai 段
providers:
  openai-work:                 # 路由 ID（创建后不可改，是配置的地址）
    displayName: OpenAI 工作   # 别名 → 模型选择器里单独成组显示
    api: openai-completions    # 协议（Anthropic → anthropic-messages，Gemini → google-generative-ai）
    baseURL: https://api.openai.com/v1
    apiKeyEnv: OPENAI_WORK_API_KEY
    models:
      - id: gpt-4o
```

- 路由键不在内置目录中，所以适配器把它当作**手工声明路由**：`api`、`baseURL`、非空 `models` 为必填（表单强制校验）；
- 模型列表可以**从厂商接口拉取**（带刚输入的 Key 调 `llm/discoverModels`），或手动填写；手动条目与拉取结果合并，已有条目不会被覆盖；
- 创建后，这条路由会自动出现在内置「模型」页（带「自定义」标签）和输入框的模型选择器里（以别名单独分组），与会话/子代理等所有模型选择处一致。

对已有别名的**编辑**采用最小 path-op：只写改动过的字段（别名 / 接口地址 / 协议 / 模型列表 / 新 Key），`cordis.patch.yml` 等部署层固定的其它字段（retryPolicy、headers…）不受影响；模型列表合并时保留本表单未管理的字段（如 `reasoningEfforts`、`compat`）。**删除**会先删凭据再 unset 路由，两步均幂等，失败可重试。

## 为什么不直接改内置「模型」页

- 客户端模块表拒绝重复注册同 id 的工厂，无法用另一个 bundle 重写 `@deepseek-ai/dsh-client-ui-settings-models` 的实现；
- 用 `settings.section` 同 id 阴影替换则要求整页重写（厂商卡、编辑器、新手引导等约三千行实现），升级极易碎。
- 因此本插件选择**纯增量**：内置页保持原样（第一次配置走内置页即可），第二个及以上的 Key 统一在「模型别名」页管理。

## 数据位置

- 路由配置：settings 文档 `llm-pi-ai` 段的用户层（与内置页同源）；
- API Key：凭据服务（`credentials/set`），引用名由路由 ID 派生 `<ROUTE>_API_KEY`；
- 卸载插件即移除入口，已声明的路由仍由 pi-ai 适配器照常服务（配置在 settings 文档里，不随插件走）。

## 已知限制

- 只覆盖 pi-ai 家族（标准 Key 厂商）；DeepSeek 官方（`llm-deepseek` 整段单 profile）与账号登录不在此列；
- 路由 ID 创建后不可改（改名等于删除重建）；
- 只读部署（settings 不可写）时页面禁用全部写操作。
