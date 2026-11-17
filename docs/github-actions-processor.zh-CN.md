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

若回执未验证，保留原 task ID。读取同一任务时仍选择 `cloud_native_qualification=true`，将 `native_qualification_task_id` 设为原 ID、`native_qualification_action` 设为 `readback`，`native_qualification` 保持 false。读回仅 GET 原任务，核对固定合成请求、provider、worker 和结果格式，不重新提交或取消。`completion_verified` 只证明任务按时完成，`adopted` 仍为 false；不会将过期结果采纳为业务输出。

## Muse 筛选试点

在 PersonalAIService 的同一 PhotoStory 项目准入 `agent:muse-screen`、指定模型及 Muse worker，项目允许的最长执行时间设为 600 秒。Muse 云端轮询间隔和心跳窗口都要留出识图及回传时间。PhotoStory 发给其他阶段的请求仍限 60 秒，结果采纳时限应覆盖试点执行和续跑。

仓库 Secret `PHOTOSTORY_MUSE_SCREEN_BINDING` 包含 `job_id`、`model`、`worker` 三个字段。先用占位 job ID，在 main 手动运行 `cloud_native_qualification=true` 和 `qualify_muse_screen=true`。验收要求识别生成色块的主色通道，并校验原任务回执。验收通过后再设为选定的小批量任务 ID，并在该任务运行期间保留绑定。

PersonalAIService 只向 PhotoStory Worker 的 `/internal/screen-completed` 投递 `muse-screen` 的签名终态通知。双方使用同一个至少 32 字节的受保护 Secret，PhotoStory 的绑定名为 `SCREEN_COMPLETION_SECRET`。通知只携带任务身份和状态；处理器从原任务读回建议，并校验同一领取记录、时限和输出结构。

Worker 使用单仓 GitHub App 唤醒主分支的 `processor.yml`。配置 `SCREEN_RESUME_APP_ID`、`SCREEN_RESUME_INSTALLATION_ID`，并把 PKCS#8 私钥直接绑定为 `SCREEN_RESUME_APP_KEY` Secret。App 仅安装到 PhotoStory 并具备 Actions 写权限；每次唤醒使用短期安装凭据。

回传只唤醒对应的已挂起批次，唤醒路径跳过自动发布。为该通知在 PersonalAIService 设置 `timeout_ms: 20000`，留出签发安装凭据和请求 GitHub 的时间。GitHub 确认接收后 Worker 才确认唤醒。明确拒绝时允许同一通知重试，结果不明时保留原断点，由现有定时处理器按原 ID 读回。

Muse 试点只请求图片筛选。处理器从筛选通过的照片按场景和画幅挑选代表照，生成待编辑草稿。流程使用现有库存去重，照片、分组和文案由人工复核。退出试点前确认原任务和库存快照已结清，再移除试点绑定。

## 库存与定时处理

切换已有处理器前，停止其 batch timer，核对正在运行的 batch 和私有库存。结果不明的 batch 不重放。Worker 的 R2 `MEDIA_BUCKET` 绑定与 `/internal/inventory` 必须可用。

在持有现有私有环境的受限主机上，以 `scripts/cloud_inventory.py seed --directory <private-state-directory>` 导入一致性快照，再用 `status` 回读；上传结果不明时先读回，不重复 seed。运行器临时文件不作为库存来源，不上传 artifact/cache。

验证通过后才设置 `PHOTOSTORY_PROCESSOR_ENABLED=true`。定时任务在每小时第 11、41 分钟尝试启动；GitHub schedule 可能延迟或漏跑。自动发布沿用网站的审批、发布间隔与北京时间设置，同一次运行最多连续推进 20 分钟。未知结果或待核对的发布会停止工作流，不改用另一 provider。

快照先写 R2，Worker 在同一 D1 批次内确认库存指针和进度。非当前快照七天后按限额清理；单份快照限制为 24 MiB。超限或存储故障时停止，不清空库存来重跑。

## 旧 CLI 模式

`run_isolated_ai.py`、`codex-cli` / `aigateway-cli` 与 systemd 模板保留供旧安装识别，已弃用。当前 Actions 不调用它们，无需迁移 Codex 登录文件。不要删除其他仓库共享的网关或凭据。

原 `native_qualification` 保留原任务地址和幂等键，用于原验收的读回；新绑定使用上文的 `cloud_native_qualification`。
