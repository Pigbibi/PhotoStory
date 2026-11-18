# GitHub Actions 处理器配置

[English](github-actions-processor.md) | 简体中文

网站使用 Cloudflare Worker 和 D1，GitHub Actions 运行有限的扫描、选片与发布步骤，私有 SQLite 库存保存在 R2。处理器支持直接调用 OpenAI / Anthropic HTTPS API，或通过通用 OIDC 任务网关提交受限任务。

## 方式 A：直接调用 OpenAI 或 Anthropic API

未设置 `AI_TASK_GATEWAY_URL` 和 `PHOTOSTORY_NATIVE_BINDING` 时，`process_batch.py` 会通过 `scripts/direct_ai_client.py` 直接调用官方 HTTPS 接口：

| 配置项 | 存放位置 | 用途 |
| --- | --- | --- |
| `OPENAI_API_KEY` | GitHub Actions Secret | 调用 OpenAI Responses API（严格 JSON Schema） |
| `PHOTOSTORY_OPENAI_MODEL` | GitHub Actions Variable | 覆盖默认的 `gpt-4.1-mini` 模型 |
| `ANTHROPIC_API_KEY` | GitHub Actions Secret | 调用 Anthropic Messages API（`record_result` 结构化工具输出） |
| `PHOTOSTORY_ANTHROPIC_MODEL` | GitHub Actions Variable | 覆盖默认的 Anthropic 视觉模型 |
| `PHOTOSTORY_AI_PROVIDER` | GitHub Actions Variable | 同时配置两把密钥时指定 `openai` 或 `anthropic` |

直接 API 请求禁用 HTTP 重定向、限制请求与响应体上限并在本地重新校验 JSON Schema，按批同步执行。

## 方式 B：通用 OIDC 任务网关

将 `PHOTOSTORY_URL` 配为站点地址，`PHOTOSTORY_BATCH_TOKEN` 配为与 Worker `BATCH_TOKEN` 一致的仓库 Secret，将 `AI_TASK_GATEWAY_URL` 配为网关 HTTPS 入口，并配置仓库 Secret `PHOTOSTORY_NATIVE_BINDING`：

| 字段 | 约束 |
| --- | --- |
| `enabled` | 必须为 `true`；缺少或禁用时立即停止 |
| `project` | 须与 `PHOTOSTORY_PROJECT`、`GITHUB_REPOSITORY` 或默认 `owner/repo` 一致 |
| `service_url` | 网关的 HTTPS origin |
| `audience` | 对应的 OIDC token audience |
| `adoption_age_seconds` | `1`–`3600` 秒；从原任务创建起计，续跑不延长 |
| `routes` | 精确包含 `screen`、`group`、`cross_review`、`labels`、`strict_review`、`publication` |

每个阶段路由包含 `mode`（`agent` 或 `api`）、`provider`（合法标识符）、`model`、`profile`（与阶段名一致）和 `worker`，全部六个阶段须采用一致的路由器配置。

切换绑定前，可在 `main` 手动运行 `Process PhotoStory` 并勾选 `inspect_runtime=true`，只读检查活动任务标记、库存就绪状态与当前快照字节数。

在 `main` 手动运行 `Process PhotoStory` 并勾选 `cloud_native_qualification=true`（可选设置 `qualification_stage` 为单阶段或 `all`），可在接入真实照片前先以合成色块与文本验收各阶段输出格式。若回执未验证，保留原 task ID 并配合 `native_qualification_action=readback` 与对应 `qualification_stage` 只读回查，不重新提交任务。

## 异步筛选路由（`PHOTOSTORY_SCREEN_BINDING`）

若网关需要把较慢的批量筛选拆到异步工作路由，可配置 `PHOTOSTORY_SCREEN_BINDING`（包含 `job_id`、`model`、`worker`，以及可选的 `provider`、`profile` 和 `mode`）。

异步筛选使用 `async-screen`（或兼容旧配置）profile 及 600 秒超时窗口。网关完成后向 Worker 的 `/internal/screen-completed` 发送签名通知（使用至少 32 字节的 `SCREEN_COMPLETION_SECRET`），Worker 再通过 `SCREEN_RESUME_APP_*` 唤醒挂起批次。

首次启用前应同时勾选 `cloud_native_qualification=true` 与 `qualify_screen_route=true` 完成色块验收，再设置真实批量的 `job_id`。确认挂起任务与 R2 快照结清后再移除该配置。

## 库存快照与定时处理

从旧 VPS 切换到 GitHub Actions 前，先停止本地 timer 并让运行中的批次结束。在受限主机上运行一次 `scripts/cloud_inventory.py seed --directory <state-dir>` 导入一致性快照并用 `status` 核对。

验证通过后设置 `PHOTOSTORY_PROCESSOR_ENABLED=true`。快照加密或隔离存放在私有 `MEDIA_BUCKET`（单份上限 24 MiB），与 D1 进度原子提交，旧快照按七天限额清理。
