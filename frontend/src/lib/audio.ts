export const MAX_RECORDING_SECONDS = 20;
export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

/** All application sounds share one playback channel. */
export function stopAllAudio(except?: HTMLMediaElement): void {
  document.querySelectorAll<HTMLMediaElement>('audio, video').forEach((element) => {
    if (element === except) return;
    element.pause();
    try {
      element.currentTime = 0;
    } catch {
      // A media element with no loaded resource may not be seekable yet.
    }
  });
}

export function chooseRecordingMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return [
    'audio/webm;codecs=opus',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/webm',
  ].find((type) => MediaRecorder.isTypeSupported(type));
}

/** Encode PCM16; the private recording stays in memory throughout conversion. */
export function encodeMonoWav(audio: AudioBuffer): ArrayBuffer {
  if (!audio.numberOfChannels || !audio.length || !Number.isFinite(audio.sampleRate)) {
    throw new Error('empty_audio');
  }
  // Timer callbacks can run late in a background tab. Never upload beyond the limit.
  const frames = Math.min(audio.length, Math.floor(audio.sampleRate * MAX_RECORDING_SECONDS));
  const output = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(output);
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, output.byteLength - 8, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, frames * 2, true);
  const channels = Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index));
  for (let frame = 0; frame < frames; frame += 1) {
    const sample = channels.reduce((sum, channel) => sum + channel[frame], 0) / channels.length;
    const clamped = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0));
    view.setInt16(44 + frame * 2, Math.round(clamped * (clamped < 0 ? 0x8000 : 0x7fff)), true);
  }
  return output;
}

export async function recordingToWav(recording: Blob): Promise<ArrayBuffer> {
  if (!recording.size) throw new Error('empty_audio');
  // decodeAudioData resamples to the context rate. An offline context avoids
  // starting an audio output device and handles WebM on Chrome / MP4 on Safari.
  const context = new OfflineAudioContext(1, 1, 16000);
  const decoded = await context.decodeAudioData(await recording.arrayBuffer());
  const result = encodeMonoWav(decoded);
  if (result.byteLength > MAX_UPLOAD_BYTES) throw new Error('audio_too_large');
  return result;
}
