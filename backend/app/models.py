from __future__ import annotations

from typing import Any, Literal
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Preferences(StrictModel):
    locale: Literal["zh", "en"] | None = None
    show_romanization: StrictBool | None = None
    reduced_motion: StrictBool | None = None


class NewSessionInput(StrictModel):
    """Explicit user action; settings are copied only from the owned session."""
    pass


class AttemptInput(StrictModel):
    station_id: Literal["nanxiang"]
    restart: StrictBool = False


class Action(StrictModel):
    type: Literal["set_order", "confirm", "repeat"]
    item: str | None = Field(default=None, max_length=60)
    quantity: StrictInt | None = Field(default=None, ge=-1000000, le=1000000)
    unit: Literal["serving", "basket", "piece", "unknown"] | None = None
    takeaway: StrictBool | None = None

    @model_validator(mode="after")
    def valid_shape(self):
        fields = self.model_fields_set - {"type"}
        if self.type == "set_order" and not fields:
            raise ValueError("set_order requires at least one field")
        if self.type != "set_order" and fields:
            raise ValueError("Only set_order accepts order fields")
        return self


class TurnInput(StrictModel):
    request_id: str = Field(min_length=8, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")
    expected_revision: StrictInt = Field(ge=0)
    channel: Literal["buttons", "text", "voice", "voice_edited"]
    action: Action | None = None
    text: str | None = Field(default=None, min_length=1, max_length=2000)
    summary_revision: StrictInt | None = Field(default=None, ge=0)
    asr_request_id: str | None = Field(default=None, min_length=8, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")

    @model_validator(mode="after")
    def valid_channel(self):
        if self.channel == "buttons" and (self.action is None or self.text is not None):
            raise ValueError("Button submissions require an action only")
        if self.channel != "buttons" and (self.action is not None or not self.text or not self.text.strip()):
            raise ValueError("Text submissions require nonempty text only")
        if self.channel in ("voice", "voice_edited") and self.asr_request_id is None:
            raise ValueError("Voice submissions require their saved ASR request ID")
        if self.channel in ("buttons", "text") and self.asr_request_id is not None:
            raise ValueError("Only voice submissions accept an ASR request ID")
        return self


class RevisionInput(StrictModel):
    expected_revision: StrictInt = Field(ge=0)


class EventInput(StrictModel):
    event_id: str = Field(min_length=8, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")
    attempt_id: str | None = Field(default=None, max_length=100)
    event_type: Literal[
        "expression_opened", "expression_inserted", "unit_explanation_viewed",
        "recording_started", "recording_stopped", "recording_cancelled",
        "recording_played", "asr_submitted", "asr_succeeded", "asr_failed", "asr_cancelled",
        "recording_permission_denied", "audio_started", "audio_ended", "audio_interrupted",
        "pronunciation_support_changed", "input_channel_changed", "station_entered",
        "assistance_recorded", "logging_gap",
    ]
    metadata: dict[str, Any] = Field(default_factory=dict)


class Interpretation(StrictModel):
    """Provider-independent input to the deterministic rules. Never carries success."""
    intent: Literal["provide", "confirm", "modify", "repeat", "unknown"] = "unknown"
    changes: dict[str, Any] = Field(default_factory=dict)
    evidence: dict[str, str] = Field(default_factory=dict)
    uncertainties: list[str] = Field(default_factory=list)
    help_requested: bool = False
    source: str = "development_parser"
    model_config_id: str | None = None
    upstream_request_id: str | None = None
    elapsed_ms: int | None = None
    model: str | None = None
