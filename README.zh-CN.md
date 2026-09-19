# PhotoStory

[English](README.md)

PhotoStory 是面向单个私人照片工作流的开源自部署选片台。它从 OneDrive 的有限
范围读取照片，生成可编辑草稿，再由所有者决定是否发布。

仓库不包含任何真实照片、账号、令牌、数据库导出或作者的 AI 服务。每位部署者
使用自己的 Cloudflare 资源、OneDrive、VPS 和 AI 运行环境。

![界面设计示意](docs/design-concept.png)

## 能做什么

- 在生成草稿前筛选隐私、人物、构图和风景适宜性。
- 按拍摄时间、粗略区域、画幅和视觉主题分组；区分白天、黄金时刻、蓝调与夜景。
  城市或公共地标只有在画面证据达到高置信度时才会写入文案。
- 生成可编辑的主题、文案、hashtag、裁切构图和轮播顺序。
- 原图始终留在 OneDrive；用于审核的预览已去除 EXIF，且仅向登录管理员提供。
- 支持将已批准草稿手动发布到已连接的 Instagram 专业账号。严格 AI 审核和低频
  自动发布是彼此独立的可选开关；默认始终是人工审核和人工发布。
- 保留发布账本，并提供由所有者确认的历史匹配，避免重复使用同一来源照片。

## 所有权与数据隔离

PhotoStory 是单所有者工作流，不是多租户产品。一个部署实例只有一套私有 D1
数据，草稿、设置、发布记录和选片偏好均由该实例共享。若允许多个 GitHub 账号
登录同一实例，他们就是共同管理员，也会看到和影响同一套数据。

不同部署之间不会交换照片、设置、提示词或偏好。给不同个人、团队或组织使用时，
请分别部署实例、数据库和凭据。

偏好记录是实例内的轻量信号：

- 保存草稿时移除轮播照片，会记录“后续分组要更聚焦同一视觉主题”。
- 严格 AI 审核认为某项软质量不足，但所有者仍批准时，只记录该项聚合质量信号。
- 它们仅影响已经安全的候选排序；不会放宽隐私、地点、批准或发布规则，也不会
  用于训练共享模型。

详细说明见[所有权与偏好](docs/ownership-and-preferences.zh-CN.md)。

## 架构

```text
浏览器 → Cloudflare Worker + D1（可选私有 R2）
                         ↕ 机器凭据接口
                 受信任 VPS 处理器 → 隔离 AI 运行环境
                         ↕
                    OneDrive 与 Instagram
```

Worker 管理登录、OAuth、设置、草稿、审核和发布状态；VPS 处理有限扫描和模型调用。
AI 运行环境拿不到 OneDrive refresh token、Worker Secret 或 Instagram 发布权限。
处理器只接收已去 EXIF 的预览，不会删除 OneDrive 原图。

## 快速部署

需要 Node.js 与 npm、Python 3 与 Pillow、Cloudflare 账号、GitHub OAuth App、支持
个人 Microsoft 账号的 Entra 应用。处理器还需要受信任 Linux VPS 上已认证的 Codex
CLI 或兼容的本地 AIGateway CLI。

```sh
npm ci
python3 -m venv .venv
.venv/bin/pip install -r scripts/requirements.txt
npm test
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
cp wrangler.jsonc wrangler.local.jsonc
npx wrangler d1 create photostory
```

再编辑被 Git 忽略的 `wrangler.local.jsonc`：

1. 为 Worker 和 D1 设置自己的名称。
2. 替换 `REPLACE_WITH_YOUR_D1_DATABASE_ID`。
3. 将 `ALLOWED_GITHUB_USERS` 设为可以管理本站的精确 GitHub 用户名，不能使用通配符。
4. 创建自己 Cloudflare 账号下的 `AUTH_LIMITER` namespace，替换示例 ID。

```sh
npx wrangler d1 execute photostory --remote --file worker/schema.sql --config wrangler.local.jsonc
npm run deploy
```

`npm run preview` 和 `npm run deploy` 只读取本地的 `wrangler.local.jsonc`。公开模板
不会自动指向任何人的 Worker 或数据库。

## 配置登录和存储

通过 Cloudflare 的交互式 Secret 输入配置敏感值。不要把密钥写进命令历史、源码、
前端变量、Issue、截图或聊天。

| 配置 | 存放位置 | 用途 |
| --- | --- | --- |
| `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET` | Worker Secret | 管理员登录 |
| `MICROSOFT_CLIENT_ID`、`MICROSOFT_CLIENT_SECRET` | Worker Secret | OneDrive 授权 |
| `TOKEN_ENCRYPTION_KEY` | Worker Secret | 用于 Microsoft 令牌的 32 字节 base64 AES-GCM 密钥 |
| `BATCH_TOKEN` | Worker Secret | 验证 VPS 处理器 |
| `PHOTOSTORY_BATCH_TOKEN` | VPS 私有环境文件 | 与 Worker 相同的机器凭据 |
| `PHOTOSTORY_URL` | VPS 私有环境文件 | 你的站点地址 |
| `CODEX_GATEWAY_COMMAND` | VPS 私有环境文件 | AI CLI 适配命令 |

在你的 OAuth 应用中登记：

```text
https://你的站点/auth/github/callback
https://你的站点/auth/microsoft/callback
```

GitHub 登录不申请仓库权限。Microsoft 授权申请读取和离线访问，具体文件夹和日期
范围由处理器执行。VPS 与 AI 的完整配置见 [AI 与 VPS 配置](docs/ai-setup.zh-CN.md)。

## 日常流程

1. 使用允许名单中的 GitHub 账号登录并连接 OneDrive。
2. 在网站选择照片目录和有限的拍摄日期范围。
3. 在受信任 VPS 运行处理器；每次只处理一个有限的元数据或 AI 步骤。
4. 检查每篇草稿。修改文案、照片、顺序或构图都会使原批准失效。
5. 批准草稿后，手动模式仍需在最终预览中明确点击发布。导出 ZIP 不会发布。

可选 timer 只会在在线时推进待处理工作，不会自动重试失败或结果不明的外部操作。
详见[制作与保留](docs/lifecycle.zh-CN.md)。

## 安全边界

- 模型输出、图片文字和元数据都是不可信数据，不能当作指令执行。
- 不确定或缺失的筛选结果不会进入草稿。
- 不保存或用于文案的精确 GPS。地点名称需要可见的公共证据或明显公共地标。
- AI 审核可能出错，不是隐私保证，也不会单独授予发布权限。
- Instagram 的外部结果不明时，系统保留记录供人工核对，不会重放可能已成功的请求。

详情见[隐私与运行限制](docs/privacy.md)、[Instagram 配置](docs/instagram-setup.zh-CN.md)
和[发布历史](docs/publication-history.zh-CN.md)。

## 文档

- [AI 与 VPS 配置](docs/ai-setup.zh-CN.md)
- [所有权与偏好](docs/ownership-and-preferences.zh-CN.md)
- [隐私与运行限制](docs/privacy.md)
- [制作与保留](docs/lifecycle.zh-CN.md)
- [Instagram 配置](docs/instagram-setup.zh-CN.md)
- [发布历史与防重复](docs/publication-history.zh-CN.md)
- [私有 R2 存储](docs/storage.zh-CN.md)
- [安全设计与部署检查](docs/security-audit.zh-CN.md)
- [Linux 处理器隔离](deploy/systemd/README.md)

## 验证

部署前运行：

```sh
npm test
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
npm run build
```

这些检查验证仓库行为。OAuth、OneDrive、AI 运行环境与 Instagram 发布仍需在你自己
的部署中进行受控验证。

## 许可证

[MIT](LICENSE)
