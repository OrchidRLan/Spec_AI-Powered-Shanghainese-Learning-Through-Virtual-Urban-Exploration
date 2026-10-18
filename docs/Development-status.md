# 开发进度与下一步

更新日期：2026-10-18。当前行为见 [产品规格](Product-spec.md)，后续阶段见 [D/E 计划](Batch-DE-plan.md)，全部文档见 [文档入口](README.md)。

## 当前状态

**批次 D 已按部署与基本运行范围完成，追加的全自动发布已启用并完成首轮验证，E 尚未开始。** 网站为 [A little Shanghai](https://spec-virtual-shanghainese-learning.vercel.app)，后端为 [a-little-shanghai-api](https://a-little-shanghai-api.onrender.com)。原 D 验收版本为 `da96ca8883d1d5b2aab626f5eb6f60ab1bafe93f`；2026-10-18 首次自动发布验收版本为 `bb68e962d0cfc85bdf815a77980ee16f0507d0b0`，两端部署及稳定网址核验通过。后续提交会继续触发发布，最新前端版本以 [线上版本清单](https://spec-virtual-shanghainese-learning.vercel.app/deployment.json) 为准，发布记录见 [fork Actions](https://github.com/hollis-yang/Spec-Virtual-Shanghainese-Learning/actions/workflows/deploy-production.yml)。教材仍为 `reviewStatus: pending`。

四站功能、批次 2 的三轮修改和密码／用户名主键调整均已实现；批次 A 修订 4 已获用户体验通过，B+C 及后续修改尚无整体体验通过结论。教学文字、注音和声音仍待真实审核，部署成功不代表教材或最终产品通过。部署前已整理当前规格、历史归档和英文 README，检查通过 52 份 Markdown 的 550 个本地链接、43 处教学来源路径、171 个资源哈希及内容校验。

部署使用个人 fork `main`，合作仓库与 fork 按约定同步；线上从空库初始化，未导入本地账号或进度。Render 使用用户授权的 Virginia、0.5 CPU／512 MB、1 GB 持久磁盘，基础 US$7.25／月，税费与超额用量另计；没有升级或加购。密钥只配置在服务端。详见 [部署指南](engineering/Deployment.md) 和 [D 检查记录](engineering/Batch-D-checks.md)。

2026-10-18 全自动发布已启用：合作仓库 `main` 更新后自动检查、同步 fork、先部署后端并核验，再部署前端，无需逐次点击发布。三个 GitHub Actions 工作流及配套脚本通过 60 项模拟自动化测试和 actionlint；真实源仓库 push、检查与同步、自动发布事件及顺序部署已验证。首次平台凭证预检失败在部署前停止，修正后重跑部署任务成功，详细记录见下文及 [自动部署说明](engineering/Automatic-deployment.md)。原 D 部署与检查证据继续有效，E 尚未开始。

线上基线 36 项通过，涵盖账号／游客、数据隔离、受保护音频与四站辅助完成；四站明确模拟客户端技术回退，没有语音正确结论。真实 Render 更新重启后的 5 项持久化检查通过，原账号会话、四站、5 次尝试和偏好保持一致。Chrome 实际注册、刷新保持、退出重登、默认 About 及 Review 状态通过；中英地图、南翔与常／慢速播放状态已核验，静态 E08 哈希匹配，错误 Origin 被拒绝。

获准的唯一一次 E08 合成音频 ASR 返回「我要两份小笼馒头。」、服务耗时 1,962 ms；目标正确且停留在商品题，未自动推进。不使用麦克风、无重试，授权上限 ¥1，实际账单未核对，单次授权已用完。真人语音、硬件声音与模型效果留给 E，详见 [语音记录](engineering/Speech-integration.md)。

启动前备份、每日同盘备份和空闲游客清理已上线，首次维护周期成功。线上一致性备份已私密下载并核验相同 SHA256，恢复至独立本机文件后通过 11 项离线检查；未覆盖生产库，也不是生产原地回退演练。临时 SSH 公钥和本机私钥均已移除。自动异地传输尚未配置，本次已有人工私密异地副本，后续按 [维护指引](engineering/Database-maintenance.md) 持续转存。

## 已交付与证据

开发流程补充（2026-10-17）：按用户确认，将个人 fork 同步纳入每次 agent 推送合作仓库后的收尾。`npm run git:publish` 先发布并核验合作仓库 `main`，再将同一提交同步至 `hollis-yang/Spec-Virtual-Shanghainese-Learning` 的 `main`，最后核验双方提交一致；保留原 `origin`，不自动合并或强制覆盖独立提交。规则见 [AGENTS 第 8 节](../AGENTS.md#8-里程碑完成后自动提交与推送)，实现见 [同步脚本](../scripts/push-and-sync.mjs)。7 项临时本地 Git 仓库测试通过，覆盖成功／重试、主仓库拒绝、fork 分叉或领先、未提交修改、错误目标及其他分支；语法与差异检查通过。此项仅调整开发收尾，未实施部署或改动应用功能，最终实际同步结果以 Git 远端核验为准。

全自动发布补充（2026-10-18，已启用）：保留上述本地发布入口，新增合作仓库事件驱动的检查与同步，以及 fork 内串行的 Render → Vercel 发布。PR 只检查，fork 直接推送不独立发布；平台各自的 Git 自动部署保持关闭，由工作流控制顺序。同步拒绝分叉和强推，发布核验两仓库当前完整 SHA，过期排队版本跳过，进行中的发布不被新提交取消；部署请求不盲目重试，不自动恢复数据库。同一 SHA 的显式重跑可能再次部署两端。

用户已批准凭证配置。细粒度 GitHub 凭证 `Shanghai automatic fork sync` 已建立并保存为合作仓库 Actions secret `FORK_SYNC_TOKEN`，到期日为 **2027-01-16**；仅授权目标 fork 的 Contents／Workflows 读写及必要 Metadata 读取。Render 账号级 API Key 和 Vercel 单项目令牌已保存到 fork 的 `production` 环境 Secrets；Vercel 令牌同样于 2027-01-16 到期。真实项目／工作区 ID 已保存为 fork Actions variables。`production` 仅允许 `main`，无 required reviewers 或 wait timer，fork Actions 已实际运行。令牌值不写入文档、Git 或日志；生产语音和代理密钥不复制到 CI。

首次真实验收：合作仓库 push run [39139814837](https://github.com/OrchidRLan/Spec_AI-Powered-Shanghainese-Learning-Through-Virtual-Urban-Exploration/actions/runs/39139814837) 的检查与同步成功，自动通过 `repository_dispatch` 触发 fork run [39139916112](https://github.com/hollis-yang/Spec-Virtual-Shanghainese-Learning/actions/runs/39139916112)。fork attempt 1 在 Render 凭证预检返回 401，原因是初次保存误用了界面缩略值，未触发部署；修正同一 Secret 后只重跑 deploy job，attempt 2 输出 `Production release verified`。Render `dep-dbae85dg1s2s73bp94jg` 为 Live，随后 Vercel `dpl_A9QYsBbzurHQ84D4DmqbNDKXesTN` 为 Ready，均为验收提交 `bb68e962d0cfc85bdf815a77980ee16f0507d0b0`；脚本实测生产域名绑定、版本清单、代理健康和未登录认证通过。部署后另行执行 5 项持久化检查全部通过，模型调用 0、未使用麦克风；私密报告为 `private/deployment/online-smoke-verify_persistence-20261018T152414-0069.json`，不进入 Git。以上是固定验收记录，后续文档提交也会触发新的自动发布。

| 范围 | 已完成 | 实际证据 |
| --- | --- | --- |
| A 修订 4 | 南翔固定题、完整订单核对、结果停留、点继续推进、字音对齐与双速 | [验收](archive/batches/Batch-A-revision-4-acceptance.md)，用户已通过 |
| B+C | 老饭店、梨膏糖和茶楼独立流程、场景、保存恢复、四站回顾 | [验收](archive/batches/Batch-BC-acceptance.md)：539 项测试及开发环境四站串联 |
| 批次 2 修改 1 | 结束语自动播放、Review 总览／逐句双速、Logo | [验收](archive/batches/Batch-2-revision-1-acceptance.md)：129 项前端回归与浏览器检查 |
| 批次 2 修改 2 | About、设置精简、统一开关、桌面品牌间距 | [验收](archive/batches/Batch-2-revision-2-acceptance.md)：136 项前端回归与浏览器检查 |
| 批次 2 修改 3 | 登录注册、临时游客、进度承接、About 默认入口与身份保护 | [验收](archive/batches/Batch-2-revision-3-acceptance.md)：首轮完整检查 644 项 |
| 认证追加调整 | 8–128 字符密码、移除找回提示、规范化用户名主键、旧库兼容迁移 | [追加验收](archive/batches/Batch-2-revision-3-acceptance.md#追加调整密码与用户名主键)：170 前端＋439 后端，共 609 项相关回归，构建通过 |
| D 部署与基本检查 | Vercel／Render、持久化、访问保护、语音接通、备份与维护 | [D 检查记录](engineering/Batch-D-checks.md)：36 项线上基线、真实重启后 5 项持久化、11 项隔离恢复，以及实际 Chrome 检查；不代表 E 验收 |
| D 追加：全自动发布 | 合作仓库检查、同 SHA fork 同步、Render → Vercel 顺序部署、线上核验 | [自动部署记录](engineering/Automatic-deployment.md#verification)：60 项模拟测试、actionlint、真实 push／dispatch／部署及部署后 5 项持久化；无新增语音调用 |

以上数字属于不同阶段和检查范围，不相加为本次测试结果。最新应用构建主包为 677.43 kB；是否优化在 E 按实际加载结果判断。真实 API 调用与合成／真人边界保留在 [语音记录](engineering/Speech-integration.md)。

## 尚未完成

- B+C 及后续修改的整体体验确认，四站原句、注音、连读和实际教学声音的逐句审核。
- 系统性的真人上海话录音 → ASR → 目标判断 → 反馈与保存验证，以及 ASR／TTS 效果评估。
- 实体手机、目标 Chrome／Safari、横屏、200% 缩放、完整键盘／读屏和弱网恢复检查。
- 自动异地备份传输与生产原地回退演练尚未执行；目前采用自动同盘备份加按维护指引人工私密转存。实际浏览器麦克风及硬件声音尚未验证，归入 E。

## 后续执行

| 批次 | 下一项工作 | 完成条件 |
| --- | --- | --- |
| D 部署准备与部署 | 原部署、基本检查与追加全自动发布均已完成；持续按指引发布、备份、转存，并在 2027-01-16 前轮换到期令牌 | 已验证合作仓库检查、fork 同步、后端先于前端部署、线上版本与部署后持久化 |
| E 验证评估与修正 | 尚未开始；使用 D 的网址开展真人语音、设备兼容、模型效果、教材审核和全路线验证，修正后更新部署 | 问题与复测记录完整，教材真实审核，完成最终验收 |

保留原工作项编号：D 对应步骤 10，E 对应步骤 9，实际顺序为 D → E。`build:release` 仍拦截待审教材；`build:deployment` 已支持保留真实待审状态的完整性校验和部署构建。

所有历史阶段、测试边界、已知限制及真实调用记录保留在 [历史索引](archive/README.md) 和 [整理前进度快照](archive/Development-history.md)；代码提交及双仓库同步结果以 Git 历史和远端核验为准。
