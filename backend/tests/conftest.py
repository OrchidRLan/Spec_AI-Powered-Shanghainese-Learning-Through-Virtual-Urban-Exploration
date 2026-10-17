"""The developer's live .env must never turn the automated suite into paid calls."""
import os
from tempfile import TemporaryDirectory

# app.main exposes a module-level ASGI app. Its import initializes a database
# before individual tests can pass their own fixture path; isolate that app too.
_import_database = TemporaryDirectory(prefix="shanghainese-test-import-")
os.environ["DATABASE_PATH"] = os.path.join(_import_database.name, "import.db")

# Applied before test modules import app.main (which loads .env without override).
os.environ["SPEECH_ENABLE_LIVE"] = "false"
os.environ["QWEN_ASR_ENABLE_LIVE"] = "false"
os.environ["QWEN_LLM_ENABLE_LIVE"] = "false"
os.environ["QWEN_TTS_ENABLE_LIVE"] = "false"
os.environ["TEXT_INTERPRETER"] = "development_parser"
