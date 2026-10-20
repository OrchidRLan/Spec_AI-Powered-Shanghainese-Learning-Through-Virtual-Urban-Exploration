# 四站 API（账号、临时游客与生产配置）

Python 3.11+，FastAPI + SQLite。开发时数据库在本机；生产时必须将其放在后端的持久磁盘。配置实现不表示实际部署或验收已完成。

```sh
cd backend
python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
# 另一终端运行根目录前端；/api 经 Vite 同源代理。
.venv/bin/python -m pytest
```

默认数据库 `backend/data/app.db`，可通过 `DATABASE_PATH` 改到独立目录。后端自动加载根 `.env`，不覆盖进程已有环境变量；配置修改后重启后端。数据库、录音、日志、虚拟环境都不提交。Cookie 为随机 256 位 token（数据库只保存哈希），`HttpOnly; SameSite=Strict`；生产额外要求 `Secure`。返回的 session ID 不是访问凭证。写请求检验 Origin / Fetch Metadata 并要求 JSON（ASR 除外）。ASR 已有会话每分钟 30 个请求的上限。

## 生产运行边界

| 环境变量 | 开发默认值 | 生产要求 |
| --- | --- | --- |
| `APP_ENV` | `development` | `production`；其他值启动失败 |
| `DATABASE_PATH` | `backend/data/app.db` | 显式绝对路径，部署配置负责挂载持久磁盘，例如 `/var/data/app.db` |
| `COOKIE_SECURE` | `false` | 必须为 `true` |
| `ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | 显式 HTTPS 前端源，逗号分隔；无路径、凭据或通配符。不自动允许请求 Host 或预览域名 |
| `BACKEND_PROXY_SECRET` | 不使用 | 至少 32 位无空白 ASCII 随机秘密；只在 Vercel 代理函数和 Render 后端环境中配置 |

Vercel 以同源 `/api` 服务前端，服务端代理转发至 Render。生产后端除 `GET/HEAD /api/health` 外，均要求 `X-Shanghai-Proxy-Secret` 与配置值恒定时间比对成功，并要求 `X-Shanghai-Client-IP` 为单个有效 IP。代理必须覆盖这两个请求头，客户端 IP 从 Vercel 可信元数据取得；不能转发浏览器自报的 IP 或秘密。IPv4 映射的 IPv6 地址归一到同一限流桶。后端不依赖 `X-Forwarded-For`，部署启动使用 `--no-proxy-headers`；无秘密或 IP 格式错误返回 `403 proxy_required`。生产写请求还必须带允许的 `Origin`，保留浏览器的 `Sec-Fetch-Site` 检查，不由代理伪造一个始终通过的 Origin。

`GET/HEAD /api/health` 检查数据库连接和表可访问，返回运行模式及内容／规则版本；数据库不可用返回 503，不返回数据路径、密钥或账号信息，不调用任何模型服务。生产关闭 `/docs`、`/redoc`、`/openapi.json`。新会话和创建事件记录实际 `production` 模式，旧会话模式不被重写。

首次部署使用空数据库，由既有事务初始化创建表；重启与升级保留已有账号和进度。挂载路径、备份／恢复、游客清理、平台限额和实际 HTTPS 检查仍需按部署计划落实，配置校验本身不能证明磁盘已经持久挂载。

## 认证与临时进度

本轮身份独立于已有学习 session。账号使用 `shanghai_account` HttpOnly / SameSite=Strict Cookie，服务器令牌与浏览器均最长 30 天；退出撤销当前令牌，不清空账号进度。游客使用 `X-Guest-Token` 请求头，前端只存标签页 `sessionStorage`，最长 24 小时。数据库只存两类随机令牌的 SHA-256 摘要。用户名按 trim + casefold 唯一，显示保留大小写；3–24 位 ASCII 字母、数字、下划线。规范化的 `users.username_key` 是数据库 `NOT NULL PRIMARY KEY`，并使用 `NOCASE` 排序规则约束大小写重复；原 `users.id` 保留为 `NOT NULL UNIQUE`，继续承接令牌和学习会话的外键。已有数据库启动时事务迁移主键，保留账号 ID、密码摘要、令牌与进度；迁移失败回滚，不重置数据。密码 8–128 字符，不要求字符种类，空格不裁剪，随机盐 scrypt `N=32768,r=8,p=3`，不存明文。

```ts
type AuthState = {
  mode: 'signed_out' | 'guest' | 'account';
  user: {username: string} | null;
  session: Session | null;
  legacy_available: boolean;
};
```

| 接口 | 请求 | 返回 |
| --- | --- | --- |
| GET /api/auth | 可选账号 Cookie / 游客头 | AuthState；旧匿名 Cookie 不自动登录，只报告 legacy_available |
| POST /api/auth/guest | `{locale?: 'zh'|'en'}` | AuthState + guest_token；不签发长期匿名 Cookie |
| POST /api/auth/register | `{username,password,locale?,import_legacy?:boolean}`，可带游客头 | 注册并登录，AuthState；承接当前游客进度 |
| POST /api/auth/login | 同上 | AuthState；恢复账号并事务合并当前游客进度 |
| POST /api/auth/logout | `{}`，附当前 X-Expected-Session-ID | 撤销当前令牌，返回 signed_out；保留账号数据 |

课程 API 的身份优先级为显式游客头 → 有效账号 Cookie → 旧匿名 Cookie。**带了无效/过期游客头时返回 `guest_expired`，不得回退到同浏览器账号。** 普通欢迎界面不调用旧匿名 `/session` 恢复；只有用户明确勾选 `import_legacy`，登录/注册才导入其持有的旧 Cookie 数据。旧匿名记录不会自动删除。

前端在恢复身份后，所有课程 API、原始 ASR 上传与私有糖店音频携带 `X-Expected-Session-ID`，其值为当前显示的 Session.id。服务器将它与实际凭据绑定比对；不一致返回 401 `session_changed`，防止另一标签切换账号后把旧页面操作写入新账号。登录/注册/游客入口与 GET /auth 不受此绑定限制；退出会比对。为了已有 API/旧匿名兼容，未提供该头的请求仍使用其实际凭据授权，但正式前端不得省略。私有音频必须带头 fetch 为 Blob 后播放，令牌不放 URL。

合并在同一 SQLite 事务中移动尝试、事件、ASR 与使用记录；课程版本先固化到每条 attempt。合并保留历史成功和所有练习记录，撤销来源游客/旧匿名凭据，并留下账号来源归属。不同课程版本或会话内请求 ID 冲突返回 `merge_conflict`，两边原记录均不改变；旧版可单独关联新账号后通过原有升级入口继续。仍在处理的请求返回 `merge_in_progress`，完成后可重试；超过 30 秒的未完成 ASR 先存为 `asr_interrupted` 终态，避免进程重启后永远不能保存。旧版 turns 的 processing / prepared 同样以 30 秒为界：近期请求仍阻止合并，超时请求记录为 cancelled，只清除匹配的 pending_request_id；原始 payload、解释和记录保留，不自动应用订单。取消状态阻止迟到解释重新写成 prepared 或推进订单。迟到云端结果不能覆盖终态。ASR 上传完成和云端返回时重新核验身份；退出后的转写被丢弃，不改变练习进度。

服务端 SQLite 限流：登录每用户名 10 次 / 15 分钟、每来源 IP 50 次 / 15 分钟；注册每 IP 15 次 / 小时；游客创建每 IP 50 次 / 15 分钟。生产来源 IP 只取上述通过秘密校验的代理头；开发模式使用直接连接地址，忽略自报代理头。账号不存在与密码错误统一 `invalid_credentials`。常用错误还包括 `invalid_username` / `invalid_password` (422)、`username_taken` (409)、`auth_rate_limited` (429)、`legacy_unavailable` (409)、`session_required` / `guest_expired` / `session_changed` (401)。

每次 API 请求惰性清理到期游客及其所有关联尝试、请求、事件与 ASR 数据，不清理旧匿名或账号记录。无访问时可从 backend 目录执行下列命令；部署时将其纳入定时维护：

```sh
.venv/bin/python -m app.cleanup_guests --database /absolute/path/to/app.db
```

命令不会加载语音服务或读取 `.env`；不传参数时采用进程 `DATABASE_PATH` 或默认 backend/data/app.db。数据库初始化仅新增认证/归属表，不改写已有会话数据。账号升级旧课程会保留 account_sessions 归属记录；游客升级不延长原 24 小时窗口。关闭页面不能可靠通知服务器，24 小时是凭据有效期上限；实际数据在后续 API 请求或清理命令中移除，无访问时不能保证准点物理删除。浏览器恢复标签页可能恢复游客凭据。

## 接口

| 接口 | 请求 | 返回 |
| --- | --- | --- |
| GET/HEAD /api/health | 无，生产允许直接健康检查 | mode/content_version/rule_version；数据库不可用返回 503 |
| GET /api/session | 当前身份 | 恢复 Session；没有身份返回 401，不再自动创建匿名 Cookie |
| PATCH /api/session | locale?: zh/en, show_romanization?: bool, reduced_motion?: bool | Session |
| POST /api/session/new | 当前身份；JSON `{}` | 明确升级旧课程时创建 Session；账号更新当前绑定，游客沿用原 token 与到期时刻，旧匿名才替换 Cookie；保留偏好与旧记录 |
| GET /api/services | 无 | asr.enabled/formats/config；text.mode=development_parser |
| GET /api/content | 当前身份 | 会话绑定的当前内容包或历史归档包；不会自动回退到其他版本 |
| POST /api/attempts | station_id: nanxiang/restaurant/candy/teahouse, restart?: bool | Attempt；未完成时恢复，同一请求重试不重复创建。已完成时 restart:true 才新建 |
| GET /api/attempts/{id} | 当前身份 | Attempt |
| POST /api/attempts/{id}/practice | PracticeInput，仅 R3 | PracticeResult；保存本题选择/评估或显式推进 |
| GET /api/attempts/{id}/practice/{request_id} | 当前身份 | 原始 PracticeResult；未知 404 |
| POST /api/attempts/{id}/practice/{request_id}/cancel | expected_revision | 已保存结果或取消 tombstone，保护迟到原请求 |
| POST /api/attempts/{id}/lesson | LessonInput，仅 B+C 三站 | PracticeResult；保存选择、评估、明确继续、编辑或听辨接触 |
| GET /api/attempts/{id}/lesson/{request_id} | 当前身份 | 原始 PracticeResult；未知 404 |
| POST /api/attempts/{id}/lesson/{request_id}/cancel | expected_revision | 原始结果或取消 tombstone |
| GET /api/attempts/{id}/introduction/audio | 当前身份；仅本人糖店尝试 | 版本、原文、注音与文件哈希核验后的 WAV；不发送目标文件名 |
| POST /api/attempts/{id}/turns | TurnInput | TurnResult |
| GET /api/attempts/{id}/turns/{request_id} | 当前身份 | TurnResult；未知 404 |
| POST /api/attempts/{id}/turns/{request_id}/cancel | expected_revision | TurnResult；支持取消先于原 POST 到达 |
| POST /api/attempts/{id}/skip | expected_revision | Attempt；取消在途回合，不覆盖成功 |
| POST /api/events | event_id, attempt_id?, event_type, metadata? | saved, duplicate；不更新订单字段 |
| GET /api/events | 当前身份 | 仅自己会话的事件 |
| POST /api/asr | 原始 PCM16 WAV；Content-Type:audio/wav，X-Request-ID | {text,transcript,status,elapsed_ms,config_id,...}，转写本身不推进任务 |

```ts
type Order = {
  item: string | null;
  quantity: number | null;
  unit: 'serving' | 'basket' | 'piece' | 'pack' | 'unknown' | null;
  normalized_servings: number | null;
  takeaway: boolean | null;
};
type Attempt = {
  id: string; station_id: 'nanxiang'|'restaurant'|'candy'|'teahouse';
  content_version: string; rule_version: string;
  status: 'collecting'|'confirming'|'completed'|'skipped';
  revision: number; order: Order; unresolved_issues: string[];
  summary_revision: number|null; confirmed_revision: number|null;
  prompt_id: string; pending_request_id: string|null;
  metrics: {voice_attempts:number;help_used:number};
  unit_convention_seen: boolean; turns: Turn[];
  practice?: Practice; // 仅 R3，历史版本没有此字段
  lesson?: Lesson; // B+C 三站，南翔继续使用 practice
  created_at:string; updated_at:string;
};
type TurnInput = {
  request_id:string; expected_revision:number; channel:'buttons'|'text'|'voice'|'voice_edited';
  action?: {type:'set_order';item?:string|null;quantity?:number|null;
    unit?:Order['unit'];takeaway?:boolean|null} | {type:'confirm'|'repeat'};
  text?:string; summary_revision?:number; asr_request_id?:string;
};
type TurnResult = {request_id:string;status:'applied'|'pending'|'cancelled'|'failed';
  attempt:Attempt;interpretation_source:string|null;
  speech_feedback?: {outcome:'accepted'|'retry';
    reason:'understood'|'unrecognized'|'needs_clarification'|'repeat_requested'|'confirmation_required'}};
type Session = {
  id:string;locale:'zh'|'en';show_romanization:boolean;reduced_motion:boolean;
  mode:'development'|'production';content_version:string;rule_version:string;
  model_config_id:string;asr_config_id:string|null;created_at:string;attempts:Attempt[];
  completed_station_ids:string[];
  lesson_content_version?:string;lesson_rule_version?:string;
  services:{text:'development_parser'|'qwen';asr:'unconfigured'|'configured'};
};
```

## B+C：三站固定问题

南翔和基础会话继续绑定 R3 内容与规则；第一次开始 B+C 站点时，为当前 R3 会话追加 `lesson_content_version=batch-bc.2026-10-17.v1`、`lesson_rule_version=station-lessons.v1`。三站 Attempt 分别绑定这两个版本，不重置南翔进度。旧 R1/R2 会话与未知扩展绑定不静默迁移，返回 `lesson_version_required`；已有尝试按原绑定恢复。`/turns` 和 `/practice` 不能绕过新站规则。

```ts
type Lesson = {
  step:string;step_id:string;target:string|null;can_choose:boolean;
  result:Practice['result'];answers:Record<string,string>;
  history:Array<{step:string;step_id:string;option_id:string;assisted:boolean;
    result:Practice['result'];revision:number}>;
  listening:null|{audio_url:string;played:boolean;text_revealed:boolean;
    introduction_text_id:string|null};
};
type LessonInput = {
  request_id:string;expected_revision:number;
  operation:'select'|'evaluate'|'continue'|'edit'|'listened'|'help';
  option_id?:string; // select
  text?:string;asr_request_id?:string;failure_kind?:'recognition'|'technical'; // evaluate
  assisted?:boolean;result_request_id?:string; // continue
  step?:string; // edit
};
```

| 站点 | 固定步骤 | 本题选项 |
| --- | --- | --- |
| restaurant | preference → recommendation → dish → confirm | not_spicy；recommend；fish/chicken/tofu；confirm |
| candy | flavor → quantity → confirm | rose/osmanthus/mint；two_packs；confirm |
| teahouse | appreciation → thanks | good_tea；thanks |

- 所有步骤均先选目标、再识别核对、结果停留；`continue` 才写入 `answers`。前置选择、播放台词、展示推荐均不冒充用户回答。最终 `confirm` 的目标自动设为 `confirm`，仍需语音尝试或技术回退后明确继续；茶楼的 thanks 明确继续直接保存完成，不生成订单核对。
- 新三站使用有限的 `station-target-check.v1`，对原始转写做目标表达核对，另外执行任务约束。豆腐为辣菜，不能完成不辣任务；糖店口味必须匹配服务端固定目标。因此清楚说出不合任务的预选项会返回 `incorrect/task_mismatch`，辅助继续同样不能绕过任务约束。用户可以重选与练习，不产生追问。
- 南翔与新三站的每次核对都附带 `scoring`（`lenient-rules.v1`）：先按原文核对，失败时再去掉语气词与重说后复核；停顿、重复、同音变体记为 0 分扣减，内容错误记为关键错误并强制 `retry`。分数仅供内部分析，界面不展示，详见 [宽松评分说明](../docs/engineering/Scoring-system.md)。
- 双重否定、错对象、转述／引用、数量冲突和询问不按关键词误记为目标完成。有限语义核对不是任意自由对话理解或逐字发音评分。全部教材选项均有原句回归；不修改保存的 ASR 原文。
- 糖店每次尝试随机分配一个固定口味，刷新、切语言、重播、错误选择和恢复都不改变。私有目标不会出现在 Attempt、Session、错误、幂等快照或日志中；音频通过无口味标记的私有 URL 发送。`listened` 需先成功取得该尝试的音频，且由播放器正常结束后调用；服务端把结束事实记录为 `reported_by:client`，不称为已听懂。音频下载、播放失败、取消、仅打开词卡均不算已听。
- `help` 是明确查看介绍文字，保存不可撤销的曝光记录，之后才返回对应 `introduction_text_id`。完整播完或使用文字帮助后才能核对/继续口味题。音频缺失或身份校验失败返回 503，文字帮助仍可完成任务。
- `edit` 只能从餐厅／糖店确认题回到之前的既定步骤，清除该步及后续已提交答案、旧结果和确认版本，开始新 `step_id` 并重新先 Speak。过去回答保留在 history；新的确认只依据最新有效答案。完成后修改被拒绝，重练产生新尝试。
- 评估的原文绑定、ASR 一次消费、故障原文恢复、结果 ID、幂等与取消和原子保存与南翔相同；同一 ASR 也不能跨南翔和新三站重复消费。响应丢失可查询或取消原请求，客户端必须按 revision 防止原快照覆盖后续状态。保存失败不会记录完成、消耗 ASR 或留下半条历史。

## 修订 3：固定练习与手动继续

新会话绑定 `batch-a-r3.2026-10-17.v1`、`nanxiang-rules.v3`。R2、R1、原基线会话按其原内容快照和规则继续恢复；不静默迁移。R3 禁止通过旧 `POST /turns` 直接修改订单，返回 `guided_practice_required`；旧版本使用 `/practice` 返回 `practice_version_required`。版本变化后仍由用户明确选择新探索。

```ts
type Practice = {
  step: 'item'|'quantity'|'mode'|'confirm'; step_id: string;
  target: TurnInput['action']|null;
  result: null|{request_id:string;transcript:string|null;
    status:'correct'|'incorrect'|'unrecognized'|'technical';reason:string;
    channel:'voice'|'technical';reported_by:'server'|'client';
    asr_request_id:string|null;interpretation_source:string|null;
    scoring:Scoring};
  can_choose:boolean;
};
// Internal only; the UI does not display it. See docs/engineering/Scoring-system.md.
type Scoring = {version:'lenient-rules.v1';profile:'lenient'|'standard'|'strict';threshold:number;
  score:number|null;verdict:'pass'|'retry'|'rerecord'|'unavailable';capped:boolean;
  deductions:{type:string;points:number;span:string|null;uncertain:boolean}[]};
type PracticeInput = {
  request_id:string;expected_revision:number;
  operation:'select'|'evaluate'|'continue'|'edit';
  action?:TurnInput['action']; // select only
  text?:string;asr_request_id?:string;
  failure_kind?:'recognition'|'technical'; // evaluate only
  assisted?:boolean;result_request_id?:string; // continue only
  step?:'item'|'quantity'|'mode'; // edit only
};
type PracticeResult = {request_id:string;status:'applied'|'cancelled';attempt:Attempt};
```

- `select` 只保存本题合法目标、清空旧结果；不写订单。商品只能 `xiaolongbao`，数量为 1–20 和 `unit:'serving'`，方式为布尔值。每次只能提交本题字段，不能选择一个包含全部订单字段的目标。最终题默认目标 `{type:'confirm'}`。
- `evaluate` 携带本会话保存的 ASR ID 和完全相同的原转写 `text`；服务端独立核对，不信任客户端正确标志。不改订单、问题、状态、摘要或完成列表，只保存结果。原文始终保留，空转写为 `unrecognized/no_speech`；有文字但不理解为 `incorrect/not_understood`。返回结果后前端必须停留。
- 故障使用 `evaluate` 的 `failure_kind`，不能同时提交 `text`；存在 ASR 失败 ID 时服务端按已保存错误区分无语音和技术故障。浏览器技术超时所带 ID 若仍 pending/尚未建立，保存 `reported_by:'client'` 的真实技术空态并开放回退；若后台其实已成功，就从服务端读取原转写核对并显示结果。没有 ASR ID 的设备/浏览器失败同样标为 client，原文为空；不能伪记为后端识别证据。技术故障为 `technical`，不是错误发音；晚返回的 ASR 不会覆盖已保存结果。
- `continue` 正常推进必须携带当前正确结果的 `result_request_id`。错误、无语音或技术故障后 `can_choose=true`，用户明确选择 `assisted:true` 才用当前目标推进；增加帮助计数并记录辅助继续，不变造原语音结果。失败后改选新目标会清结果但保留本题回退资格，此时辅助继续可不带结果 ID；若提供结果 ID 就必须匹配当前结果。
- 进入下一题才替换 `step_id` 并重置目标/回退资格；本题选择、评估、刷新保持 `step_id`。固定问题仅为 `NX-N01 → NX-N02 → NX-N03 → NX-N09`，结束为 `NX-N10`。额外字段不能跨题推进，没有单位、商品、越界等临时追问。
- `edit` 仅从最终核对返回指定既定题，立即使旧确认摘要失效。原订单先保留，评估仍不修改；点击继续才应用新字段并回到核对。新的编辑题重新要求先尝试语音，其失败/结果可跨刷新恢复。
- `revision` 包含选择、结果与推进的状态变化；`summary_revision` 在进入核对题时固定，不因该题选择/评估而失效。确认结果也必须停留，明确 `continue` 保存成功才完成；辅助确认同样必须显式点击。

核对来源为 `guided-target-check.v1`，不调用自由对话 LLM，也不是声调或逐字发音评分。数量题允许纯数字、常见词和有限的“分→份”同音误写；判定用的替换不改原文。显式只/笼/个等不同单位、范围、分数、时长、冲突、否定给当前结果卡不正确，不启动新问题。R3 对否定表达采用保守边界，不会因提及目标字词就判通过；它不承诺理解任意自由修改句。

结果原因：`target_matched`、`ambiguous_expression`、`target_mismatch`、`quantity_mismatch`、`mode_mismatch`、`item_mismatch`、`unit_mismatch`、`confirmation_mismatch`、`not_understood`、`no_speech`、`device_or_service_unavailable`、`asr_failed`。这些稳定代码由前端按语言呈现，服务端不拼写用户文案。

所有练习操作的状态、事件、幂等响应在一个 SQLite 事务写入，不产生需要重新付费处理的 pending。重复相同 ID/负载返回原结果；同 ID 不同负载返回 `idempotency_conflict`，旧 revision 返回最新 Attempt 和 `stale_revision`。保存失败回滚所有变更和 ASR 消费标记，可查询原 ID，再重试原负载。取消未知 ID 建立 tombstone，迟到 POST 返回 cancelled；取消已完成的操作返回其保存结果，不撤销既成推进。

同会话同一 ASR 结果只能被一次练习评估消费（同一请求 ID 的幂等读取例外），跨题或不同请求再次使用返回 `asr_result_already_used`。前端录音回调仍需绑定录制时的 attempt/step/目标/revision，离开、取消、改选后的迟到回调应丢弃，不能拿最新 revision 重新包装旧录音。客户端故障回退是教学策略，不是声学准确性或安全认证证明。

## 原基线／修订 1／修订 2 的历史回合合同

以下 `/turns`、自由字段解析与澄清规则只描述保留的历史版本，不用于 R3 主流程。

提交 `set_order` 的字段必须实际表达；未出现字段保留，null 明确清空，false 真实堂吃。R2 完成条件为小笼、有效 1–20 份、明确堂吃或外带和独立确认；不再强制两份或外带。数量变更必须携带单位，不从旧订单偷用单位。新数量/单位/商品/方式及无效修改先让旧摘要失效；同轮文字里的“对”不能确认尚未展示的摘要。随后独立提交 `confirm`，带已展示的 `summary_revision`。每次请求使用新的 request_id（8–100 位字母/数字/`_`/`-`）；网络重试复用相同 ID 与完全相同负载。重复已应用回合返回原始保存结果；若之后已有新进展，前端应按 revision 防止旧结果覆盖当前状态，必要时 GET attempt。

`POST /api/session/new` 只供用户明确点击“开始新的探索”并确认后调用，不在配置冲突或普通刷新时自动调用。它保留当前语言、注音显示及减少动态偏好，为新会话绑定当前内容/规则/模型配置，并返回空 attempts 与完成列表。旧会话、已保存尝试和成功记录留在数据库中，既不删除也不转入新会话；新 Cookie 没有访问旧会话的权限。前端应先取消在途任务并清空旧会话的本地草稿/请求状态，防止迟到界面结果覆盖新探索。

修订 2 新会话绑定 `batch-a-r2.2026-10-17.v1` 和 `nanxiang-rules.v2`。R1 会话保留 `batch-a-r1.2026-10-17.v1`，基线会话保留 `batch-a.2026-10-17.v1`，分别从 `content/versions/<原版本>.json` 读取原内容；缺失、未知或文件内版本不匹配时返回 `content_version_unavailable`，不能用新文案静默替换旧包。规则也按 Attempt 原绑定分派：`nanxiang-rules.v1` 仍要求两份外带，不会因上线 R2 静默完成旧任务。所有 Attempt 响应附所属 `content_version/rule_version`；早期记录缺这些字段时从其原会话补充，读取本身不迁移数据库。历史回合的缓存响应仍是当时的订单和修订，附原版本，不替换成最新订单。

R2 界面只呈现语音与按钮，后端仍保留 `text`、`voice_edited` 数据结构、历史读取和已提交请求的幂等结果。旧成功、旧文本、ASR 原转写及编辑文本不删除或改写。当前静态界面若只带 R2 包，遇旧会话应说明版本差异并提供用户主动“开始新的探索”入口，不把旧进度标为新内容下的结果。

允许事件：`expression_opened`, `expression_inserted`, `unit_explanation_viewed`, `recording_started`, `recording_stopped`, `recording_cancelled`, `recording_played`, `recording_permission_denied`, `asr_submitted`, `asr_succeeded`, `asr_failed`, `asr_cancelled`, `audio_started`, `audio_ended`, `audio_interrupted`, `pronunciation_support_changed`, `input_channel_changed`, `station_entered`, `assistance_recorded`, `logging_gap`。只在真的展示“一笼示意对应一份”后发 `unit_explanation_viewed`；之后提交的 basket 单位才可归一。事件不能直接完成订单。录音权限拒绝不能发 `recording_started`。客户端 ASR 与回听事件只是 UI 诊断，后端强制记录 `reported_by:client`，不会增加语音尝试、帮助、成功或完成计数；真正识别结果由服务端单独记录 `asr_finished`（`reported_by:server`），客户端不能提交该事件。

HTTP 409 的 `detail={code,message,attempt?}` 表示冲突；刷新 attempt 并展示最新版本。422 为请求校验失败；503 表示服务或保存失败。保存失败时不得显示完成；先查询原 ID，再用原负载重试。已准备的解释会落盘，最终事务失败后可重试提交而不重新解释；状态、完成事件与结果在同一事务保存。进行中的解释可取消；崩溃后遗留 pending 可查询并取消，再以新 ID 提交。

解释失败会终结该回合并返回 `detail.terminal=true`，明确重试时生成新 ID；这与保存失败和网络未知结果的原 ID 重试不同。页面刷新后也要根据 `attempt.pending_request_id` 展示查询/取消入口，不能只依赖内存中的请求对象。

R2 中用户主动结束录音后由前端自动转写，并自动提交 `channel:'voice',text,asr_request_id`，不再要求手动发送录音和“使用这句话”。原转写可只读查看；旧客户端及历史的 `voice_edited` 兼容结构保留。ASR ID 必须属于当前会话，原转写从服务端保存结果读取；`voice` 文本必须完全匹配原转写，前置练习选择不能替换这份证据。回合分别返回 `asr_transcript` 与 `text`，不把编辑后的内容伪记为识别结果。ASR 出错返回稳定 `detail.code/retryable/terminal`；空转写返回 `detail.code='no_speech'`。只有终结失败重新试才换 ID，未知结果仍复用原 ID。转写处理超过 30 秒的未知请求允许用户明确开始新请求；不会自动重调模型。

已应用的 `voice` 回合增加 `speech_feedback`，与订单和幂等响应同时保存。`accepted` 表示表达已理解，不代表已完成或发音正确；清楚的否定/合法修改为 `understood`，请求重说为 `repeat_requested`，尚未展示摘要的确认是 `confirmation_required`。无法识别语义返回 `retry/unrecognized`，字段歧义或数量/单位等规则问题为 `retry/needs_clarification`。这些不是逐字发音评价。前端据 `retry` 开放本题按钮回答，并区分没理解与内容需澄清；正常帮助请求和无进展的明确表达不伪记为语音失败。ASR/麦克风/服务故障也允许前端回退，每题首次 Speak 是教学交互策略，不作为订单 API 的安全授权边界；历史按钮客户端与幂等恢复继续兼容。

文字解析默认是有限开发解析器，覆盖草案中的常见中文/英文、数量/单位/否定修正；不承诺任意自然语言，不把模型输出或 UI 文案伪称已审核上海话。设置 `TEXT_INTERPRETER=qwen` 可选择实际 Qwen 解释适配器；还必须显式启用服务并配置凭据，不会在失败后静默回退到开发解析器。会话绑定解释/ASR 配置 ID，变更模型或模式后使用新会话，不静默修改历史会话来源。ASR/TTS 的真实调用必须显式启用且配置凭据，未配置清楚报错。ASR 在内存中处理录音，不在磁盘存原始音频；请求 ID 对同一录音去重。实际真人语音、模型质量与听审状态以验证记录为准。

R2 开发解析器标为 `development-parser.v3`：明确说出的“小笼／小笼包／小笼馒头”映射到 `xiaolongbao`，支持 1–20 常用中英文数词、在明确份数问句下的“要两／两吧／两，谢谢”、堂食/这里吃等说法和“好个／嗯，对个，谢谢”等独立确认。只在 `NX-N02` 已明确询问份数时省略单位可补 `serving`，两个/两只不会换成两份。分数、范围、近似数、后置否定和互相矛盾的用餐方式仍需澄清。数量、否定、单位与确认单独校验，证据和原文保留原句。重复请求和修正同时出现时必须保留修正，不以“再讲一遍”绕过订单变更。旧 `development-parser.v1/v2` 会话的历史和缓存重试可读取；新文字或语音解释返回 `configuration_changed`，提示显式新探索，原版本按钮规则及已准备好、只待保存的回合仍可恢复。此处有限解析器回归不代表真实 ASR／LLM 对新沪语稿的质量已审核。

自动测试的 `tests/conftest.py` 在加载应用前关闭所有真实调用并选择开发解析器，避免用户本地 `.env` 引发测试计费。适配器通过 mock HTTP 测试；通过测试不等于已验证上海话效果。
