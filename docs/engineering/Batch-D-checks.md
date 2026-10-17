# 批次 D 检查记录

日期：2026-10-17。**D 已按部署与基本运行范围完成，E 尚未开始。** 前后端、账号与四站辅助路径、真实更新重启持久化、唯一一次合成音频 ASR、备份私密下载及隔离恢复已检查。本文件不代表真人语音、设备兼容、教学质量或最终产品验收。

## 已实现

- Vercel Vite 前端与 Node `/api` 代理配置；Render Python 单实例、Virginia、付费持久磁盘配置。初期手动部署选定提交。
- 生产启动必填配置校验，Secure／HttpOnly／SameSite Cookie，精确 Origin 白名单，代理密钥与可信 IP 验证；未认证直连 API 拒绝，健康检查可公开读取。
- `build:deployment` 保留教材待审状态，检查 4 套清单、82 条音频绑定、64 个独立 WAV，并生成版本清单；正式 `build:release` 门槛保留。
- SQLite 在线一致性备份、完整性与外键检查、仅恢复到新路径；启动前备份和专用自动备份最近 3 份保留，不删除手动备份。首次启动初始化空库。
- 每日同盘备份和空闲游客清理已上线；首个维护周期与更新启动前快照成功，健康检查不触发清理。
- [部署操作](Deployment.md)、[数据库维护](Database-maintenance.md) 与环境变量模板。

## 本地验证

| 范围 | 结果与边界 |
| --- | --- |
| 待验收构建 | 首轮类型检查、49 项既有内容测试、11 项新增部署内容测试、Vite 构建与输出音频哈希检查通过；64 个独立 WAV 完整。追加云端来源元数据修正后，部署内容测试共 12 项通过；11 与 12 为先后两轮，不相加 |
| 前端回归 | 170 项通过，涵盖既有固定问题、结果停留、辅助继续、身份绑定、Review 与音频行为 |
| 后端 | 首轮完整回归 473 项通过；追加数据库故障回归后，生产专项 35 项全部通过。两组存在重叠，不相加 |
| API 代理 | 15 项通过，含临时本机 HTTP 上游的 WAV／JSON 原始字节、多 Cookie、会话头、伪造头、Origin、路径、重定向、大小限制、超时与取消；不等同真实 Vercel 路由 |
| 数据维护与启动 | 9 项备份／恢复测试与 5 项启动测试通过，全部使用临时数据库；覆盖 WAL、损坏库、拒绝覆盖、配置优先检查、备份失败中止与仅自动备份轮转 |
| 每日维护追加 | 新增 9 项测试、相关检查 92 项通过，两次独立审查均未发现阻断；已部署，实际运行证据见下节。相关检查范围有重叠，不与上列累计 |
| 生产启动／重启 | 实际启动生产脚本两次，使用临时源码副本、空库、合成代理密钥和禁用语音的环境；健康、拒绝直连、注册／登录／退出、大小写重名拒绝通过 |
| 持久恢复 | 上述本机进程重启后，账号 ID、英文界面与隐藏注音偏好恢复；生成一份自动备份且完整性／外键检查通过。本行仅为本机证据，另有下节真实 Render 重启核验 |
| Cookie | 生产模式返回 Secure／HttpOnly／SameSite=strict。本机 HTTP 冒烟手动转交 Cookie；实际 HTTPS 登录／刷新／退出重登另见下节 |
| 独立审查 | 未发现新的明确阻断；普通 Node rewrite 的原路径和 fetch handler 已对照 Vercel 官方资料，并完成下述上线实测 |

以上检查未调用 ASR／TTS，生产启动冒烟未读取真实 `.env` 或本地用户库；测试进程、临时库均已清理。现有主 JS 677.43 kB 体积提示仍在，未在本次改变产品 UI 或音频内容。

## 实际平台与线上检查

- Vercel 和 Render 控制台均已登录；两平台均能读取个人 fork。Render 全仓库授权由用户明确确认，并由用户完成 GitHub 再验证。
- Vercel 生产网址为 [A little Shanghai](https://spec-virtual-shanghainese-learning.vercel.app)，部署 `GhTdMgq48GeChMw7i7Gdna9sqpKa` 为 Ready；Render 部署 `dep-db9vq2lg1s2s73a7ok80` 为 Live。两端当前应用源码均为 `da96ca8883d1d5b2aab626f5eb6f60ab1bafe93f`，合作仓库与 fork 按约定同步。
- 线上 `/deployment.json` 返回 200，提交为上述版本、`provider: vercel`、`dirty: null`、`reviewStatus: pending`。云端来源元数据修正已发布并核验，教材仍待审。
- 公开 `/api/health` 返回 200、`production`，前端 `/api/auth` 返回 200、`signed_out`；未经代理认证的 Render 直连 `/api/auth` 返回 403、`proxy_required`。错误 Origin 的 POST 返回 403、`cross_origin_denied`。
- 用户已解决 Chrome 扩展文件访问限制；Vercel 代理密钥已导入并限定 Production，Render 创建表单已导入 13 项环境变量。私有配置存于 Git 忽略目录，未在日志或文档中显示密钥。
- Render 服务 `srv-db9vmreq1p3s739p3p30` 使用用户授权的 Virginia、0.5 CPU／512 MB、1 GB 磁盘，基础费用为计算 US$7／月与磁盘 US$0.25／月，合计 US$7.25／月，税费与超额用量另计；未升级、加购或购买自定义域名。后端网址为 [a-little-shanghai-api](https://a-little-shanghai-api.onrender.com)。

| 线上检查 | 结果与边界 |
| --- | --- |
| API 基线 | 36 项通过；记录在 Git 忽略的 `private/deployment/online-smoke-baseline-20261017T225126-3710.json`。使用隔离测试身份，验证注册承接、同名拒绝、跨账号隔离、受保护音频、登录合并、退出及重新登录；API 基线没有模型请求 |
| 四站基本流程 | 上述基线以明确模拟客户端技术回退的方式，辅助完成四站并保存；不是四站真实识别或语音正确证明 |
| 实际浏览器 | Chrome 中文游客入口默认 About、中英地图切换、进入南翔及常／慢速按钮的 `host-speaking` 状态通过。独立 UI 测试账号注册、刷新保持、退出重登后默认 About、Review 显示南翔进行中与其余三站未开始均通过；收尾已退出测试账号，网站保留登录入口。未做麦克风录音或硬件音频听审 |
| 静态声音 | 线上 E08 WAV 的 SHA256 与已有教学资产一致；没有重新生成音频或增加 TTS 调用 |
| 唯一一次真实 ASR | 额外获准的 E08 合成 WAV（1.6 秒、24 kHz、单声道）通过线上代理发送至北京 `qwen3-asr-flash`；返回原转写「我要两份小笼馒头。」、`elapsed_ms:1962`、配置 `asr-4c784f1651e2840a`。目标匹配正确，原转写停留在商品题，未自动推进 |
| 请求与费用边界 | 实际发出 1 次 ASR，无麦克风、无重试、无新增 LLM／TTS。首次执行因本地文件路径错误在发送前退出，发出 0 次请求；修正后仅发出唯一一次。授权费用上限 ¥1，实际账单未核对；单次授权已用完 |
| 真实更新重启持久化 | 发布 `da96ca8` 后，`--verify-persistence` 的 5 项检查通过；原账号会话、四站完成状态、5 次尝试与偏好保持一致。私有报告为 `private/deployment/online-smoke-verify_persistence-20261017T225747-1885.json`，没有新增模型请求 |
| 线上自动维护 | 更新启动前生成 `/var/data/backups/auto-prestart-20261017T225647295404Z.db`；日志记录 `maintenance_cleanup_succeeded removed=0` 与 `maintenance_backup_succeeded`，证明首个维护周期成功。没有过期记录时删除 0 条符合预期，不冒充实际删除验证 |
| 线上一致性备份 | Render Shell 生成 `/var/data/backups/dcheck-20261017T2253.db`，经 SSH 下载至本机 `private/deployment/dcheck-20261017T2253.db`；两端 SHA256 同为 `92482d727ef23a2fd201ec524b5067831a816786fd3f419c70a6f0e3f87ad8e6` |
| 隔离恢复 | 将下载备份恢复到独立本机文件，使用 `git archive e3beb7d` 的匹配源码完成 11 项检查，包括原账号登录、四站与 5 次尝试、设置写入及重新登录；0 网络、0 模型。报告为 `private/deployment/offline-restore-check.json`。未覆盖生产库，也未执行生产原地回退 |

上述 ASR 只证明合成教学音频的线上接通与目标核对，不计入 E 的真人语音、上海话识别质量或教学声音评估。详细真实调用记录见 [语音接入](Speech-integration.md#批次-d线上-e08-合成音频接通检查)。

上述备份和报告保存在 Git 忽略的私有目录。临时 SSH 公钥已从 Render 删除，控制台显示 `No authorized SSH keys`；本机临时私钥也已移除。没有把备份、认证信息或私钥加入 Git。

## 交付边界与后续维护

- 每日同盘备份和空闲游客清理已上线；本次已有人工下载的私密异地副本，自动异地传输尚未配置。按 [维护指引](Database-maintenance.md) 持续人工转存，同盘备份不能替代磁盘外副本。
- 隔离恢复验证没有覆盖生产库，不是生产原地回退演练；正式回退应按部署／维护指引停服并保留原库。
- E 尚未开始。浏览器麦克风、硬件音频、真人语音、实体设备兼容与模型效果仍待 E 验证，不用合成样本或播放状态代替；教材审核也保持 pending。
- 取消代理请求不证明已经停止供应商推理或计费；系统不以此作费用保证。

各轮测试范围与来源分别记录，不将本地、线上、合成语音或恢复检查累计为统一质量评分。D 的部署基本范围已完成，以上局限继续保留到维护与 E 的相应工作中。
