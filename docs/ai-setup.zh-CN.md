# AI 配置教程

PhotoStory 的网站、照片读取器和 AI 处理器是三个部分。网站负责登录、授权、
任务和人工审核；读取器从 OneDrive 获取指定范围的预览图；AI 负责筛选、分组
和英文文案。开源仓库不附带作者的服务、账号、密钥或私人照片。

## 选择模式

| 模式 | 适合谁 | 需要什么 | 当前状态 |
| --- | --- | --- | --- |
| `codex-cli` | 从零部署、已有可用 Codex 账号 | Linux VPS、官方 Codex CLI、一次账号登录 | 已实现，默认模式 |
| `aigateway-cli` | 已有兼容 AIGateway 的部署者 | 本机网关、已有 Codex 认证、兼容 CLI 接口 | 已实现；作者部署使用这条路径 |
| 视觉 API | 喜欢按量付费、希望直接调用模型的部署者 | 视觉模型 API Key、预算和服务数据政策确认 | 尚未实现；不是可用开关，不会自动收费 |

Codex CLI 模式不需要 AIGateway，也不需要访问任何私有仓库。Codex 订阅与
API 按量费用不是同一套计费；已有订阅不代表附送 API 额度。两种已实现模式
不会在失败时切换到付费 API。选择模式本身不会替你登录或开通服务。

## 1. 网站与 OneDrive

先完成 [项目部署教程](../README.md)：创建 Cloudflare Worker 和 D1，设置
GitHub OAuth、管理员白名单，注册个人 Microsoft 应用。OAuth 回调分别是：

```text
https://YOUR-SITE/auth/github/callback
https://YOUR-SITE/auth/microsoft/callback
```

GitHub 登录只读取公开身份，不申请仓库权限。Microsoft 只申请 `Files.Read`
和 `offline_access`，但这个授权覆盖范围大于指定照片目录；目录限制由读取器
执行。登录管理网站后再连接 OneDrive，填写相对根目录路径和拍摄日期。

## 2. 安装隔离处理器

按 [Linux 双账户部署步骤](../deploy/systemd/README.md) 安装服务。
读取器和模型使用不同 Linux 账户。模型不能接触 OneDrive 的访问令牌、
Cloudflare 机器密钥、其他项目目录。仅指定网关代码可读取，不继承网关的
整套环境变量。不要为了部署而关闭 VPS 已有的 AppArmor 或服务防护。

默认模式在 `photostory-ai.service` 中设置：

```ini
Environment=PHOTOSTORY_AI_MODE=codex-cli
```

使用官方安装说明安装 Codex CLI，并核对实际版本支持
`runtime/bin/codex` 中的限制参数。然后在专用的 `photostory-ai` 账户下登录，
设置 `HOME=/var/lib/photostory-ai`、`CODEX_HOME=/var/lib/photostory-ai/codex`。
登录由账号本人完成，密码或验证码不应提交到管理网站或聊天中。

如果已有 AIGateway，把模式改为：

```ini
Environment=PHOTOSTORY_AI_MODE=aigateway-cli
Environment=PHOTOSTORY_CODEX_MODEL=YOUR_AVAILABLE_VISION_MODEL
```

模型必须是当前账号可用且支持图片的型号；不要照抄旧网关的默认模型。
API 价格页列出的模型不一定可用于 Codex 订阅。

网关应安装在 `/opt/codex-gateway`。PhotoStory 调用
`bin/codex-gateway`，要求支持 `--prompt-file`、`--image`、`--output-schema`、
`--out`、`--providers codex`、`--sandbox read-only`、`--ask-for-approval never`、
`--cwd` 和超时参数。模型调用仍在隔离服务中运行，原有共享网关服务不需要重启。

已有网关的登录不会自动跨 Linux 账户生效。部署者可以为专用账户登录，或由
服务器管理员配置受限的凭据传递。不得直接复制一份会自行刷新的 OAuth
refresh token 给第二个进程，否则可能影响原服务的登录。复用现有登录的
具体接入必须根据该服务的凭据管理方式验证；配置成功不等于已跑通看图。

仓库已提供受限复用方式：管理员在私有 systemd 配置中使用 `LoadCredential`
指定现有 Codex 登录文件。处理器每次只给 Codex 客户端创建短期访问凭据副本，
不复制可刷新的 refresh token 到该副本、不改写原文件，运行结束后删除。
凭据至少还需有效 650 秒；续期仍由原服务负责。详细配置见双账户部署说明。

网关 HTTP 接口、OpenAI 兼容 API 和这里的 CLI 接口不同，不可仅修改 URL
就视作兼容。特别是 GitHub Actions OIDC 接口，应保留仓库、工作流和分支
白名单，不能把鉴权关闭来接入网站。

## 3. 密钥放哪里

| 配置 | 存储位置 | 浏览器或仓库能否包含实际值 |
| --- | --- | --- |
| GitHub / Microsoft Client Secret | Cloudflare Worker Secrets | 不能 |
| `TOKEN_ENCRYPTION_KEY` | Worker Secrets，独立随机 32 字节密钥 | 不能；已有授权后不要随意替换 |
| `BATCH_TOKEN` | Worker Secret | 不能 |
| 同值的 `PHOTOSTORY_BATCH_TOKEN` | VPS `/etc/photostory/processor.env`，root 所有，0600 | 不能 |
| Codex 认证 | 专用受限账户或经验证的现有服务凭据管理 | 不能 |
| `PHOTOSTORY_URL`、运行模式 | 部署配置 | 可公开；不要混入私人目录或账号资料 |

使用平台的 Secret 输入和服务器受限文件配置，不要把密钥放在命令参数、
前端环境变量、构建产物、GitHub Actions 日志或截图中。公开项目可分发
配置名和示例占位符，不能分发作者的真实配置。

## 4. 跑第一个任务

1. 验证两个账户的文件权限、AI 输入只读、读取器密钥不可见，以及 Codex 参数兼容性。
2. 不创建任务时启动一次 `photostory-batch.service`，应提示 `No pending job.`，证明机器连接正常，不会调用 AI。
3. 选择最近一个月、三个月、六个月、一年、全部或自定义日期；自定义结束日期包含当天。每批可选 20、50 或 100 张。可选填国家或地区作为地点备注。
4. 安装并启用 `photostory-batch.timer` 后，处理器会自动衔接任务。先分页扫描目录，再按连续时间、粗略地点和画面主题分批选片。网站显示进度，并可停止后续批次。
5. 人工确认每张照片的隐私和内容。首版没有 Instagram 发布功能；审核通过也不会对外发送。

首例验证后可在设置页启用每周／每月制作，设置每次分析额度和待审核暂停阈值。
定期制作默认关闭。回收站、30 天保留、临时残留清理与升级步骤见[制作与保留规则](lifecycle.zh-CN.md)。

任务仍在“等待处理器”，通常表示服务还没运行。出现“处理失败”时查看脱敏
状态并核对配置，不要盲目重试；完成请求结果不明时先读取网站状态。没有
新增照片、全部照片被保守排除等情况也可能合法地产生零条草稿。

## 5. 成本与 API 选择

视觉 API 适合本任务，费用由图片输入、提示词、输出及所选模型共同决定。
先压缩预览、限制照片数量、筛选后只对少量入选图片分组，可以控制开销。
但压缩可能隐藏敏感细节，不能为了省钱把不确定结果当成安全。

截至 2026-09-10，官方 GPT-5.4 mini 标价为每百万输入 token **$0.75**、
每百万输出 token **$4.50**，支持图片输入。
[官方模型与价格](https://developers.openai.com/api/docs/models/gpt-5.4-mini)

举例：假设某批照片的全部调用实际累计 100,000 输入 token、20,000 输出 token，
则标准费用约为 **$0.165**。这是用量假设下的算术示例，不是“100 张照片固定
这个价格”；图片大小、重看次数、推理输出与供应商都会影响账单。

未来 API 模式应要求用户显式选择服务、模型和预算，密钥只在服务器保存，
限制输出与调用次数，并在结果不明时停止，不能自动换更贵的模型或重试收费。
当前发布没有 API 调用实现，也不会把 Codex 失败转换成付费请求。

## 大范围任务与升级

“全部”指所选文件夹内所有满足筛选规则的照片，不包括视频、截图、远程快捷
方式以及无明确拍摄时间的文件。全部范围不是一次把所有照片送给模型；每步
扫描最多 50 页目录，或分析至多一批照片。地点不足时按画面描述，不推断精确
地名。相邻时间的大量照片可能分成多批和多条草稿，不强行凑成一条帖子。

VPS 的 `PHOTOSTORY_STATE_DIR` 必须是绝对路径、归读取器所有且仅其可访问。
不要将它放进 Git 仓库或 AI 可读目录。里面保存扫描进度、候选元数据以及已
处理版本的哈希（含被排除照片）；没有原图或文案。升级时保留它，避免重复
分析。任务完成不自动清除此元数据；清理缓存后将失去跨任务去重记录。

升级时先确认没有正在处理的任务，再一起更新 Worker、前端、读取器和服务
配置。旧页面缺少范围参数时会被拒绝，刷新页面后再提交；不会静默扩大日期
范围。旧版失败任务保留在历史记录，新版任务使用新的分批流程。
