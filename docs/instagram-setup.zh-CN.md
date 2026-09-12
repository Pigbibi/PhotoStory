# Instagram 配置教程

[English](instagram-setup.md)

## 当前版本能做什么

PhotoStory 支持选片、审核、成品下载，并可通过 OAuth 连接 Instagram 专业账号。
**已支持单图和最多 8 张轮播的手动发布。** 批准本身不会发帖，必须先生成成品预览，
再明确点击带目标用户名的发布按钮。ZIP 下载仍可使用。

连接时会核对管理员预设的准确用户名、专业账号类型、应用范围身份及两项必要权限。
令牌仅在服务端加密保存；授权失败不会覆盖已有连接，也不会自动重试。

## 注册开发者账户

1. 打开 [Meta 开发者平台](https://developers.facebook.com/apps/) 并登录。
2. 如果出现注册要求，依次完成「继续 → 账号验证 → 联系信息 → About you」。
   密码和验证码只在 Meta 官方页面填写。
3. 自行阅读并确认适用条款。Facebook 登录成功并不代表开发者注册已经完成。

## 创建应用

以下步骤已于 2026 年 9 月 10 日在 Meta 控制台核对，后续界面名称和要求可能变化。

1. 点击「创建应用」，填写应用名称，例如 `PhotoStory`，以及你自己的常用联系邮箱。
2. 用例选择「内容管理」下的「管理 Instagram 上的消息和内容」。开发者平台使用
   Facebook 登录，并不意味着应选择通用的「Facebook 登录」用例。
3. 没有业务资产组合时，页面可能允许选择「我暂时不想绑定业务资产组合」。这用于
   准备开发应用，不代表已经获得访问任意第三方账户的权限。
4. 查看要求和概览，核对应用名称、邮箱、用例后，自行确认条款并点击「创建应用」。
   如出现密码或安全验证，只在官方页面完成。
5. 进入应用面板中的 Instagram 用例，查看「使用 Instagram 登录的 API 设置」。
   添加账号前先核对该应用的实际要求；初始页面显示「未发现要求」不等于已经通过
   面向公众的权限审核。

## 配置 Instagram 用例

在「定制 → 包含 Instagram 账户关联登录的 API 设置」中，Meta 会生成独立的
Instagram 应用名称（例如 `PhotoStory-IG`）、Instagram 应用编号和应用密钥。
它们与外层 Meta 应用的凭据不同，下面的配置必须使用 Instagram 登录方案对应的凭据。只在向 Cloudflare Secret 保存时读取应用密钥，不需要在控制台额外生成访问令牌。

向导可能提供「Add all required permissions」按钮，其中列出了基础资料、
评论和私信权限。照片发布应用应改为进入「权限和功能」，仅添加
`instagram_business_basic` 和 `instagram_business_content_publish`，不勾选
评论、私信、洞察和广告权限。显示「准备测试」只代表应用权限的配置状态，
不等于账号已经授权，也不代表可以面向公众使用。

添加 Instagram 账号前，控制台要求先进入「应用身份 → 用户身份」，给目标账号
分配「Instagram Tester」身份。填写该账号的准确用户名，并按提示在 Instagram
接受邀请。Meta／Facebook 开发者登录与 Instagram 账号登录是不同的登录过程。

添加用户名后，Meta 的身份表格会显示「待添加」。账号接受邀请后这个状态才会解除。
Meta 提供的邀请管理入口是 [应用和网站](https://www.instagram.com/accounts/manage_access/)。
使用目标 Instagram 账号登录，切换到「测试员邀请」，找到 **PhotoStory-IG**，
阅读测试者声明及 Meta 条款后点击「接受」。如果这个链接在登录跳转时打不开，
先从 [Instagram 首页](https://www.instagram.com/) 登录，再重新打开「应用和网站」；
这一顺序已在内置浏览器实际验证。仍无法登录时，再使用平时的浏览器；
不要向部署人员发送密码或验证码。完成后回到 Meta 身份页面核对「待添加」已解除，
再继续账号授权。不要仅因为邀请尚未接受就移除账号并重复邀请。

向导还分别提供 Webhook 的「回调网址」和「设置 Instagram 业务登录」。Webhook
回调不是 OAuth 登录回调，不要将登录回调地址填进 Webhook 框；PhotoStory 实现了下面的 OAuth 登录回调，
尚未实现 Instagram Webhook。

## 账户与权限

使用的是 **Instagram API with Instagram Login**，适用于 Business 或
Creator 专业账户。基础资料权限为 `instagram_business_basic`，发布权限为
`instagram_business_content_publish`。仅发布风景照时，不应顺带申请私信、评论、
广告或洞察权限。名称相近的 Facebook Login 接入方案使用不同配置，不能混用。
参考 [Meta 官方 Instagram API 文档集合](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api)。

初次测试按应用面板的账号角色／测试员说明添加账号，并在目标 Instagram 账户中
接受邀请。授权完成后，必须核对实际返回的账号身份再启用发布。面向其他用户提供
服务时，可能还需权限审核与业务验证，以应用面板要求为准；开源许可证不会免除这些要求。

## 密钥与开源部署

每个自行部署的用户应创建自己的 Meta 应用。MIT 开源不包括维护者的账号、密钥
或授权。公开示例只能放占位值，不放个人联系邮箱、密码、令牌、Client Secret、
授权码或包含这些内容的截图。

`INSTAGRAM_CLIENT_SECRET` 应放 Cloudflare 加密 Secret。授权令牌使用现有
`TOKEN_ENCRYPTION_KEY` 在服务端加密；不要随意更换这个密钥，它还保护着 OneDrive
已有令牌。不要使用 `VITE_*`、前端代码、浏览器链接、提交到 Git 的 `.env` 或聊天
传递凭据。Meta 的长期令牌接口要求服务端请求携带查询参数，这些请求不会发送到
浏览器，不能写入日志；Worker 禁止跟随跳转，失败信息只返回固定的脱敏提示。

## 配置并连接自己的部署

1. 先部署当前代码，再登记回调。Worker 的普通变量设置：`INSTAGRAM_CLIENT_ID`
   填 **Instagram 应用编号**，`INSTAGRAM_USERNAME` 填准确用户名（不带 `@`），
   `INSTAGRAM_REDIRECT_URI` 填
   `https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/auth/instagram/callback`，
   或自有 HTTPS 域名下的同一路径。公开配置默认留空，表示禁用这个可选功能；
   不支持本机 HTTP 回调。
2. Cloudflare → 对应 Worker → Settings → Variables and Secrets，新增
   `INSTAGRAM_CLIENT_SECRET` 并选择 **Secret**，值使用 Instagram 用例中的
   **Instagram 应用密钥**，不要用外层 Meta 应用密钥。
3. Meta Instagram 用例 →「设置 Instagram 业务登录」，将上述完整地址加入有效
   OAuth 跳转 URI。检查控制台是否自动补了末尾斜杠：地址必须以
   `/auth/instagram/callback` 结尾，不加斜杠，不使用通配符，不填写 Webhook 回调框。
4. 在 PhotoStory 使用允许的 GitHub 管理员账号登录，打开「连接设置 → Instagram
   → 连接 Instagram」，登录目标 Instagram 账号，查看两项权限后授权。
5. 返回网站后会显示核对过的用户名和授权到期时间。用户名不符、个人账号、缺少权限、
   身份不匹配、取消授权或 state 无效都会阻止连接。state 绑定管理员的具体登录
   会话，有效期十分钟且只能用一次；授权途中不要退出 PhotoStory。
6. 长期令牌剩余不足 30 天时自动续期，前提是已生成至少 24 小时且尚未过期。
   复用 VPS 的维护 timer，关闭定期生成草稿也会续期；不需要新密钥、权限或数据库迁移。
   同一连接每天最多尝试一次；失败保留旧令牌并在页面提示，过期或被撤销后需要重新连接。
   页面显示更新后的有效期和上次成功续期时间。并发续期不会覆盖用户新完成的授权。
   令牌始终加密保存在 D1，不记录服务商错误原文或带凭据的 URL。
   规则依据 Meta 的[续期接口](https://developers.facebook.com/documentation/instagram-platform/reference/refresh_access_token)。
   撤销授权请在 Instagram 的「应用和网站」中操作。网站显示的是保存的授权到期时间，
   并非持续探测撤销状态；连接不会启用发布。

实现依据 Meta 的[业务登录文档](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login)
及[账号身份接口](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/get-started)，
账号信息接口使用 Graph API `v26.0`。先用自己已加入应用角色的账号验证，面向其他
用户提供服务仍须满足 Meta 的相应审核要求。

配置期间保持发布关闭。第一次真实发布测试必须明确目标账号，并使用一篇明确批准
的草稿。账号授权、草稿批准和允许发布是三个独立步骤。

### 运行环境排查

如果同意授权后仍连接失败，可检查 D1 中短期保留的私有
`instagram-diagnostic` 记录；不要开启令牌交换请求的原始 URL 日志。
本部署的 Workers 运行环境会在发出请求前拒绝 `redirect: "error"`。
PhotoStory 使用 `redirect: "manual"` 并拒绝所有非成功响应（包括跳转），
不会把凭据转发到跳转目标。


## 部署和使用手动发布

1. 升级 Worker 前，执行 `npx wrangler d1 execute photostory --remote --file worker/schema.sql`。
   使用独立部署配置时附加对应 `--config` 参数。新增的 `publications` 和
   `publication_images` 表不会覆盖既有数据。
2. 测试、构建并部署 Worker。沿用 Instagram OAuth 密钥、D1 和 GitHub 登录限制，
   不需要新增 R2 存储或付费服务。保留现有处理器和维护定时器。
3. 连接目标专业账号，批准草稿，然后点击「生成 Instagram 发布图」。浏览器从核对过
   版本的原图生成与 ZIP 一致的构图。检查实际成品和文案后，点击「发布到 @用户名」。
4. 仅点击发布后才开始请求 Meta，并临时开放成品图链接；原图和微软下载链接不会公开。
   每张为统一比例、1080px 宽 RGB JPEG，无 EXIF/GPS，可保留 ICC 色彩配置。
   单张上限 1.8 MB 是本应用的 D1 存储限制。
5. 发布期间保持页面打开。若在步骤之间关页，可点击「继续发布」接续已记录的进度。
   成功后显示 Instagram 媒体 ID。首次验收仍需查看真实账号；模拟接口测试不代表真实发帖。

开始发布后，禁止修改、移入回收站和重复发布同一草稿。每个外部操作发送前都有持久化
占用记录；超时、崩溃或结果不确定会停止，不自动重试。不要删除记录来重发；应先由
管理员检查 Instagram 和已知容器或媒体 ID，确认真实结果。

成品链接一小时后失效，维护任务清除过期 JPEG，发布记录继续保留以防重发。
此清理独立于草稿回收站设置；未发布的准备图始终私有，也会过期。
定期制作与发布模式独立。默认仍为人工发布；自动发布的部署要求、门槛和停止规则见下文。
Meta 应用角色和权限审核要求仍然适用。

## 可选自动发布

「连接设置 → 发布模式」提供 **人工发布（默认）** 和 **严格 AI 自动发布**。
选择后保存即可，设置通过仅限站点所有者、同源及版本检查的接口写入私有 D1，
重新部署后仍保留。不需要修改源码、把密钥放到 GitHub，也不需要数据库迁移。
旧站点即使已经开启严格 AI 审核，也仍保持人工发布。自动发布必须连接 Instagram，
并同时开启严格 AI 审核；将审核切回人工会关闭自动发布。

只接受开启后新生成并由 AI 批准的草稿。旧草稿、人工批准、编辑过的草稿和留白布局
不进入自动队列。每张至少 9/10，整篇通过独立复核后，VPS 再读取核对过版本的原图，
确认横竖方向一致，按保存的构图生成宽 1080 像素的 JPEG，不放大小图并移除元数据。
另一次 AI 调用检查这批真实成品，服务器核对成品文件摘要后才开始发布。
复核不通过会退回待人工审核。失败或崩溃的准备流程不自动重跑。运行时不需要打开网页。

部署时一并更新 Worker 及 `process_batch.py`、`auto_publish.py`、
`systemd_gateway.py`、`run_isolated_ai.py`，使用原有 Pillow 环境和每分钟一次的
后台定时器。AI 网关单张 JPEG 上限为 1.8 MB，与发布上限一致。发布期间每次后台执行
推进一个已记录的 Meta 步骤，优先于继续扫描。后台必须在线；这不是精确时刻的发帖排程。
定期发现和制作新草稿仍是独立设置。

**滚动 7 天最多启动一次自动发布尝试**，人工发布和准备失败也计入间隔。
外部请求结果不明或中断会停止队列，交给人工核实，不盲目重发。
切回人工会停止后续自动请求，无法撤回已经发给 Meta 的请求。重新开启不会接续旧的
自动尝试；进行中或结果不明的记录需要先核实。接管仍为私有准备状态的草稿时，
切回人工并重新生成发布预览。原有短期成品链接和清理机制保持不变。

开启自动模式即授权系统真实发帖。建议先用自己明确批准的一篇完成手动实测。
AI 仍可能漏判，严格门槛不保证零风险或每张都好看。仓库自动测试不包含真实自动发帖。

低频部署建议每周检查一次最近三个月的照片，每次最多分析 100 张。没有新照片或没有通过严格审核的草稿时不发布、不凑数量；未使用的发布机会不累积。

## 账户验证与发布告警

即使令牌尚未到期，Meta 安全验证也可能暂时阻止 API 使用。发布失败后，系统在私有发布记录中保存时间、步骤、HTTP 状态和 Meta 数字错误码，不保存服务商原始错误文本、令牌或网址。登录网站后会显示持续告警，页面打开期间每分钟刷新。这是站内通知，不是邮件或离站推送。错误码 10、190、200 或 HTTP 401/403 会提示检查授权，但不将其直接认定为某一种 Meta 验证。

请在 Meta 官方页面完成验证并等待访问恢复。受处理器凭据保护的 `GET /internal/instagram-check` 可以只读检查账户，不创建媒体。验证完成不会自动重试发布。

只有尚未拿到首个容器结果的已停止失败、且成品仍完整有效时，所有者才能点击「账户验证后恢复这次发布」。系统重新检查真实账户、审批版本和文件，最多允许恢复一次，并保留原错误记录。后续步骤失败、自动发布、可能已经发布的结果和文件缺失仍保持阻止；不能删除记录来重试。
