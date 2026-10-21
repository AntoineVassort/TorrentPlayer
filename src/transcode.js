// On-the-fly audio conversion for casting. Chromecast receivers (e.g. the Freebox
// Player POP) play video from an MKV but stay silent on audio they can't decode
// (E-AC-3, AC-3, DTS, TrueHD). ffmpeg copies the video untouched and re-encodes
// the audio to AAC into a fragmented MP4 piped straight into the HTTP response.

import { spawn } from 'child_process';
import fs from 'fs';
import ffmpegPath from 'ffmpeg-static';

// Audio codecs every Chromecast decodes; anything else is converted.
const CAST_SAFE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

const ffmpegBin = () => (ffmpegPath && fs.existsSync(ffmpegPath) ? ffmpegPath : null);

// First audio codec of `inputUrl`, read from ffmpeg's stream listing (it prints it
// to stderr and exits non-zero because no output is given). null when unknown.
function probeAudioCodec(inputUrl) {
  const bin = ffmpegBin();
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    const proc = spawn(bin, ['-hide_banner', '-nostdin', '-i', inputUrl], { windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => proc.kill(), 15000);
    const done = () => { clearTimeout(timer); resolve(err.match(/Stream #\d+:\d+[^\n]*?: Audio: (\w+)/)?.[1] || null); };
    proc.on('close', done);
    proc.on('error', done);
  });
}

export async function needsAudioTranscode(inputUrl) {
  const codec = await probeAudioCodec(inputUrl);
  return !!codec && !CAST_SAFE_AUDIO.has(codec);
}

// Stream the converted file into `res`; stops ffmpeg when the receiver disconnects.
// The output has no length and no index, so the receiver can't seek in it.
export function pipeTranscoded(inputUrl, res, headers = {}) {
  const bin = ffmpegBin();
  if (!bin) { res.writeHead(500, headers); res.end(); return; }
  const proc = spawn(bin, [
    '-v', 'error', '-nostdin', '-i', inputUrl,
    '-map', '0:v:0', '-map', '0:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-ac', '2', '-b:a', '192k',
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  res.writeHead(200, { ...headers, 'Content-Type': 'video/mp4' });
  proc.stdout.pipe(res);
  proc.on('error', () => res.destroy());
  proc.on('close', () => res.end());
  res.on('close', () => proc.kill());
}
