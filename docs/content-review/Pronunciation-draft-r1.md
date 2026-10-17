# 批次 A 修订 1 注音与台词审阅稿

版本：`batch-a-r1.2026-10-17.v1`。日期：2026-10-17。适用 [已确认修订](../Batch-A-revision-1.md)。

20 条沪语汉字、分组和注音已经冻结，供常速 TTS 审阅样音制作。它们是有查词依据的候选稿，没有流利使用者签名、正式读音批准或听审批准。原句、注音与音频若需改动，须换版本并重新核对；不要在旧音频旁悄悄改字。中文近似读音仍为空，未把拉丁注音改写成未经核对的普通话谐音。

## 1. 统一方案与显示约定

本稿以**吴语学堂上海中派字音**为基础。拉丁拼写属于上海话方案，不是汉语拼音。官网字音优先；官方输入法词库用于词项交叉检查。比如本稿采用官网的 `shiau5`，不混入词库另一套尖团处理下的小 `siau`；讲采用官网标出的白读 `kaon5`，带暂选白读 `ta5`，两项在餐饮语境里的选择仍请审阅者确认。

| 记号 | 本稿定义 |
| --- | --- |
| 1 / 5 / 6 / 7 / 8 | 单字调类，官网方案分别对应 53 / 34 / 23 / 5 / 12；不是普通话一到四声 |
| 每个音节后的数字 | 字音词典的单字调标记，**不表示连成句子后每个字都保持该音高** |
| 音节间空格 | 字音对齐，便于读者对照汉字 |
| 词组间 `/` 与 `segments` | 教学排版分组；不宣称每一组就是最终连读变调域 |
| 末尾 `q` | 该方案中的入声韵尾记号，不能按普通话字母 q 读 |
| `gheq` 不带数字 | 助词“个”的词条提供此拼写，但本次没有核到适用于此用法的独立调号；缺数字表示未定，**不是零调或已证明轻声** |
| 问末“伐” → `va6` | 本稿用常见借字“伐”写疑问助词“𠲎”；官网“𠲎”条为 `va6`，备注“去~，吗”。不能套用砍伐的 `vaq8` |

官方中派方案解释声母、韵母和单字调；NGLI 仓库说明其上海中派资料依据《上海市区方言志》（许宝华、汤珍珠，1988）。本轮直接核查的是下列在线资料，并未取得该书逐页正文或把书目当成已完成原书查验。[官方方案](https://github.com/NGLI/rime-wugniu_zaonhe/wiki/音系及拼音方案)、[官方词库与说明](https://github.com/NGLI/rime-wugniu_zaonhe)

上海话连读与词法、句法边界有关，因此本稿不自动用单字调推算整句音高；分组注音只是可审阅的起点。自然语流、礼貌语气与疑问调必须结合实际样音听审。[Yuanhao Chen 的 TTS 与词分界研究](https://arxiv.org/abs/2307.16199)

## 2. 实际查词与文字依据

2026-10-17 已通过吴语学堂网页的上海中派查询核读。网页的字音以图形呈现，本次使用浏览器查看；网页抓取工具部分查询返回错误。没有将抓取失败写成“查不到该字”，也没有伪造本地截图文件。查询最多处理前八字，多音结果可能跨页。

| 查询 | 本稿采用的字音事实与边界 |
| --- | --- |
| [侬、啥、小、笼、馒、头、包、份](https://www.wugniu.com/search?char=侬啥小笼馒头包份&table=shanghai) | `non6 sa5 shiau5 lon6 moe6 deu6 pau1 ven6`；份字音不独立证明餐饮量词用法 |
| [我、要、好、买、几、勒、店、里](https://www.wugniu.com/search?char=我要好买几勒店里&table=shanghai) | 本稿选择我白读 `ngu6`、要 `iau5`、好 `hau5`、买 `ma6`、几（数量）`ci5`、里 `li6`；未将“几乎”的 `ci1` 用作几份 |
| [还、是、搿、趟、改、伐、练、习](https://www.wugniu.com/search?char=还是搿趟改伐练习&table=shanghai) | 采用 `ghe6 zy6 geq8 thaon5 ke5 li6 zhiq8`；还的词义用官方词条“還是 ghe zy”交叉核对；问末伐另查𠲎 |
| [可、以、点、帮、想、数、量、用](https://www.wugniu.com/search?char=可以点帮想数量用&table=shanghai) | 本稿采用 `khu5 i5 ti5 paon1 shian5`；查到字音并不等于整句已自然 |
| [餐、方、式、请、只、三、外、需](https://www.wugniu.com/search?char=餐方式请只三外需&table=shanghai) | 本稿请 `chin5`、只（隻）`tsaq7`、三 `se1`；不能把“只有”的只 `tseq7` 套给两只 |
| [𠲎、呒、個、伐、勿](https://www.wugniu.com/search?char=𠲎呒個伐勿&table=shanghai) | 𠲎 `va6` 与伐 `vaq8` 不同；語气“个”未直接用量词“個”的 `geq8` |
| [吾、慢、谢、听、清、楚、遍、趟](https://www.wugniu.com/search?char=吾慢谢听清楚遍趟&table=shanghai) | 本稿遍 `pi5`、趟 `thaon5`；备用词不自动加入教材 |

另核字音：两 `lian6`，打 `tan5`，带 `ta5`（白）／`te5`（文），走 `tseu5`，堂 `daon6`，吃 `chiq7`，对 `te5`，再 `tse1`，讲 `kaon5`（白）／`cian5`，一 `iq7`。这些是有限词项的核查记录，不是整本字典拷贝；没有复制或提交原词库。[吴语学堂查询入口](https://www.wugniu.com/)

官方输入词库直接提供对个 `te gheq`、好个 `hau gheq`、还是 `ghe zy`、再讲 `tse kaon`，但这些词条不带调号，不能单靠它们补出整句调型。[原始词库](https://raw.githubusercontent.com/NGLI/rime-wugniu_zaonhe/master/wugniu_zaonhe.dict.yaml)

文字与语法依据另列，避免把它们冒充完整发音证据：

- **小笼馒头**：上海市公开非遗条目采用该名称。本稿汉字改用此称呼，意思仍是小笼包／xiaolongbao，业务 `semanticValue: xiaolongbao` 不变。[上海市条目](https://www.shanghai.gov.cn/hpfy/20260615/964f8e046e624a3a99bb4c9a12dbc407.html)
- **对个与里向**：钱乃荣原文使用“就是对个”和“勿对个”，并讨论“里向”的书写；这是短语用法证据，不能证明本项目 20 句的读音全部合格。[钱乃荣原文](https://xmwb.xinmin.cn/html/2013-02/27/content_28_2.htm)
- **问末伐**：邵敬敏论文摘要讨论 `S伐？` 和 `S，VP伐？` 的沪语疑问结构。本文未据此把每个新编完整句子认定为自然母语表达。[期刊原站](https://xbzs.ecnu.edu.cn/CN/10.16382/j.cnki.1000-5579.2007.04.014)

## 3. 集中给审阅者确认的问题

1. **先听整句，再看字调**：`两份`、`两只`、`小笼馒头`、`打包带走`的连读边界和节奏是否自然？现在的字调标记不能替代这一判断。
2. **语气“个”**：E05、NX-N04/N07/N10 的 `gheq` 是否合适？是否应补明确音高、弱读说明或改词？不能从量词条目直接推断。
3. **疑问“伐”**：NX-N05/N06/N09 的 TTS 是否读成自然助词，是否错误读成砍伐或普通话？`va6` 是字典单字调依据，不是承诺每个问句末尾都同一曲线。
4. **带与讲的文白读**：本稿暂选 `ta5`、`kaon5`，请在餐饮语境中确认。不要把语音服务的偶然读法反向当作字音审核。
5. **数量与单位**：份作为学习单位是否自然清楚？“两只”必须继续表示两个单体，不能换算两份；“两笼”依既有单位说明规则处理，不能擅自把原句的份换成客或笼。
6. **口语自然度**：NX-N05/N06 的搿趟保留“这次”的任务提醒；NX-N07 的“练习里”可审是否改成“练习里向”或更自然的范围说法。NX-N10 的“帮侬打包”和 NX-N12 的礼貌语气也未获得完整句级确认。
7. **界面提示与原句一致**：NX-N11 简化为“侬想改啥？”，释义同步为“您想改什么？／What would you like to change?”；数量／用餐方式可由选项辅助，不能把原句说成已列举这两个字段。
8. **未完成的材料**：中文近似读音、参考读法、两位流利者独立决定及正式听审都未完成。常速审阅样音另有清单；8 条慢速仍待常速读法确认后制作。

## 4. 逐条审阅表

下表内容直接对应冻结 JSON。声音列是稳定 `clipId`，从 `content/audio-review-r1.json` 查对应已生成文件与哈希；该独立清单由音频制作任务写入。没有文件时不得声称生成成功。所有行均为待审，正式生产清单另有 28 条，状态不因草稿样音生成而改变。

本次已从独立清单核验 **20 条常速生成文件**存在且 SHA256 相符，总时长 **29.84 秒**；下列声音链接可逐条打开。文件可用性核验不是人耳听审，语言、连读与声音质量仍待审。生成输入和实际模型/音色见 [审阅音频清单](../../content/audio-review-r1.json)，8 条慢速未制作。

| ID | Hanzi draft | Romanization by group | Meaning (zh) | Meaning (en) | Audio clipId | Review focus |
| --- | --- | --- | --- | --- | --- | --- |
| E08 | 我要两份小笼馒头 | ngu6 iau5 / lian6 ven6 / shiau5 lon6 moe6 deu6 | 我要两份小笼包。 | Two servings of xiaolongbao, please. | [E08.normal](../../frontend/public/audio/review-r1/48069a80946da32de63a0269af023698896dc1905d6ec85116c4e41bccde3538.wav) | Quantity and serving unit; whole-word rhythm. |
| E09 | 打包带走 | tan5 pau1 / ta5 tseu5 | 打包带走。 | To go, please. | [E09.normal](../../frontend/public/audio/review-r1/118795f02488b9356b36e719f0ee46b29ab49ea6a7d1a373adbdd6f806bbf6f0.wav) | White reading ta5; wording as a polite request. |
| E05 | 对个 | te5 gheq | 对的。 | Yes, that's right. | [E05.normal](../../frontend/public/audio/review-r1/7e6eee36c056099cf95fee488e39d035c729e42e20311e26322b1947449edffa.wav) | Particle gheq; unresolved citation tone. |
| NX-N01 | 侬好，要买啥？ | non6 hau5 / iau5 ma6 sa5 | 您好，想买什么？ | Hello. What would you like? | [NX-N01.normal](../../frontend/public/audio/review-r1/6af590c9eb11dfc8e8454e70cbb0841e4d3197e7c12b114e2ba6d73b85045892.wav) | Greeting and question prosody. |
| NX-N02 | 要几份？ | iau5 / ci5 ven6 | 要几份？ | How many servings? | [NX-N02.normal](../../frontend/public/audio/review-r1/6e281c9a5da8674a956960029525b6bcc42012a49fa6ff31acb10bd8c1840cd2.wav) | ci5 for quantity; question intonation. |
| NX-N03 | 堂吃，还是打包带走？ | daon6 chiq7 / ghe6 zy6 / tan5 pau1 / ta5 tseu5 | 堂吃还是外带？ | For here or to go? | [NX-N03.normal](../../frontend/public/audio/review-r1/e126a8b8b21290c5898e120b76e4f6d50f894843fe0cd46683a8feddb620b1cc.wav) | For-here/to-go contrast; ghe6 zy6 phrasing. |
| NX-N04 | 侬讲个是两只，还是两份？ | non6 kaon5 gheq / zy6 lian6 tsaq7 / ghe6 zy6 / lian6 ven6 | 你说的是两只，还是两份？ | Do you mean two dumplings or two servings? | [NX-N04.normal](../../frontend/public/audio/review-r1/36334b075396220f5c052b667fc14af2a48f41295ab30d46afe9ea09e92e1545.wav) | Two pieces versus two servings; particle gheq. |
| NX-N05 | 搿趟要两份，改一改好伐？ | geq8 thaon5 / iau5 lian6 ven6 / ke5 iq7 ke5 / hau5 va6 | 这次需要两份，改一下好吗？ | This time you need two servings. Shall we change that? | [NX-N05.normal](../../frontend/public/audio/review-r1/6d48d47b82e3b1332b48c358bfb623426648504c9507ce98cc032c88f17192a7.wav) | This-time reminder; repetition and question particle. |
| NX-N06 | 搿趟要带走，打包好伐？ | geq8 thaon5 / iau5 ta5 tseu5 / tan5 pau1 / hau5 va6 | 这次要带走，打包好吗？ | This order is to go. Shall we pack it up? | [NX-N06.normal](../../frontend/public/audio/review-r1/52040e8966666cb55d0b97cf8a32c5596517426f78a15da3989ba8f6a3cce4e4.wav) | To-go reminder; ta5 and va6 in context. |
| NX-N07 | 搿个练习里，可以点小笼馒头。 | geq8 gheq / li6 zhiq8 li6 / khu5 i5 ti5 / shiau5 lon6 moe6 deu6 | 这个练习里可以点小笼包。 | In this activity, you can order xiaolongbao. | [NX-N07.normal](../../frontend/public/audio/review-r1/25eed0fe9a868c4b0385e4b1cb76969b820444f68e3be1847bfea4a1d4fc8ca4.wav) | Activity wording; li versus li-shian; dish-name rhythm. |
| NX-N08 | 要几份？侬再讲一遍。 | iau5 ci5 ven6 / non6 tse1 kaon5 / iq7 pi5 | 要几份？请再说一遍。 | How many servings? Please say that again. | [NX-N08.normal](../../frontend/public/audio/review-r1/28672c561470c124317c3293ca18a4dadcfd8d13ae01d89e907523d405ea3f2f.wav) | Polite repeat request, not a reprimand. |
| NX-N09 | 两份小笼馒头，打包带走，对伐？ | lian6 ven6 / shiau5 lon6 moe6 deu6 / tan5 pau1 / ta5 tseu5 / te5 va6 | 两份小笼包，外带，对吗？ | Two servings of xiaolongbao to go. Is that right? | [NX-N09.normal](../../frontend/public/audio/review-r1/26ab89c02ccd14f34b6cf8523a6312973d7dfc77e0efcc92be0a6ad233c6112c.wav) | Quantity and takeaway scope; question particle. |
| NX-N10 | 好个，帮侬打包。 | hau5 gheq / paon1 non6 / tan5 pau1 | 好的，给你打包。 | All right. We'll pack them for you. | [NX-N10.normal](../../frontend/public/audio/review-r1/01e941bff7c35139ef9cd873fb9073eee73b9663e5a906f023673a96a1acddc0.wav) | hau5 gheq; packing wording; use only after saved completion. |
| NX-N11 | 侬想改啥？ | non6 shian5 / ke5 sa5 | 您想改什么？ | What would you like to change? | [NX-N11.normal](../../frontend/public/audio/review-r1/ae7e572d73d4978bb03feab18f70eaa3a54b61ce203ad20ec54b849bb3e8e65d.wav) | Open modification question; options supply fields. |
| NX-N12 | 请侬再讲一遍。 | chin5 non6 / tse1 kaon5 / iq7 pi5 | 请您再说一遍。 | Please say that again. | [NX-N12.normal](../../frontend/public/audio/review-r1/74fdf5c8c9119966fe75f5ca3f17c3ac92c939ed468159400e0531cad66ac0cb.wav) | Politeness and connected speech. |
| NX-Q1 | 一份 | iq7 ven6 | 一份 | One serving | [NX-Q1.normal](../../frontend/public/audio/review-r1/18f7687d513881e8f9f83b3c86c8d81c28d1bd8f663b3b4b98024430644927fe.wav) | Checked syllable and serving-group rhythm. |
| NX-Q2 | 两份 | lian6 ven6 | 两份 | Two servings | [NX-Q2.normal](../../frontend/public/audio/review-r1/1a1145476973ac7fc0a094edfe4aecc8607fa278eae500d4fdaabcfcbf6bdc40.wav) | Two servings must differ from two pieces. |
| NX-Q3 | 三份 | se1 ven6 | 三份 | Three servings | [NX-Q3.normal](../../frontend/public/audio/review-r1/167356f4070c6b1b7aa1244e6b95c372c9362e1d3cf1ae9a84ffef8e82be6a0a.wav) | Three-serving quantity and connected speech. |
| NX-MODE-HERE | 堂吃 | daon6 chiq7 | 堂吃 | For here | [NX-MODE-HERE.normal](../../frontend/public/audio/review-r1/96429af15a3855cda709b5dffce744b1d9db03c129e406477b9f8b0917a1515c.wav) | For-here wording; false is not unknown. |
| NX-ITEM-XLB | 小笼馒头 | shiau5 lon6 moe6 deu6 | 小笼包 | Xiaolongbao | [NX-ITEM-XLB.normal](../../frontend/public/audio/review-r1/ccf56f00ef6ede50a28fc3d3ef5cd9b3274810bf32dcbfabe0f0c7bb1fd9360c.wav) | Dish name maps to xiaolongbao; whole-word rhythm. |
