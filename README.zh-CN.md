# PhotoStory

Pigbibi 的开源旅行照片编辑台，采用 [MIT 协议](LICENSE)。

从 OneDrive 手机备份中筛选风景照，整理主题，生成英文文案和 hashtag，
然后在私人管理网站上逐篇审核。代码可公开，照片、草稿和密钥不公开。

**当前 v0.1 只做选片与审核，没有 Instagram 发布功能，也不会自动发帖。**
公共演示使用 AI 生成的海岸图，不是用户的真实照片。

## 日常使用

1. 使用允许名单中的 GitHub 账号登录。
2. 在「连接设置」中完成 Microsoft 官方授权，只申请读取权限。
3. 选择照片文件夹、起止日期，创建选片任务。会遍历年月子目录。
4. 已配置的 VPS 处理器运行一次：读取预览、排除敏感内容、筛选风景、生成草稿。
5. 查看每张照片，修改英文文案和 hashtag，调整顺序或移除照片。
6. 保存后批准，草稿进入队列。修改已批准的内容会使批准失效，重新待审。

目前每次处理器运行只处理一个任务，没有自动安装定时任务。后续在真实
照片效果验证后，再配置定期选片与 Instagram 发布。

## AI 能筛选到什么程度

先判断隐私和公开适宜性，再判断清晰度、光线、构图，最后组织主题。
默认排除截图、证件、票据、可识别人物、儿童、裸露内容、私人房间、个人信息
以及任何不确定内容。程序只接收明确允许、没有敏感标记的风景候选。

**模型可能漏判，不是隐私安全保证。** 为了筛选，预览图本身需要发送到你配置
的 Codex 路径；即使最终被排除，也可能已经被 AI 处理。请只授权你愿意让
该服务处理的照片范围。所有草稿仍需要你逐张复核。

照片按明确的拍摄时间筛选，不把上传时间冒充拍摄时间。没有有效拍摄时间的
照片会跳过。时区为 Asia/Shanghai，结束日期不包含当天。首批最多 100 张；
超过预算会整批停止，需要缩小范围，不会悄悄宣称已经分析完整个月。

## 部署与授权

完整命令和各项配置见 [英文部署说明](README.md#deploy-your-own)。

| 位置 | 配置 | 用途 |
|---|---|---|
| Cloudflare | Worker + D1 | 网站、私人草稿、审核状态 |
| Worker 设置 | `ALLOWED_GITHUB_USERS` | 精确允许登录的 GitHub 用户名 |
| Worker Secret | `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET` | 新网站独立的 GitHub OAuth App |
| Worker Secret | `MICROSOFT_CLIENT_ID`、`MICROSOFT_CLIENT_SECRET` | 支持个人账户的 Microsoft Web 应用 |
| Worker Secret | `TOKEN_ENCRYPTION_KEY` | 32 字节随机密钥的 base64，用于加密 Microsoft 令牌 |
| Worker Secret / VPS | `BATCH_TOKEN` / `PHOTOSTORY_BATCH_TOKEN` | 独立的后台处理器凭据，两端相同 |
| VPS 环境 | `PHOTOSTORY_URL` | 你自己的站点地址 |
| VPS 环境 | `CODEX_GATEWAY_COMMAND` | 你自己的 AIGateway 命令绝对路径 |

GitHub 回调地址：`https://你的站点/auth/github/callback`。

Microsoft 回调地址：`https://你的站点/auth/microsoft/callback`。

密钥通过 Cloudflare 的加密 Secret 输入或受限环境文件配置，**不要放进聊天、
GitHub、网页输入框或日志**。浏览器只负责官方授权跳转，不持有后端密钥。
不要直接复用发票网站的 OAuth 凭据或回调配置。

`Files.Read` 是账户级只读权限，文件夹限制由应用执行。原始照片不会被修改
或删除。真实预览和草稿保存在私人 D1 数据库中，当前没有自动过期清理。

开源使用者需要自己的 AIGateway 和 Codex 登录环境；本项目不提供访问
Pigbibi 私有网关的权限。不自动切换 Gemini、付费 API 或其他服务。

## 验证边界

自动测试覆盖访问控制、OAuth 状态校验、令牌加密、审核版本冲突、敏感标记
拒绝、陌生照片编号拒绝等。浏览器演示和本地数据库检查不能代替真实 OAuth、
OneDrive 读取、VPS 看图或 Instagram 发布验证。

更多细节见 [隐私说明](docs/privacy.md)。

Linux VPS 可使用[双账户隔离部署说明](deploy/systemd/README.md)，将 OneDrive 读取凭据与 AI 进程分开。

AI 模式、从零配置、复用已有服务与 API 成本说明：[完整教程](docs/ai-setup.zh-CN.md)。
