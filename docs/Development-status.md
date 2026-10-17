# 开发进度与下一步

更新日期：2026-10-17。当前行为见 [产品规格](Product-spec.md)，后续阶段见 [D/E 计划](Batch-DE-plan.md)，全部文档见 [文档入口](README.md)。

## 当前状态

**批次 D 已按部署与基本运行范围完成，E 尚未开始。** 网站为 [A little Shanghai](https://spec-virtual-shanghainese-learning.vercel.app)，后端为 [a-little-shanghai-api](https://a-little-shanghai-api.onrender.com)。两端当前应用源码均为 `da96ca8883d1d5b2aab626f5eb6f60ab1bafe93f`，Render 部署 `dep-db9vq2lg1s2s73a7ok80` 为 Live，Vercel 部署 `GhTdMgq48GeChMw7i7Gdna9sqpKa` 为 Ready。线上版本清单的提交正确，`provider: vercel`、`dirty: null`、`reviewStatus: pending`。

四站功能、批次 2 的三轮修改和密码／用户名主键调整均已实现；批次 A 修订 4 已获用户体验通过，B+C 及后续修改尚无整体体验通过结论。教学文字、注音和声音仍待真实审核，部署成功不代表教材或最终产品通过。部署前已整理当前规格、历史归档和英文 README，检查通过 52 份 Markdown 的 550 个本地链接、43 处教学来源路径、171 个资源哈希及内容校验。

部署使用个人 fork `main`，合作仓库与 fork 按约定同步；线上从空库初始化，未导入本地账号或进度。Render 使用用户授权的 Virginia、0.5 CPU／512 MB、1 GB 持久磁盘，基础 US$7.25／月，税费与超额用量另计；没有升级或加购。密钥只配置在服务端。详见 [部署指南](engineering/Deployment.md) 和 [D 检查记录](engineering/Batch-D-checks.md)。

线上基线 36 项通过，涵盖账号／游客、数据隔离、受保护音频与四站辅助完成；四站明确模拟客户端技术回退，没有语音正确结论。真实 Render 更新重启后的 5 项持久化检查通过，原账号会话、四站、5 次尝试和偏好保持一致。Chrome 实际注册、刷新保持、退出重登、默认 About 及 Review 状态通过；中英地图、南翔与常／慢速播放状态已核验，静态 E08 哈希匹配，错误 Origin 被拒绝。

获准的唯一一次 E08 合成音频 ASR 返回「我要两份小笼馒头。」、服务耗时 1,962 ms；目标正确且停留在商品题，未自动推进。不使用麦克风、无重试，授权上限 ¥1，实际账单未核对，单次授权已用完。真人语音、硬件声音与模型效果留给 E，详见 [语音记录](engineering/Speech-integration.md)。

启动前备份、每日同盘备份和空闲游客清理已上线，首次维护周期成功。线上一致性备份已私密下载并核验相同 SHA256，恢复至独立本机文件后通过 11 项离线检查；未覆盖生产库，也不是生产原地回退演练。临时 SSH 公钥和本机私钥均已移除。自动异地传输尚未配置，本次已有人工私密异地副本，后续按 [维护指引](engineering/Database-maintenance.md) 持续转存。

## 已交付与证据

开发流程补充（2026-10-17）：按用户确认，将个人 fork 同步纳入每次 agent 推送合作仓库后的收尾。`npm run git:publish` 先发布并核验合作仓库 `main`，再将同一提交同步至 `hollis-yang/Spec-Virtual-Shanghainese-Learning` 的 `main`，最后核验双方提交一致；保留原 `origin`，不自动合并或强制覆盖独立提交。规则见 [AGENTS 第 8 节](../AGENTS.md#8-里程碑完成后自动提交与推送)，实现见 [同步脚本](../scripts/push-and-sync.mjs)。7 项临时本地 Git 仓库测试通过，覆盖成功／重试、主仓库拒绝、fork 分叉或领先、未提交修改、错误目标及其他分支；语法与差异检查通过。此项仅调整开发收尾，未实施部署或改动应用功能，最终实际同步结果以 Git 远端核验为准。

| 范围 | 已完成 | 实际证据 |
| --- | --- | --- |
| A 修订 4 | 南翔固定题、完整订单核对、结果停留、点继续推进、字音对齐与双速 | [验收](archive/batches/Batch-A-revision-4-acceptance.md)，用户已通过 |
| B+C | 老饭店、梨膏糖和茶楼独立流程、场景、保存恢复、四站回顾 | [验收](archive/batches/Batch-BC-acceptance.md)：539 项测试及开发环境四站串联 |
| 批次 2 修改 1 | 结束语自动播放、Review 总览／逐句双速、Logo | [验收](archive/batches/Batch-2-revision-1-acceptance.md)：129 项前端回归与浏览器检查 |
| 批次 2 修改 2 | About、设置精简、统一开关、桌面品牌间距 | [验收](archive/batches/Batch-2-revision-2-acceptance.md)：136 项前端回归与浏览器检查 |
| 批次 2 修改 3 | 登录注册、临时游客、进度承接、About 默认入口与身份保护 | [验收](archive/batches/Batch-2-revision-3-acceptance.md)：首轮完整检查 644 项 |
| 认证追加调整 | 8–128 字符密码、移除找回提示、规范化用户名主键、旧库兼容迁移 | [追加验收](archive/batches/Batch-2-revision-3-acceptance.md#追加调整密码与用户名主键)：170 前端＋439 后端，共 609 项相关回归，构建通过 |
| D 部署与基本检查 | Vercel／Render、持久化、访问保护、语音接通、备份与维护 | [D 检查记录](engineering/Batch-D-checks.md)：36 项线上基线、真实重启后 5 项持久化、11 项隔离恢复，以及实际 Chrome 检查；不代表 E 验收 |

以上数字属于不同阶段和检查范围，不相加为本次测试结果。最新应用构建主包为 677.43 kB；是否优化在 E 按实际加载结果判断。真实 API 调用与合成／真人边界保留在 [语音记录](engineering/Speech-integration.md)。

## 尚未完成

- B+C 及后续修改的整体体验确认，四站原句、注音、连读和实际教学声音的逐句审核。
- 系统性的真人上海话录音 → ASR → 目标判断 → 反馈与保存验证，以及 ASR／TTS 效果评估。
- 实体手机、目标 Chrome／Safari、横屏、200% 缩放、完整键盘／读屏和弱网恢复检查。
- 自动异地备份传输与生产原地回退演练尚未执行；目前采用自动同盘备份加按维护指引人工私密转存。实际浏览器麦克风及硬件声音尚未验证，归入 E。

## 后续执行

| 批次 | 下一项工作 | 完成条件 |
| --- | --- | --- |
| D 部署准备与部署 | 已完成；后续按部署和维护指引发布、备份与转存 | 已有可访问、待完整验收的版本，基本流程、重启保存、语音接通和隔离恢复已检查 |
| E 验证评估与修正 | 尚未开始；使用 D 的网址开展真人语音、设备兼容、模型效果、教材审核和全路线验证，修正后更新部署 | 问题与复测记录完整，教材真实审核，完成最终验收 |

保留原工作项编号：D 对应步骤 10，E 对应步骤 9，实际顺序为 D → E。`build:release` 仍拦截待审教材；`build:deployment` 已支持保留真实待审状态的完整性校验和部署构建。

所有历史阶段、测试边界、已知限制及真实调用记录保留在 [历史索引](archive/README.md) 和 [整理前进度快照](archive/Development-history.md)；代码提交及双仓库同步结果以 Git 历史和远端核验为准。
