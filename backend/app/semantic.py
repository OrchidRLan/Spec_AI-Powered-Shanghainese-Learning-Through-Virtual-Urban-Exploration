"""Explicit provider selection. No silent fallback after a live provider fails."""
from dataclasses import asdict
from .interpreter import parse_development
from .models import Interpretation
from .providers import ProviderConfig, ProviderError, QwenInterpreter


def configure_interpreter(mode: str):
    if mode == "development_parser":
        return parse_development, "development-parser.v1"
    if mode != "qwen":
        raise ValueError("TEXT_INTERPRETER must be development_parser or qwen")
    config = ProviderConfig.from_env("llm")
    provider = QwenInterpreter(config)

    async def interpret(text: str, attempt: dict) -> Interpretation:
        raw = await provider.interpret(text, {
            "scene": attempt["station_id"], "known_fields": attempt["order"],
            "previous_question": attempt["prompt_id"],
            "confirmation_summary": attempt["order"] if attempt["status"] == "confirming" else None,
            "menu": ["xiaolongbao"],
        })
        data = asdict(raw)
        intent = data["intent"]
        if intent == "deny":
            intent = "modify"
        elif intent not in ("provide", "confirm", "modify", "repeat", "unknown"):
            intent = "unknown"
        return Interpretation(intent=intent, changes=data["changes"], evidence=data["evidence"],
                              uncertainties=data["uncertainties"], help_requested=data["help_requested"],
                              source="qwen:" + config.config_id, model_config_id=config.config_id,
                              upstream_request_id=data["upstream_request_id"], elapsed_ms=data["elapsed_ms"],
                              model=data["model"])
    return interpret, config.config_id
