# 批次 A 内容包与人工审核交接

日期：2026-10-17。对应十步路线步骤 2 的首批内容准备，供步骤 1 排版、步骤 3 内容加载与步骤 4 接口验证使用。

**本次没有完成外部人工语言审核，也没有生成或听审任何上海话音频。** 所有上海话汉字来自已标明待审校的项目草案；没有自行编造拉丁注音或中文谐音。店员台词仅是普通话语义和英文意思，`hanzi: null` 明确表示尚未改写为上海话。不能把这些语义稿直接送入 TTS 并称为上海话示范。

## 实际产物

| 文件 | 用途 | 当前状态 |
| --- | --- | --- |
| [batch-a.json](../../content/batch-a.json) | 四站双语元数据；E08/E09/E05 三组候选；NX-N01–12 语义稿；5 个支持词；28 个音频条目；数量、单位、任务规则及 18 个规则例子 | `draft`，全部语言、读音、近似读音、音频待审 |
| [types.ts](../../content/types.ts) | 可供前端使用的语言、分组、音频及审核类型 | 已提供结构；`null` 有语义，不能转成假读音 |
| [reviews.json](../../content/reviews.json) | 独立审校人、逐阶段决定和发布决定账本 | 所有数组为空，没有虚构签名 |
| [language-review-sheet.csv](language-review-sheet.csv) | 20 条教学文本的可填写审校表 | 候选/语义与来源已填；人类审校栏为空 |
| [audio-review-sheet.csv](audio-review-sheet.csv) | 28 条完整音频的制作与逐条听审表 | 文件、校验、听审人和决定均为空 |
| [review-record.template.json](review-record.template.json) | 审核人、记录和发布决定的字段模板 | 模板不能直接复制为已通过记录 |
| [validate-content.mjs](../../scripts/validate-content.mjs) | 开发结构检查及正式内容发布门槛 | 开发允许 pending；正式检查拒绝未审内容、伪批准、陈旧批准和缺失文件 |
| [validate-content.test.mjs](../../content/validate-content.test.mjs) | 21 个发布门槛回归测试，样本明确标记 synthetic | 临时目录执行并清理；不修改真实内容或审核账本 |

地图推荐顺序仍为老饭店 → 梨膏糖 → 南翔 → 湖心亭，四站元数据不表示四站都已实现。其他三站的 `expressionIds` 是后续内容引用，本包只带 E08/E09/E05。`implementedInBatchA` 是本批范围标记，不应显示为正式产品已验收。

## 前端与规则消费约定

- 使用 `name/taskTitle/taskDescription/meaning` 的当前 `zh` 或 `en` 字段。`hanzi` 与 `segments[].hanzi` 是上海话候选；开发页面必须显示待审校说明。12 条店员台词显示其当前语言语义稿，并清楚说明该稿不是审核后的上海话教材。
- `segments` 是词组对齐单位。E08 为「我要 / 两份 / 小笼包」，E09 为「打包 / 带走」，E05 为「对个」。分组也待流利使用者确认，修改整句时同步分组。
- `pronunciation: null` 不显示虚构拉丁注音。审核后默认显示词组注音并允许隐藏；`approximateZh` 只在中文模式提供默认收起入口，英文模式没有入口和内容。
- `audio.normal/slow` 指向 `audioClips[].id`。当前均无文件，播放按钮应明确待审核而不是播放普通话或占位音频。未审、缺文件或失败时仍可用文字和按钮。
- 表达卡填入仅产生草稿，用户提交后才影响订单。语义稿、释义与用户输入保持来源区分，不能把英语输入记录成上海话口语。
- `nanxiangTask.target` 与 `initialOrder` 分开：初始全部未知，不能因任务目标是两份外带而自动填入。
- 「两笼」只有用户实际看到单位说明，并保存 `unit_explanation_viewed` 事件后才可归一为两份。「两只」不能换算为两份；「两个」没有明确单位上下文时继续追问。
- `ruleExamples` 是工程预期，不是语言审校或模型效果结果。完整规则仍需后端用例检验。`false`（堂吃）与未知不同；修改使旧确认失效，保存失败不能显示完成。

## 可直接执行的审校顺序

1. 安排两位不同的流利上海话使用者。第一位在表中改写自然汉字、词组边界和可接受变体；第二位独立检查同一版本的自然度、汉字、普通话意思、英文意思和使用情境。每人记录实际姓名或稳定代号、日期、意见及决定，不由开发者代签。
2. 有分歧时保存 `changes-requested` 记录，修订并提升该条 `version`。两人对同一修订稿重新决定后再标记 `language: approved`，同步登记 `review.recordIds`。两条相同审校人 ID 的记录不算两人审核；任何当前版本尚未解决的修改意见阻止进入后续批准。
3. 由流利使用者提供完整参考读法，保存项目内可共享的文件、SHA256、实际说话人和日期。依据真实读法填写统一拉丁注音、词组注音及中英文发音说明，另存 `pronunciation` 决定，证据关联该参考文件。这里的参考读法是许可清楚的教学资产，不是学习者私人录音。
4. 基于批准读法填写中文近似读音和词组对应。做一次有记录的中文初学者试读检查，记下具体误读/修订和结果，放入 `evidence.trialNotes`，然后记录 `approximation` 决定。这是材料可读性检查，不引入参与者招募、正式用户研究或模型对照研究。
5. 语言双审完成后，制作常速/慢速完整音频；店员台词只需本包列出的常速版本。不得拼接单字，不得把语义稿当上海话。使用实际服务/人工录音来源和模型、音色、参数、时长、校验值；生成成功仍是 `generated`，不能视为听审通过。
6. 逐文件听审自然度、词组连读、两份与两只、否定范围、常慢速一致性和完整性。每个文件独立 `audio` 决定，证据含 `clipId` 和该文件 SHA256；缺任一语速不能把表达标成通过。音频未通过可重新制作并提升版本、重新审核。
7. 双语地图和单位说明由具备 `editorial` 角色的编辑审核；对四个 station ID 和 `NX-TASK` 分别登记。编辑批准不替代上海话双人审核。
8. 所有阶段批准后将条目与音频状态设为 `approved`，上海话 `textKind` 改为 `reviewed-shanghainese`，再由发布负责人检查完整包。发布决定绑定整个包的 SHA256；任何改动使旧包批准不适用于新包。正式构建还必须满足总体产品验收，不因内容校验通过就发布整个产品。

审核时必须区分「语义准确」「自然上海话」「读音准确」「近似读音可用」「音频准确」；一个通过标记不能代替其他阶段。参考读法与常慢速示范分别存放和记录。任何真实身份、许可或试读未获得时保留待审状态。

## 审核账本与校验命令

在仓库目录执行：

```sh
node scripts/validate-content.mjs --mode development
node scripts/validate-content.mjs --mode production
node scripts/validate-content.mjs --hash E08 --stage language
node scripts/validate-content.mjs --hash E08 --stage pronunciation
node scripts/validate-content.mjs --hash E08 --stage approximation
node scripts/validate-content.mjs --hash E08 --stage audio --clip E08.normal
node scripts/validate-content.mjs --hash nanxiang --stage editorial
node scripts/validate-content.mjs --hash package
node --test content/validate-content.test.mjs
```

开发检查应通过并列出待审核提示；**当前正式检查必须以非零状态退出，这是有效的保护结果，不是应绕过的构建错误。** 发布构建必须执行 production 模式，预览构建只能标为开发预览。`--production` 与 `--development` 是对应模式的简写；重复模式参数会被拒绝。命令还接受 `--content` 和 `--reviews` 指定候选包与账本以复核新版本。

PCM WAV 的文件结构和实际时长直接验证，不需要外部媒体工具；其他支持的音频容器需要环境中可用的 `ffprobe`。非音频文件、截断 WAV、清单与实测时长不符均阻止发布。文件探测不允许联网读取外部播放列表。

语言审核哈希投影为 `{id, version, hanzi, meaning, segments:[{id, hanzi, meaning}], acceptableVariants}`，按 JSON 对象键递归排序、保留数组顺序、UTF-8、无额外空格计算 SHA256。读音哈希还绑定语言哈希和参考读法，近似读音哈希绑定读音，听审哈希绑定语言与实际音频元数据。CLI 输出可直接填入决定的 `subjectSha256`，不要手工猜测。历史版本的决定保留；当前版本的决定不得指向被修改的内容。

`reviewers` 只记录实际人员。`roles` 对应他们确实执行的 `language/pronunciation/approximation/audio/editorial/release` 工作；语言、读音、听审还需 `fluentShanghainese: true`。每条记录以 `contentId/contentVersion/stage` 关联条目；音频另以 `evidence.clipId` 区分常慢速。先写实际决定，再关联到文本的 `recordIds` 或音频的 `reviewIds`，不能仅把状态改为 approved。

发布检查拒绝：缺少必需文本、缺失释义或词组、未知引用、重复 ID、语义稿冒充定稿、未审核或只有一位语言审校人、同一人重复签名、仍有修改意见、文本改动后沿用旧批准、缺少读音或试读证据、缺音频/参考文件、错误音频类型或时长、校验值不符、资产路径越界、将表达改成台词类型以省略慢速、缺少正式发布负责人对当前包的决定。

本批次实际验证记录见 [validation.md](validation.md)。本目录不记录未执行的服务调用、流利审核或听审。
