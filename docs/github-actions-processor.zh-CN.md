# GitHub Actions 处理器配置

网站使用 Cloudflare Worker/D1，Actions 运行有限的扫描、选片与发布步骤，私有 SQLite 库存保存在 R2。原生 AI 调用经 GitHub OIDC 向 PersonalAIService 提交任务，不依赖 VPS CodexGateway 或 Codex CLI。

## 原生 AI 绑定

将 `PHOTOSTORY_URL` 配为站点地址，将 `PHOTOSTORY_BATCH_TOKEN` 配为与 Worker `BATCH_TOKEN` 对应的仓库 Secret。原生 AI 使用仓库 Secret `PHOTOSTORY_NATIVE_BINDING`：

| 字段 | 约束 |
| --- | --- |
| `enabled` | 必须为 `true`；缺少绑定时停止 |
| `project` | 固定为 `Pigbibi/PhotoStory` |
| `service_url` | 已准入服务的 HTTPS origin |
| `audience` | 对应的 MCP resource |
| `adoption_age_seconds` | 1–3600 秒；从原任务创建起计，恢复不延长 |
| `routes` | 精确包含 `screen`、`group`、`cross_review`、`labels`、`strict_review`、`publication` |

每个 route 包含 `mode`、`provider`、`model`、`profile`、`worker`。`mode` 固定为 `agent`，`profile` 与阶段名一致；全部阶段使用同一个 provider、model 和 worker。支持 `dot` 或独立的 `grokbot`。底层客户端保留旧 `grok` 契约，现役 workflow 不将它当作 `grokbot`。

服务端须为各阶段 profile 配置精确的 provider/model 路由，并完成调用方和 worker 准入。GrokBot 还需要真实 Routine HTTPS 入口与 `AI_SERVICE_GROKBOT_WEBHOOK_KEY`。缺少配置时保留已验证的 Dot 绑定，不填写占位入口或切换 provider。

在 main 手动运行 `Process PhotoStory`，选择 `cloud_native_qualification=true`，可向当前绑定提交一张生成色块图。该入口不访问 OneDrive、草稿或发布；通过提交、持久化、读取和结果校验后才写入脱敏回执。HTTP 接收成功不等于任务完成。随后以小范围任务核对进度、R2 快照和草稿无重复，再启用定时处理。

## 库存与定时处理

切换已有处理器前，停止其 batch timer，核对正在运行的 batch 和私有库存。结果不明的 batch 不重放。Worker 的 R2 `MEDIA_BUCKET` 绑定与 `/internal/inventory` 必须可用。

在持有现有私有环境的受限主机上，以 `scripts/cloud_inventory.py seed --directory <private-state-directory>` 导入一致性快照，再用 `status` 回读；上传结果不明时先读回，不重复 seed。运行器临时文件不作为库存来源，不上传 artifact/cache。

验证通过后才设置 `PHOTOSTORY_PROCESSOR_ENABLED=true`。定时任务在每小时第 11、41 分钟尝试启动；GitHub schedule 可能延迟或漏跑。自动发布沿用网站的审批、发布间隔与北京时间设置，同一次运行最多连续推进 20 分钟。未知结果或待核对的发布会停止工作流，不改用另一 provider。

快照先写 R2，Worker 在同一 D1 批次内确认库存指针和进度。非当前快照七天后按限额清理；单份快照限制为 24 MiB。超限或存储故障时停止，不清空库存来重跑。

## 旧 CLI 模式

`run_isolated_ai.py`、`codex-cli` / `aigateway-cli` 与 systemd 模板保留供旧安装识别，已弃用。当前 Actions 不调用它们，无需迁移 Codex 登录文件。不要删除其他仓库共享的网关或凭据。

原 `native_qualification` 保留原任务地址和幂等键，用于原验收的读回；新绑定使用上文的 `cloud_native_qualification`。
