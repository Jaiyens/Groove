// WebM → MP4 transcode. Server-only.
//
// Gemini's generateContent rejects video/webm with 400 INVALID_ARGUMENT.
// MediaRecorder in the browser captures WebM by default. So any user-captured
// video has to pass through this helper before it can be sent to the model.
// H.264 + yuv420p + faststart + audio stripped = the unlock.
//
// The @ffmpeg-installer binary ships with the deployment so we don't depend on
// a system ffmpeg being present in the runtime image.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffmpeg from 'fluent-ffmpeg';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export async function transcodeWebmToMp4Path(webmBuffer: Buffer): Promise<{
  mp4Path: string;
  cleanup: () => Promise<void>;
}> {
  const tmpDir = os.tmpdir();
  const id = crypto.randomUUID();
  const webmPath = path.join(tmpDir, `${id}.webm`);
  const mp4Path = path.join(tmpDir, `${id}.mp4`);
  await fs.writeFile(webmPath, webmBuffer);

  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(webmPath)
        .videoCodec('libx264')
        .outputOptions(['-pix_fmt yuv420p', '-an', '-preset ultrafast', '-movflags +faststart'])
        .save(mp4Path)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err));
    });
  } catch (err) {
    await fs.unlink(webmPath).catch(() => {});
    await fs.unlink(mp4Path).catch(() => {});
    throw err;
  }

  return {
    mp4Path,
    cleanup: async () => {
      await Promise.allSettled([fs.unlink(webmPath), fs.unlink(mp4Path)]);
    },
  };
}
