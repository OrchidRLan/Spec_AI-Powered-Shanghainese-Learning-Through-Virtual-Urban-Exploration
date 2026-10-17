"""The developer's live .env must never turn the automated suite into paid calls."""
import os

# Applied before test modules import app.main (which loads .env without override).
os.environ["SPEECH_ENABLE_LIVE"] = "false"
os.environ["QWEN_ASR_ENABLE_LIVE"] = "false"
os.environ["QWEN_LLM_ENABLE_LIVE"] = "false"
os.environ["QWEN_TTS_ENABLE_LIVE"] = "false"
os.environ["TEXT_INTERPRETER"] = "development_parser"
