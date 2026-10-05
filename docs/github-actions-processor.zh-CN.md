# GitHub Actions 处理器迁移

此模式只把 PhotoStory 的扫描、选片与定时触发从 VPS 搬到 GitHub 托管运行器。
网站仍在 Cloudflare Worker/D1，私有 SQLite 库存保存在现有 R2 bucket。
CodexGateway 服务及登录继续留在 VPS，仍为其他仓库服务；PhotoStory 工作流
使用 GitHub OIDC 调用它，不复制 Codex 登录文件，也不调用 OpenAI API 或 Cursor。

## 切换前

1. 确认 `photostory-batch.timer` 已停，且没有正在运行的 PhotoStory batch。
   先核对 Worker 任务状态及 VPS 库存；结果不明的 batch 不得重放。
2. 为 CodexGateway 服务端增加精确 OIDC 允许项：仓库
   `Pigbibi/PhotoStory`、workflow ref
   `Pigbibi/PhotoStory/.github/workflows/processor.yml@refs/heads/main`、
   ref `refs/heads/main`，以及公开仓库可见性。不要放宽成所有仓库或所有 workflow。
   现有服务默认只接收 2 MB 请求；照片多图请求需要将服务端
   `CODEX_GATEWAY_SERVICE_MAX_REQUEST_BYTES` 设为至少 `16000000`。
   PhotoStory 客户端自身限制为 15 MB；超限会失败，不会改用其他模型。
   PhotoStory 明确使用已经在此 VPS 登录下验证的 `gpt-6-sol`；如以后需要
   更换，可设置仓库变量 `CODEX_GATEWAY_SERVICE_MODEL`，不改变其他仓库的路由。
3. 将现有 CodexGateway HTTPS 入口和 PhotoStory 网站地址分别设为仓库变量
   `CODEX_GATEWAY_SERVICE_URL`、`PHOTOSTORY_URL`。将现有 Worker `BATCH_TOKEN`
   的对应值经受限输入设为仓库 Secret `PHOTOSTORY_BATCH_TOKEN`。不要把任何
   凭据写入仓库、命令参数或日志；不要配置 Codex refresh token 或 API key。
4. 部署含 `/internal/inventory` 的新版 Worker，但先不要开启 Actions 定时开关。
   R2 `MEDIA_BUCKET` 绑定必须可用。旧 VPS 处理器在首次库存导入前仍可工作；
   导入后 Worker 要求每次 checkpoint/complete 都带云端库存引用。
5. 在 VPS 的现有受限 PhotoStory 环境内，对已停止写入的
   `/var/lib/photostory` 运行 `python scripts/cloud_inventory.py seed
   --directory /var/lib/photostory`。程序从私有环境读取 `PHOTOSTORY_URL` 和
   `PHOTOSTORY_BATCH_TOKEN`，将 SQLite 一致性快照直接上传 R2，不经 Mac，
   不输出照片数据或凭据。用 `python scripts/cloud_inventory.py status` 回读
   `Cloudflare inventory ready.`；如上传结果不明，先回读状态，不盲目重试 seed。

## 验证与启用

1. 在 `main` 手动运行 `Process PhotoStory` 工作流。它每次只领取一个有限
   扫描或 AI 步骤；首次先用无待处理任务验证入口和 R2，再用手动输入
   `gateway_smoke=true` 发送合成图片，核对 OIDC、CodexGateway 和图片输入。
   随后用小范围真实任务核对 Worker 进度、R2 快照和草稿无重复。
2. 中断恢复要验证：已上传但尚未确认的快照不能推进 Worker 指针；确认完成的
   批次在新运行器上从 R2 恢复；结果不明时停止并核对 Worker `lastBatch`，
   不重复提交模型结果。既有草稿审批与 Instagram 发布设置不因迁移改变。
3. 只有手动运行及恢复验证通过后，将仓库变量
   `PHOTOSTORY_PROCESSOR_ENABLED=true`。定时任务在每小时第 11、41 分钟
   尝试启动；GitHub schedule 可能延迟或漏跑，须关注工作流失败与长期无运行。
   自动发布开始后，同一次运行会连续推进一篇帖子的已记录步骤，最多 20 分钟，
   不依赖下一次定时运行接续。结果不明或队列被待核对发布阻塞时，工作流会失败，
   不会自动重放请求。新帖仍须满足原有审批、发布间隔和北京时间小时设置。
4. 观察至少一次实际定时运行及任务进度回读，再清理 PhotoStory 专属的
   `photostory-batch` / `photostory-ai` / cleanup timer 与安装目录。先保留
   `/var/lib/photostory` 的受限原始副本作为回退依据，不删除共享
   CodexGateway 服务、它的登录或其他仓库使用的配置。

运行器的临时文件不作为库存来源，也不上传 GitHub artifact/cache。R2 保存
压缩后的 SQLite（分页游标、来源和视觉特征）；原图仍在 OneDrive。快照先
写 R2，Worker 在同一 D1 批次内确认库存指针和任务进度；过期的非当前快照
在七天后按限额清理。单份快照限制为 24 MiB；超限时停止并评估库存，不能
静默丢弃旧记录。任何 R2/网关/认证故障均保持失败状态，不能通过重置
库存或重复运行不明结果来“修复”。
