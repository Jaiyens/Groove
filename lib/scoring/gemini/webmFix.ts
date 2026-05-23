// MediaRecorder webm metadata repair.
//
// Background: MediaRecorder output webms routinely ship with broken or
// missing top-level Duration metadata. The previous `finalizeWebmDuration`
// seek-trick (lib/scoring/gemini/webmDuration.ts) reports `fixed: true`
// because video.duration becomes finite, but the value it lands on can
// still be wrong by seconds — the seek finalizes whatever the browser can
// see in the broken container, not the true cluster span.
//
// Round-5 fix: rewrite the EBML metadata before the blob ever hits a
// <video> element. Walk the EBML structure with ts-ebml's Reader to
// derive the real duration from cluster timestamps, then rebuild the
// header via `tools.makeMetadataSeekable`. This is the textbook fix and
// has been used in production webm pipelines for years.
//
// `repairWebmDuration` is best-effort: if parsing fails (malformed blob,
// non-webm input, ts-ebml internal error), the original blob is returned
// unchanged so the caller can decide whether to proceed with the legacy
// path. The wrapper logs nothing itself — the DOM caller in client.ts
// surfaces the before/after sizes and durations.

import { Decoder, Reader, tools } from 'ts-ebml';

export interface RepairWebmResult {
  blob: Blob;
  // True when ts-ebml parsed the input cleanly and the metadata was
  // rebuilt. False when parsing/rebuilding failed and the original blob
  // was returned unchanged.
  repaired: boolean;
  blobBytesBefore: number;
  blobBytesAfter: number;
  // Duration the Reader inferred from the cluster timestamps (in
  // Segment Ticks scaled by TimestampScale → seconds). 0 / NaN when the
  // input has no clusters or the read failed before reaching them.
  inferredDurationSec: number;
}

export async function repairWebmDuration(blob: Blob): Promise<RepairWebmResult> {
  const blobBytesBefore = blob.size;
  // Best-effort: any throw from ts-ebml's parsers (corrupt header,
  // non-webm input, unknown EBML IDs) lands here and we hand back the
  // original blob unchanged.
  try {
    const buf = await blob.arrayBuffer();
    const decoder = new Decoder();
    const reader = new Reader();
    reader.logging = false;

    const elements = decoder.decode(buf);
    elements.forEach((el) => reader.read(el));
    reader.stop();

    const inferredDurationSec = Number.isFinite(reader.duration)
      ? reader.duration
      : 0;

    // If the Reader couldn't infer a non-trivial duration we have
    // nothing useful to rebuild from. Hand back the original blob.
    if (!Number.isFinite(reader.duration) || reader.duration <= 0) {
      return {
        blob,
        repaired: false,
        blobBytesBefore,
        blobBytesAfter: blobBytesBefore,
        inferredDurationSec,
      };
    }

    const refinedMetadataBuf = tools.makeMetadataSeekable(
      reader.metadatas,
      reader.duration,
      reader.cues,
    );
    const body = buf.slice(reader.metadataSize);
    const out = new Blob([refinedMetadataBuf, body], { type: blob.type });

    return {
      blob: out,
      repaired: true,
      blobBytesBefore,
      blobBytesAfter: out.size,
      inferredDurationSec,
    };
  } catch {
    return {
      blob,
      repaired: false,
      blobBytesBefore,
      blobBytesAfter: blobBytesBefore,
      inferredDurationSec: 0,
    };
  }
}
