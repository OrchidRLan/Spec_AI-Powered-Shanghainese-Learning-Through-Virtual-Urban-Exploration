# 批次 A 本地 API

Python 3.11+。本批次使用 FastAPI + 本地 SQLite；不是云端部署。

```sh
cd backend
python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
# 另一终端运行根目录前端；/api 经 Vite 同源代理。
.venv/bin/python -m pytest
```

默认数据库 `backend/data/app.db`，可通过 `DATABASE_PATH` 改到独立目录。后端自动加载根 `.env`，不覆盖进程已有环境变量；配置修改后重启后端。数据库、录音、日志、虚拟环境都不提交。部署 HTTPS 后必须设置 `COOKIE_SECURE=true`；本地 HTTP 默认 false。Cookie 为随机 256 位 token（数据库只保存哈希），`HttpOnly; SameSite=Strict`。返回的 session ID 不是访问凭证。写请求检验 Origin / Fetch Metadata 并要求 JSON（ASR 除外）；`ALLOWED_ORIGINS` 为逗号分隔的开发源列表，默认 localhost/127.0.0.1:5173。对外部署还需 HTTPS、正式 DB、过期清理、通用限速、备份和部署检查。ASR 已有会话每分钟 30 个请求的上限。

## 接口

| 接口 | 请求 | 返回 |
| --- | --- | --- |
| GET /api/session | 无 | 创建/恢复 cookie 会话，Session |
| PATCH /api/session | locale?: zh/en, show_romanization?: bool, reduced_motion?: bool | Session |
| POST /api/session/new | 已有会话 Cookie；JSON `{}` | 用户明确选择新的探索时创建 Session 并替换 Cookie；保留三项偏好，进度从零开始 |
| GET /api/services | 无 | asr.enabled/formats/config；text.mode=development_parser |
| GET /api/content | 会话 Cookie | 绑定版本的 content/batch-a.json |
| POST /api/attempts | station_id: nanxiang, restart?: bool | Attempt；未完成时恢复，同一请求重试不重复创建。已完成时 restart:true 才新建 |
| GET /api/attempts/{id} | Cookie | Attempt |
| POST /api/attempts/{id}/turns | TurnInput | TurnResult |
| GET /api/attempts/{id}/turns/{request_id} | Cookie | TurnResult；未知 404 |
| POST /api/attempts/{id}/turns/{request_id}/cancel | expected_revision | TurnResult；支持取消先于原 POST 到达 |
| POST /api/attempts/{id}/skip | expected_revision | Attempt；取消在途回合，不覆盖成功 |
| POST /api/events | event_id, attempt_id?, event_type, metadata? | saved, duplicate；不更新订单字段 |
| GET /api/events | Cookie | 仅自己会话的事件 |
| POST /api/asr | 原始 PCM16 WAV；Content-Type:audio/wav，X-Request-ID | {text,transcript,status,elapsed_ms,config_id,...}，转写本身不推进任务 |

```ts
type Order = {
  item: string | null;
  quantity: number | null;
  unit: 'serving' | 'basket' | 'piece' | 'unknown' | null;
  normalized_servings: number | null;
  takeaway: boolean | null;
};
type Attempt = {
  id: string; station_id: 'nanxiang';
  status: 'collecting'|'confirming'|'completed'|'skipped';
  revision: number; order: Order; unresolved_issues: string[];
  summary_revision: number|null; confirmed_revision: number|null;
  prompt_id: string; pending_request_id: string|null;
  metrics: {voice_attempts:number;help_used:number};
  unit_convention_seen: boolean; turns: Turn[];
  created_at:string; updated_at:string;
};
type TurnInput = {
  request_id:string; expected_revision:number; channel:'buttons'|'text'|'voice'|'voice_edited';
  action?: {type:'set_order';item?:string|null;quantity?:number|null;
    unit?:Order['unit'];takeaway?:boolean|null} | {type:'confirm'|'repeat'};
  text?:string; summary_revision?:number; asr_request_id?:string;
};
type TurnResult = {request_id:string;status:'applied'|'pending'|'cancelled'|'failed';
  attempt:Attempt;interpretation_source:string|null};
type Session = {
  id:string;locale:'zh'|'en';show_romanization:boolean;reduced_motion:boolean;
  mode:'development';content_version:string;rule_version:string;
  model_config_id:string;asr_config_id:string|null;created_at:string;attempts:Attempt[];
  completed_station_ids:string[];
  services:{text:'development_parser'|'qwen';asr:'unconfigured'|'configured'};
};
```

提交 `set_order` 的字段必须实际表达；未出现字段保留，null 明确清空，false 真实堂吃。数量变更必须携带单位，不从旧订单偷用单位。新数量/单位/商品/方式及无效修改先让旧摘要失效；同轮文字里的“对”不能确认尚未展示的摘要。随后独立提交 `confirm`，带已展示的 `summary_revision`。每次请求使用新的 request_id（8–100 位字母/数字/`_`/`-`）；网络重试复用相同 ID 与完全相同负载。重复已应用回合返回原始保存结果；若之后已有新进展，前端应按 revision 防止旧结果覆盖当前状态，必要时 GET attempt。

`POST /api/session/new` 只供用户明确点击“开始新的探索”并确认后调用，不在配置冲突或普通刷新时自动调用。它保留当前语言、注音显示及减少动态偏好，为新会话绑定当前内容/规则/模型配置，并返回空 attempts 与完成列表。旧会话、已保存尝试和成功记录留在数据库中，既不删除也不转入新会话；新 Cookie 没有访问旧会话的权限。前端应先取消在途任务并清空旧会话的本地草稿/请求状态，防止迟到界面结果覆盖新探索。

允许事件：`expression_opened`, `expression_inserted`, `unit_explanation_viewed`, `recording_started`, `recording_stopped`, `recording_cancelled`, `recording_played`, `recording_permission_denied`, `asr_submitted`, `asr_succeeded`, `asr_failed`, `asr_cancelled`, `audio_started`, `audio_ended`, `audio_interrupted`, `pronunciation_support_changed`, `input_channel_changed`, `station_entered`, `assistance_recorded`, `logging_gap`。只在真的展示“一笼示意对应一份”后发 `unit_explanation_viewed`；之后提交的 basket 单位才可归一。事件不能直接完成订单。录音权限拒绝不能发 `recording_started`。客户端 ASR 与回听事件只是 UI 诊断，后端强制记录 `reported_by:client`，不会增加语音尝试、帮助、成功或完成计数；真正识别结果由服务端单独记录 `asr_finished`（`reported_by:server`），客户端不能提交该事件。

HTTP 409 的 `detail={code,message,attempt?}` 表示冲突；刷新 attempt 并展示最新版本。422 为请求校验失败；503 表示服务或保存失败。保存失败时不得显示完成；先查询原 ID，再用原负载重试。已准备的解释会落盘，最终事务失败后可重试提交而不重新解释；状态、完成事件与结果在同一事务保存。进行中的解释可取消；崩溃后遗留 pending 可查询并取消，再以新 ID 提交。

解释失败会终结该回合并返回 `detail.terminal=true`，明确重试时生成新 ID；这与保存失败和网络未知结果的原 ID 重试不同。页面刷新后也要根据 `attempt.pending_request_id` 展示查询/取消入口，不能只依赖内存中的请求对象。

语音原转写成功后，用户明确提交 `channel:'voice',text,asr_request_id`；如手动编辑则 `channel:'voice_edited'`。ASR ID 必须属于当前会话，原转写从服务端保存结果读取；`voice` 文本必须完全匹配原转写。回合分别返回 `asr_transcript` 与 `text`，不把编辑后的内容伪记为识别结果。ASR 出错返回稳定 `detail.code/retryable/terminal`；只有终结失败重新试才换 ID，未知结果仍复用原 ID。转写处理超过 30 秒的未知请求允许用户明确开始新请求；不会自动重调模型。

文字解析默认是有限开发解析器，覆盖草案中的常见中文/英文、数量/单位/否定修正；不承诺任意自然语言，不把模型输出或 UI 文案伪称已审核上海话。设置 `TEXT_INTERPRETER=qwen` 可选择实际 Qwen 解释适配器；还必须显式启用服务并配置凭据，不会在失败后静默回退到开发解析器。会话绑定解释/ASR 配置 ID，变更模型或模式后使用新会话，不静默修改历史会话来源。ASR/TTS 的真实调用必须显式启用且配置凭据，未配置清楚报错。ASR 在内存中处理录音，不在磁盘存原始音频；请求 ID 对同一录音去重。实际真人语音、模型质量与听审状态以验证记录为准。

自动测试的 `tests/conftest.py` 在加载应用前关闭所有真实调用并选择开发解析器，避免用户本地 `.env` 引发测试计费。适配器通过 mock HTTP 测试；通过测试不等于已验证上海话效果。
