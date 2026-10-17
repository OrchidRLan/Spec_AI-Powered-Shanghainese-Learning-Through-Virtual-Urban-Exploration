"""Decode validation, never trust file suffix, MIME declaration or client duration."""
import io
import wave
from .contracts import ProviderError


def inspect_wav(data: bytes, *, max_bytes: int = 3 * 1024 * 1024, max_seconds: float = 20) -> dict:
    if not data:
        raise ProviderError("no_speech")
    if len(data) > max_bytes:
        raise ProviderError("audio_too_large")
    try:
        with wave.open(io.BytesIO(data), "rb") as wav:
            if wav.getcomptype() != "NONE" or wav.getnchannels() not in (1, 2) or wav.getsampwidth() != 2:
                raise ProviderError("unsupported_format")
            rate, frames = wav.getframerate(), wav.getnframes()
            if not 8000 <= rate <= 48000:
                raise ProviderError("unsupported_format")
            duration = frames / rate
            if duration <= 0:
                raise ProviderError("no_speech")
            if duration > max_seconds:
                raise ProviderError("audio_too_long")
            decoded = wav.readframes(frames)
            if len(decoded) != frames * wav.getnchannels() * wav.getsampwidth():
                raise ProviderError("unsupported_format")
            return {"format": "wav", "sampleRate": rate, "channels": wav.getnchannels(),
                    "durationMs": round(duration * 1000)}
    except (wave.Error, EOFError, ValueError):
        raise ProviderError("unsupported_format") from None


def finalize_generated_wav(data: bytes) -> tuple[bytes, dict]:
    """Finalize the observed Qwen PCM WAV placeholder sizes; never used for uploads.

    A real Jada response (2026-10-17) had the canonical 44-byte PCM header,
    RIFF size 0x7fffffbf and data size 0x7fffff9b despite a complete short body.
    Only that observed placeholder pair is accepted. All other malformed files
    still fail inspect_wav; PCM samples, sample rate, pitch and speed are untouched.
    """
    import hashlib
    import struct

    processing = {"kind": "none"}
    if len(data) >= 44 and data[:4] == b"RIFF" and data[8:16] == b"WAVEfmt ":
        riff_size, fmt_size, data_size = struct.unpack_from("<I", data, 4)[0], struct.unpack_from("<I", data, 16)[0], struct.unpack_from("<I", data, 40)[0]
        if (fmt_size == 16 and data[36:40] == b"data"
                and (riff_size, data_size) == (0x7FFFFFBF, 0x7FFFFF9B)):
            block_align = struct.unpack_from("<H", data, 32)[0]
            if not block_align or (len(data) - 44) % block_align:
                raise ProviderError("unsupported_format")
            processing = {"kind": "wav_header_finalize", "sourceSha256": hashlib.sha256(data).hexdigest(),
                          "sourceRiffSize": riff_size, "sourceDataSize": data_size, "pcmUnchanged": True}
            finalized = bytearray(data)
            struct.pack_into("<I", finalized, 4, len(data) - 8)
            struct.pack_into("<I", finalized, 40, len(data) - 44)
            data = bytes(finalized)
    metadata = inspect_wav(data, max_bytes=15 * 1024 * 1024, max_seconds=180)
    return data, {**metadata, "processing": processing}
