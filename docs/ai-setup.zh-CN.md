# AI 与 VPS 配置

PhotoStory 将网站、照片读取器和 AI 运行环境分开部署。网站管理登录、授权、任务与
人工审核；读取器从 OneDrive 取得有限范围的预览；AI 只负责筛选、分组、文案和可选
严格复核。公开仓库不提供任何人的账号、密钥、照片或网关。

## 支持的运行模式

| 模式 | 适合场景 | 部署要求 |
| --- | --- | --- |
| `codex-cli` | 使用已认证 Codex CLI 的独立部署 | Linux VPS、专用 Linux 账户、官方 CLI |
| `aigateway-cli` | 已有兼容本地网关 | 受限网关、已有 Codex 认证、兼容 CLI 契约 |

两种模式都只使用你自己的账号和运行环境。失败不会切换到付费 API，也不会自行开通
新服务。任何 API 接入都需要由部署者单独实现、配置预算并评估该服务的数据政策。

## 1. 先部署 Worker 与 OneDrive 授权

按 [README](../README.zh-CN.md) 创建 Cloudflare Worker 和 D1，配置 GitHub OAuth、
管理员允许名单和 Microsoft Entra 应用。回调地址为：

```text
https://你的站点/auth/github/callback
https://你的站点/auth/microsoft/callback
```

GitHub 只用于身份确认，不申请仓库权限。Microsoft 使用 `Files.Read` 和
`offline_access`；授权本身不是文件夹级权限，照片目录和日期范围由读取器执行。

## 2. 安装隔离处理器

使用[双账户 systemd 部署](../deploy/systemd/README.md)。读取器和 AI 使用不同的
Linux 账户。AI 账户不能读取 OneDrive token、Cloudflare 机器凭据、Instagram 凭据或
其他项目目录。不要为了接入模型关闭 AppArmor、systemd sandbox 或已有网关鉴权。

默认模式在 `photostory-ai.service` 中设置：

```ini
Environment=PHOTOSTORY_AI_MODE=codex-cli
```

在 `photostory-ai` 专用账户下完成 Codex 登录。登录由账号本人在官方入口完成；密码、
验证码和 refresh token 不应进入网站、聊天、日志或仓库。

若使用兼容 AIGateway：

```ini
Environment=PHOTOSTORY_AI_MODE=aigateway-cli
Environment=PHOTOSTORY_CODEX_MODEL=YOUR_AVAILABLE_VISION_MODEL
```

PhotoStory 调用的 CLI 需要支持 `--prompt-file`、重复的 `--image`、
`--output-schema`、`--out`、`--providers codex`、`--sandbox read-only`、
`--ask-for-approval never`、`--cwd` 和超时参数。HTTP API 与该 CLI 契约不是一回事，
不能只替换 URL 就当作兼容。

## 3. 配置私有环境

| 配置 | 保存位置 | 说明 |
| --- | --- | --- |
| GitHub / Microsoft Client Secret | Cloudflare Worker Secret | 不进入浏览器或仓库 |
| `TOKEN_ENCRYPTION_KEY` | Worker Secret | 独立随机 32 字节密钥，base64 编码 |
| `BATCH_TOKEN` | Worker Secret | 仅 Worker 与处理器使用 |
| `PHOTOSTORY_BATCH_TOKEN` | `/etc/photostory/processor.env`，root 0600 | 与 `BATCH_TOKEN` 相同 |
| Codex 认证 | 专用受限账户或已验证的受限凭据机制 | 不能复制到读取器或浏览器 |
| `PHOTOSTORY_URL`、运行模式 | 私有部署配置 | 不含密钥，但不能混入私人目录资料 |

`PHOTOSTORY_STATE_DIR` 必须是读取器专属的绝对私有路径，不得位于 Git 仓库或 AI
账户可读取位置。它保存分页游标、候选来源、版本哈希和视觉特征，不保存原图字节或
令牌。保留它能避免重复分析；删除它会丢失续跑和去重信息。

## 4. 验证第一个任务

1. 核对两个 Linux 账户的文件权限，并确认 AI 输入只读、读取器密钥不可见。
2. 没有待处理任务时启动一次 `photostory-batch.service`，应安全地报告无任务，且不调用 AI。
3. 在网站选择少量照片和明确日期范围，创建任务。
4. 处理器先有限扫描元数据，再按时间、粗略区域、画幅和视觉主题处理预览。它会区分
   白天、黄金时刻、蓝调、夜景以及主场景；地点名称必须有可见公共证据。
5. 审核每篇草稿的照片、地点、光线、文案和裁切。批准不等于发布；手动模式还需最终
   发布确认。

timer 只会推进待处理的有限步骤。任务失败或外部结果不明时，它不会自动重试；先读取
私有状态和脱敏错误阶段，再决定是否恢复。定期制作默认关闭，可在站点中显式开启。

## 5. 用量与质量边界

AI 用量取决于图片尺寸、实际输入、输出、模型和你的服务计划。控制范围的方法是选择
较小日期区间、限制每次分析量、保留待审核上限，并在启用任何外部 API 前设定自己的
预算。不要为了降低成本把不确定照片当作安全照片。

处理器的相似连拍预筛使用感知哈希、比例、颜色和对比度，只是节省复核工作量的启发式
规则。AI 仍可能误判重复、构图、地点或审美。所有隐私与发布决定都必须由你复核。

## 6. 维护与升级

更新时让正在处理的步骤自然结束，再一起更新 Worker、前端、Python 脚本和 systemd
文件。不要清空 D1、VPS 状态目录、草稿或发布记录来“重新开始”。升级后先运行测试，
再用小范围任务验证连接和人工审核。

发布历史的只读验证、R2 存储和保留规则分别见
[发布历史](publication-history.zh-CN.md)、[存储](storage.zh-CN.md) 和
[制作与保留](lifecycle.zh-CN.md)。
