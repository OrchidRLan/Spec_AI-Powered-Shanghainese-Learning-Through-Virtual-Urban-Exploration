# 批次 A：语音服务边界与内容制作

当前覆盖性决定（2026-10-17）：[批次 A 修订 1](Batch-A-revision-1.md) 已获用户确认。当前实现采用逐轮提问、语音/选择两种入口、直接显示沪语/注音/释义，允许先生成注音与 TTS 待审稿供用户审阅。以下旧稿中的 Type、仅点击查看当前表达、未审稿一律不可生成/显示等规定由本修订替代；其他未冲突要求保留。

核对日期：2026-10-17。实现位于 `backend/app/providers/`，制作入口为 `scripts/speech.py`。本批次交付可替换适配器、HTTP 合约测试、审核门槛及受控资产保存流程。用户随后填写凭据并授权少量真实诊断，已验证北京地区账户的 ASR、Qwen-Plus 和 Jada 技术请求，详见文末记录。**真实上海话识别质量、Jada 上海话教学发音与常/慢速听审仍为 pending**；mocked transport 与英文合成诊断都不能代替这些验收。

## 官方合约与初选配置

| 服务 | 初选配置 | 请求与结果 |
| --- | --- | --- |
| ASR | `qwen3-asr-flash` | OpenAI compatible `POST /compatible-mode/v1/chat/completions`；`messages` 携带 `input_audio.data` Data URL，`stream:false`、`asr_options.enable_itn:false`；读取 `choices[0].message.content` 原转写 |
| 理解 | `qwen-plus`，非思考模式 | 同一路径，`response_format` 明确为 `json_object`；返回 JSON 后由服务端校验，最多一次结构修复重试，共享 8 秒总预算 |
| TTS | `qwen3-tts-flash` + `Jada` | `POST /api/v1/services/aigc/multimodal-generation/generation`；`input.text/voice/language_type`；读取 `output.audio.url`，立即下载到本地资产，不在清单留下临时链接 |

ASR 官方说明及示例见 [Qwen-ASR API](https://help.aliyun.com/en/model-studio/qwen-asr-api-reference)。`zh` 是 API 的中文语种参数，不能当作已判断上海话；界面语言不会自动传作识别提示。置信度未提供时保留 `null`。

TTS 使用 [Qwen-TTS HTTP 合约](https://help.aliyun.com/zh/model-studio/qwen-tts-api) 和 [Jada 官方非实时音色列表](https://help.aliyun.com/en/model-studio/qwen-tts-voice-list)。内部目标语言记为 `wuu`，提供商参数为 `Chinese`、音色必须为 `Jada`；这项参数映射不构成上海话质量证明。下载后必须双人听审；错误或不自然读法不能以普通话替代。返回临时 URL 的有效期有限，不能成为 App 的长期素材地址。

[官方结构化输出文档](https://www.alibabacloud.com/help/en/model-studio/qwen-structured-output) 区分 JSON Object 与 JSON Schema；2026-10-17 查阅的支持表只为指定系列列出严格 Schema。当前 `qwen-plus` 默认走 JSON Object，并如实记录模式。实际账户选择受支持的 Plus 部署后可显式设 `QWEN_LLM_JSON_MODE=json_schema`，仍做服务端校验；不静默更换模型或降级输出模式。两种模式都不能决定任务完成。

## 仅服务端配置

以下变量不进入浏览器；只读配置输出只有是否已配置凭据，不返回密钥或端点。默认没有调用权限，单独放入密钥不会开启 API。

| 变量 | 默认值/作用 |
| --- | --- |
| `SPEECH_ENABLE_LIVE` | `false`；显式 `true` 才允许真实服务调用 |
| `QWEN_ASR_ENABLE_LIVE` / `QWEN_TTS_ENABLE_LIVE` / `QWEN_LLM_ENABLE_LIVE` | 可分别覆盖总开关 |
| `DASHSCOPE_API_KEY` | 服务端共享凭据；没有默认值 |
| `QWEN_ASR_API_KEY` / `QWEN_TTS_API_KEY` / `QWEN_LLM_API_KEY` | 可分别覆盖共享凭据，适用于不同地区账户 |
| `QWEN_ASR_REGION` / `QWEN_TTS_REGION` / `QWEN_LLM_REGION` | `beijing`；也支持 `singapore`，需匹配该地区密钥与可用模型 |
| `QWEN_ASR_ENDPOINT` / `QWEN_TTS_ENDPOINT` / `QWEN_LLM_ENDPOINT` | 默认对应地区的官方域名 origin；可改官方 workspace 专属域名，不含 API 路径、查询参数或认证信息 |
| `QWEN_ASR_MODEL` / `QWEN_TTS_MODEL` / `QWEN_LLM_MODEL` | 上表初选模型；切换必须新配置、重新验证 |
| `QWEN_LLM_JSON_MODE` | `json_object` 或显式 `json_schema` |

ASR、TTS、LLM 独立保留模型、地区、部署方式、适配器版本、配置 ID 与耗时预算。配置 ID 随模型/端点/参数变化，不随密钥变化。提供商未公开的底层版本为 `null`。托管名称不冒充 Qwen3-ASR-1.7B 或 CosyVoice 开放 checkpoint。

## 后端使用约定

- `ASRProvider.transcribe(ASRRequest)` 返回 `ASRResult`：原转写、状态、耗时、配置 ID、上游请求 ID、返回模型以及可空的语言/置信度。输入 bytes 必须来自后端已授权的会话上传，不接受任意远程 URL；私有上传与会话权限由 API 层执行。
- `SemanticProvider.interpret(text, context)` 返回 `Interpretation`：意图、字段变更、逐字段证据、不确定点和帮助信号。批次 A 只接受本轮原文中真实存在的证据片段；仅凭上下文推测的字段不得填入。模型结果必须再经过任务引擎业务校验。
- `TTSProvider.synthesize(TTSRequest)` 返回已下载的音频 bytes 与来源元数据；`produce_audio` 将其保存为项目资产并生成清单。TTS 只用于离线制作，App 运行时不调用合成接口。
- 稳定错误使用 `ProviderError.code/retryable`；API 层按中英文给出重试、改文字或按钮的提示。原始服务错误体、密钥、带签名 URL 不进入错误消息。
- ASR 总预算 12 秒、理解总预算 8 秒、TTS 制作含下载总预算 30 秒。HTTP 超时/限流/服务不可用映射稳定类别；ASR/TTS 不自动重试、不切换供应商。理解仅对不合格 JSON 做一次有限重试，不对鉴权/网络失败重复计费请求。
- 前端取消及迟到结果不可改变状态由会话/请求层控制；适配器保持异步取消语义，不将取消异常转换成成功。

当前音频验证实际解码 **PCM16 WAV**（单/双声道、8–48 kHz），最大 3 MiB、20 秒；空文件、伪后缀、截断数据、超长文件拒绝。WebM、AAC 等格式返回 `unsupported_format`，不能只相信 MIME 或用户传入的时长。前端已将浏览器录制结果在本机解码、转换为单声道 16 kHz PCM16 WAV 后再上传；服务端只接收转换后的严格格式。浏览器的格式支持、解码及录音全链路仍需实际设备验证，本批次不宣称跨浏览器真实录音链路完成。

## 可执行检查与手动真实 smoke

在仓库根目录，使用已安装后端依赖的环境运行：

```sh
backend/.venv/bin/python scripts/speech.py config
backend/.venv/bin/python scripts/speech.py tts-check --text-id E08
PYTHONPATH=backend backend/.venv/bin/python -m pytest backend/tests/test_providers.py -q
```

`config` 仅本地读取；`tts-check` 只检查内容包和审核记录。当前 E08 尚未语言批准，预期返回 `language_review_required`、退出码 2；不发送网络请求，不生成音频。

以下为后续手动复核入口。真实小额诊断的执行方式与结果另记于文末；运行这些入口仍需在服务端设置对应凭据与 enable 开关，命令还要求 `--allow-paid-call`，防止误把配置检查变成付费试跑。

```sh
backend/.venv/bin/python scripts/speech.py asr-smoke --audio /absolute/path/to/private-sample.wav --allow-paid-call
backend/.venv/bin/python scripts/speech.py llm-smoke --allow-paid-call
backend/.venv/bin/python scripts/speech.py tts-generate --text-id E08 --speed normal --allow-paid-call
```

ASR smoke 默认仅输出转写字符数、请求标识和耗时，原文需显式 `--show-transcript` 才显示；不会复制原录音到 Git。真实结果应人工核对数量、否定、修改等关键语义，记录实际地区/模型/费用与异常，再进入后续批次验收。

## 语言审核与生成资产

CLI 只从仓库 `content/` 内的内容包取 `hanzi`，没有任意文本参数。表达、店员台词及支持词均按 ID/版本查找；来源为 `content/batch-a.json`，审校账本为 `content/reviews.json`。

开始制作必须满足：语言状态已批准、至少两个不同且标记为流利使用者的真实 reviewer、批准记录与同一内容 ID/版本绑定、引用批准记录、`subjectSha256` 与当前原文/释义/分段/变体一致、没有后续未解决修改意见。即使版本号未升级，改动文字也会使旧批准失效。任何候选或空原文都拒绝。审核身份及结论必须由真实审校补入；测试中的 mock reviewer 只存在于单元测试内。

生成结果保存 `artifacts/audio/<generationId>.wav` 和同名 JSON，目录/文件限制为本地访问。生成 ID 由文字、版本、模型配置、声音配置和速度共同计算；同一任务已存在时不覆盖、不重复调用；同一生成任务用独占 lock 防止并发重复计费。进程意外退出可能留下 lock，需核对实际资产后人工清理，不能自动重试计费。清单记录 SHA256、实测时长/采样率、目标语种、实际提供商参数、模型/声音、原文校验、生成时间与语言审校引用；新音频始终 `status:pending`、`listeningReview:pending`、`reviewIds:[]`。

批次 A 的 `qwen3-tts-flash` 适配器不宣称支持慢速指令，`--speed slow` 返回 `unsupported_speed`。后续可增加明确记录参数的保音高处理或经验证的模型能力，并对慢速独立听审。不能重复保存常速文件来伪造慢速资产。

听审通过后再将对应资产导入内容包，维护文件路径、SHA256、听审记录及发布审核；制作 CLI 不自动更改教材批准状态或对外发布素材。

## 本批次核验记录

- 初始实现阶段仅检查是否配置凭据，当时均未设置，故只执行 mock 测试。用户随后填写共享 key 并授权真实诊断；当前状态与调用记录见下节，密钥值未输出。
- 所有提供商测试明确使用 `httpx.MockTransport`：请求合约、原转写保留、秘密不回传、限流/鉴权/超时、坏 JSON 的有限重试、音频解码约束、双人审校拒绝、临时 URL 下载与 SHA256、默认待听审和重复生成保护。
- 当前内容包首批候选的 TTS 制作资格检查被正确拒绝，仍等待真实双人语言审校及参考读法。
- 尚待验证：Jada 上海话自然度、真实上海话/初学者录音关键字段可靠性、更多场景与设备下的费用/延迟、常/慢速双人听审及真语音南翔全链路。


## 用户授权后的真实技术诊断（2026-10-17）

执行时间为 America/New_York 13:51–13:53。只读取根 `.env` 中的相关配置，未输出凭据值、未修改其中的 key。真实调用仅在诊断进程内启用，根 `.env` 的总开关仍为 `false`。诊断脚本、预算、原始/修复后音频和逐次脱敏结果保留在 Git 忽略的 `artifacts/local/speech-diagnostics/`；这些文件不是教材、不进入内容包、没有任何语言或听审批准。CLI 现也读取根 `.env`，环境中已设的变量优先。

预算采用官方北京地区目录价，不假定有免费额度：Qwen-Plus 非思考短输入每百万输入 Token 0.8 元、输出 2 元；ASR 每秒 0.00022 元；TTS 每万输入字符 0.8 元。事前保守预算低于 0.10 元，没有购买或部署资源。[Qwen-Plus 价格](https://help.aliyun.com/zh/model-studio/qwen-plus)、[ASR 价格](https://help.aliyun.com/zh/model-studio/qwen3-asr-flash)、[TTS 价格](https://help.aliyun.com/zh/model-studio/qwen3-tts-flash)。

| 调用 | 实际结果 | 服务耗时 | 上游请求 ID | API 返回用量 |
| --- | --- | --- | --- | --- |
| Qwen-Plus 完整句 `Two servings to take away, please.` | quantity=2、unit=serving、takeaway=true，原文证据齐全 | 3544 ms | `chatcmpl-b60fa81f-7fef-9c40-abcf-d6c0ced51c90` | 输入 344 / 输出 113 Token |
| Qwen-Plus 缺项句 `Two, please.` | 只返回 quantity=2，没有臆补单位或外带 | 2007 ms | `chatcmpl-e95be17f-646f-910f-8c15-f3e379f20b09` | 输入 340 / 输出 43 Token |
| Qwen-Plus 修改句，修复前 | `Not three. Two servings, and not takeaway.` 返回 quantity=2、takeaway=false，漏掉本轮明确说出的 unit；**不满足原验收预期** | 2878 ms | `chatcmpl-47c72146-3891-90f5-8740-0d63611ccffb` | 输入 364 / 输出 84 Token |
| 同一修改句，修复后 | quantity=2、unit=serving、takeaway=false，均有本轮证据，满足原预期 | 3437 ms | `chatcmpl-638fdeab-30ed-9210-aefd-19409b69e40f` | 输入 400 / 输出 112 Token |
| ASR 合成英文 | macOS Samantha 本机合成 2.229 秒 PCM16/16 kHz 单声道；返回完整原句 `Two servings to take away, please.`，language=en、confidence=null | 2628 ms | `chatcmpl-6ba36622-8728-9946-958e-0a2054580fe7` | seconds=2，输入 55 / 输出 15 Token |
| Jada 英文 `Hello.` 首次 | HTTP 200，下载完成，但占位 WAV 长度触发严格校验失败；未发布素材 | HTTP 1219 ms；含下载 2573 ms | `1442b050-326a-93ef-b59f-e4eeaf88a7d7` | 6 字符 |
| 同一 Jada 诊断重试 | HTTP 200，保存原始文件；离线确认并修复 WAV 头后为 560 ms、24 kHz 单声道 PCM16 | HTTP 1378 ms；含下载 2638 ms | `98973fde-2b48-9deb-8de2-4a586132edc9` | 6 字符 |

实际共有 **7 次模型请求**（4 LLM、1 ASR、2 TTS）；另一次最初因运行环境网络限制失败，未获得上游响应，单独记录为连接失败。四次 LLM 合计输入 1448 / 输出 352 Token，ASR 返回 seconds=2，TTS 合计 12 字符。按上述 API 返回用量及目录价估算约 **0.0032624 元**，不等同于账单扣费；未读取账户账单或免费额度，实际计费舍入以提供商为准。以上延迟仅为少量诊断观测，不能据此声称达到产品延迟指标。

真实诊断带来的修正：

1. 后端规则会在数量修改且缺单位时清除旧单位，以免错用此前订单。保留这一规则，将模型提示改为：数量出现时，必须同时抽取本轮明确说出的单位，即使该单位与旧值相同；未说出的单位仍不得从旧订单继承。保留失败记录并用同一句重跑通过，没有放松预期。
2. 实际 Jada 文件有标准 44 字节 PCM WAV 头，但 RIFF/data 长度分别为 `0x7fffffbf` / `0x7fffff9b` 占位值；真实文件仅 26924 字节。新增 `finalize_generated_wav`，仅对这组已观测的供应商占位头按实际完整 body 收尾，PCM 样本不变；普通上传仍执行严格校验，不因这项修复接受截断文件。来源及修复后 SHA256、处理方式写入元数据。真实样本经离线修复后 SHA256 为 `b9d3e3ada60288aa13f465bb8cb1c4b0f49819283461217de3067dbfb3d91423`。
3. 适配器版本升为 `qwen-http-v2`，配置 ID 随之变化。已开始会话不热切配置，新配置用于新会话。新增 WAV 占位头及截断拒绝用例后，提供商测试 31 项通过；当时后端全套 75 项通过，测试环境强制关闭 live，不产生额外模型请求。

本地交接配置：北京地区这三个初选模型已对当前共享 key 返回成功响应；随后在用户本地 `.env` 单独启用了 `QWEN_ASR_ENABLE_LIVE=true`，总开关仍为 false，示例配置保持默认关闭；文字理解仍需显式选择 `TEXT_INTERPRETER=qwen`，不能因配置 key 就悄悄替换开发解析器。当前教材的语言审核仍未完成，教学 TTS 制作门槛保持拒绝；英文 Jada 诊断的成功不证明上海话读音合格，也没有验证常/慢速教材。全量真实上海话语料、手机录音及完整任务验收继续留待后续工作。
