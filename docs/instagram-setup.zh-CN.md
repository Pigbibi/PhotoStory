# Instagram 配置教程

[English](instagram-setup.md)

## 当前版本能做什么

PhotoStory 支持选片、审核、成品下载，并可通过 OAuth 连接 Instagram 专业账号。
**尚未实现 Instagram 发布**。人工审核和严格 AI 审核都只处理草稿，不会发帖。
可以下载已批准草稿的 ZIP，再用 Instagram 手机应用上传 JPEG 和文案。

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
6. 当前版本会获取长期令牌，但尚未自动续期。到期前使用「重新连接 Instagram」。
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
