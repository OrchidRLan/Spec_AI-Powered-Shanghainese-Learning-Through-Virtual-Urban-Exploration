# 批次 A 内容包与人工审核交接

日期：2026-10-17。当前文本版本：`batch-a-r1.2026-10-17.v1`。按 [批次 A 修订 1](../Batch-A-revision-1.md)，先提供可显示、可试听的候选材料，再由用户及实际审校者提出修改。生产发布仍须通过真实审核门槛。

**本次没有完成外部人工语言或读音审核。** 20 条文本已有沪语汉字候选、分组拉丁注音及双语意思，状态全部为 pending。注音有在线查词依据，含单字调标记与明确的未定项；不能把逐字调号当作整句实际连读，也不能把 TTS 生成成功当作自然度批准。中文近似读音和真人参考读法仍为空。

## 实际产物

| 文件 | 用途与真实状态 |
| --- | --- |
| [batch-a.json](../../content/batch-a.json) | 四站双语元数据；E08/E09/E05；NX-N01–12；5 个支持词；28 条正式音频占位；规则例子。20 条文本已有候选和注音，所有批准仍待审 |
| [types.ts](../../content/types.ts) | 原文字段保持兼容；新增注音方案类型和方案 ID，非空读音不等于获准 |
| [旧包快照](../../content/versions/batch-a.2026-10-17.v1.json) | 从修订前 Git HEAD 原样保存，供旧会话绑定旧内容，不能静默改绑 |
| [Pronunciation-draft-r1.md](Pronunciation-draft-r1.md) | 方案、声调、词组分界、实际查词链接、集中存疑项与 20 条逐句审阅表 |
| [reviews.json](../../content/reviews.json) | 独立审校人、逐阶段决定、发布决定账本。三个数组仍为空，没有虚构签名 |
| [language-review-sheet.csv](language-review-sheet.csv) | 20 行、34 列；候选汉字/注音/来源已填，最终版本和真实审校栏留空 |
| [audio-review-sheet.csv](audio-review-sheet.csv) | 28 行正式音频制作与听审表；尚无批准文本、正式文件和听审决定 |
| [review-record.template.json](review-record.template.json) | 真实审核记录字段模板；不得把示例直接作为批准 |
| [validate-content.mjs](../../scripts/validate-content.mjs) | 开发允许 pending；正式发布拒绝未审内容、伪批准、陈旧批准和缺文件 |
| [validate-content.test.mjs](../../content/validate-content.test.mjs) | 发布门槛和本轮 20 条非空候选的工程回归；合成样本不是人工审核 |

常速审阅样音使用独立 `content/audio-review-r1.json` 清单和 `frontend/public/audio/review-r1/` 素材，由制作流程记录真实文件、时长、哈希、输入和声音配置。实际生成结果以该清单及应用试听页为准。草稿样音不填入正式 `audioClips` 冒充批准；原包的 28 条生产音频仍为 pending。8 条慢速等常速读法确认后制作，不复制常速充当慢速。

本轮已有 20 条常速审阅样音，共 29.84 秒；已核文件存在和 SHA256，尚未完成流利者听审。可在 [逐句审阅表](Pronunciation-draft-r1.md#4-逐条审阅表) 打开每条文件，[独立清单](../../content/audio-review-r1.json) 记录实际制作来源与输入版本。

## 前端与规则消费约定

- `expressions`、`dialogues`、`supportTerms` 数组和 20 个 ID 保持不变。`hanzi` 与 `segments[].hanzi/pronunciation` 显示沪语审阅稿；`meaning` 只显示当前界面语言。当前稿全有字和注音，不再以空白等待提示代替正文。
- 拉丁注音默认开并可隐藏；不隐藏汉字和意思。中文近似读音仅中文模式按需展开；英文无入口。`approximateZh: null` 仍不能伪造谐音。
- `pronunciationScheme` 与 `pronunciationHelp` 说明单字调、词组分界和特殊项。`gheq` 未带调号表示未定，不是零调；问末伐按助词𠲎暂记 `va6`，不是砍伐的 `vaq8`。
- 文字、读音与音频必须关联相同 ID、版本及实际输入。审阅清单没有匹配文件或文件加载失败时明确显示状态；不能误播旧字稿。TTS 只接收整句沪语汉字，不混入意思或注音，不逐字拼接。
- 主流程使用语音和当前轮按钮。历史 text/voice_edited 记录保留，输入来源不改写。当前回答由商品、数量、方式、核对的实际状态决定；语音可一次表达多个明确字段。
- 小笼馒头是本稿的商品称呼，意思仍为小笼包／xiaolongbao，`NX-ITEM-XLB.semanticValue` 不变。初始订单仍全部未知，不能从任务目标预填。
- 两笼只有用户确实看到单位说明并保存事件后才能归一为两份。两只不能换算两份；两个缺少单位上下文仍追问。堂吃 `false` 与未知不同；修改使旧确认失效，保存成功后才显示完成。
- 四站元数据不代表四站业务都已实现；`implementedInBatchA` 是本批范围标记，不能作为全产品验收结论。

## 审阅稿制作与正式批准

审阅稿路径可以先运行：冻结文字与注音 → 按真实输入制作常速 TTS → 保存独立清单及稳定文件 → 界面明确标记审阅稿 → 用户逐句看、听、提出修改。制作不需要先伪造语言批准。修改应提升版本并重新制作受影响文件；旧记录保留。音频预算、真实调用和生成结果由实际制作记录说明。

正式批准路径仍按以下顺序执行：

1. 两位不同的流利上海话使用者独立检查同一版本的自然度、汉字、分组、中文/英文意思和语境。记录实际人员稳定 ID、日期、意见与决定；开发者不代签。候选表里的 `draft_*` 列不是最终签字列。
2. 有修改意见时保存 `changes-requested`，修订内容并提升版本，再取得同版决定。两条相同审校人 ID 不算双人审核；未解决的修改意见阻止批准。
3. 由实际流利使用者提供许可清楚的完整参考读法，保存文件、SHA256、说话人和日期。依据真实语流检查注音、连读和发音说明，再记录 `pronunciation` 决定；字典与 TTS 不能替代参考读法。
4. 如正式产品使用中文近似读音，在批准读法上制作并记录一次真实试读意见及修订。把结果填入 `evidence.trialNotes`，再作 `approximation` 决定。没有证据时仍待审。
5. 基于同版已审文本制作或复核正式常速/慢速音频；店员只需清单列出的常速。记录实际来源、模型、音色、配置、时长和哈希；生成成功只是 generated。
6. 每个正式文件独立听审，自然度、连读、数量/否定、常慢速一致性和完整性均核对。`audio` 决定绑定 clipId 与文件哈希；缺一语速不得标整条通过。
7. 地图双语和单位说明由 editorial 角色编辑分别审查四站与 NX-TASK。编辑批准不替代沪语审核。
8. 全部阶段真实通过后，更新状态与关联 recordIds，最后发布负责人批准整个包哈希。总体产品验收和生产部署仍是另外的条件。

审核时区分语义准确、自然口语、字音/连读、近似读音可用和声音质量，不能用一个通过标记替代全部。此流程是材料和工程审核，不引入参与者招募或正式用户研究。

## 校验与审核证据

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

当前开发检查应通过，正式检查应以非零退出，因为尚未取得真实批准和正式音频。这是保护结果；不能绕过 production 模式把预览声称为发布。`--content`、`--reviews` 可复核指定版本；审阅音频另走独立预览制作，不篡改本包批准字段。

语言 SHA256 投影为 `{id, version, hanzi, meaning, segments:[{id, hanzi, meaning}], acceptableVariants}`，按对象键递归排序、保留数组顺序、UTF-8、无额外空格计算。读音哈希绑定语言哈希和参考读法，近似读音哈希绑定读音，听审哈希绑定语言与实际音频。任何内容修改后旧哈希不再适用。

正式校验检查双人独立证据、角色与真实能力标记、同版本关联、未解决修改意见、文件路径/存在/类型/实测时长/哈希、参考读法和发布决定。PCM WAV 可直接测；其他支持容器需要 ffprobe。文件探测不读取网络播放列表。测试中的合成审校人只在临时测试目录，不写入真实账本。

内容工程检查见 [validation.md](validation.md)。本文不把尚未执行的生成、听审或用户审阅写成完成。
