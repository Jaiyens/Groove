// MediaRecorder webm metadata repair.
//
// Background: MediaRecorder output webms routinely ship without a top-level
// Duration element (or with Duration=0). The previous `finalizeWebmDuration`
// seek-trick (lib/scoring/gemini/webmDuration.ts) reports `fixed: true`
// because video.duration becomes finite, but the value can still be wrong
// by seconds — the seek finalizes whatever the browser can derive from the
// broken container, not the true cluster span.
//
// Round-5: walk the EBML bytes to find the last Cluster's Timecode (and the
// TimecodeScale), compute the real duration, then rewrite the header via
// `fix-webm-duration` (the canonical MIT zero-dep implementation derived
// from the well-known Stack Overflow answer). This replaces an earlier
// `ts-ebml` attempt that crashed in the Next.js browser bundle —
// "Cannot read properties of undefined (reading 'readVint')" — because
// ts-ebml's internal cross-imports don't resolve under webpack.
//
// `repairWebmDuration(blob)` is best-effort: a malformed blob, an EBML
// scan that can't find a cluster, or a fix-webm-duration throw all land
// in the catch and the original blob is returned unchanged. The wrapper
// itself logs nothing — the DOM caller in client.ts surfaces the
// before/after sizes and durations.

import fixWebmDuration from 'fix-webm-duration';

export interface RepairWebmResult {
  blob: Blob;
  // True when the EBML scan inferred a duration AND fix-webm-duration
  // rewrote the header. False on any failure — the original blob is
  // returned unchanged in that case.
  repaired: boolean;
  blobBytesBefore: number;
  blobBytesAfter: number;
  // Duration (in seconds) inferred from the last Cluster's Timecode and
  // the Info section's TimecodeScale. 0 when the scan couldn't find a
  // cluster or the read failed.
  inferredDurationSec: number;
}

// EBML element IDs (VINT-encoded, marker bits preserved):
//   0x1F43B675 — Cluster
//   0x2AD7B1   — TimecodeScale (inside Info)
//   0xE7       — Timecode (inside Cluster, single-byte VINT)
//
// We deliberately use byte-pattern scans rather than a full recursive
// descent because MediaRecorder writes Segments with the "unknown size"
// VINT (all data bits 1), which complicates structured parsing. The
// element IDs are designed to be improbable as content bytes; false
// positives are vanishingly rare and the VINT-size sanity checks in the
// reader below trap any that slip through.

const CLUSTER_ID_BYTES = [0x1f, 0x43, 0xb6, 0x75] as const;
const TIMECODE_SCALE_ID_BYTES = [0x2a, 0xd7, 0xb1] as const;
const TIMECODE_ELEMENT_ID = 0xe7;

// Variable-length integer reader (EBML VINT). `keepMarker` is true when
// reading an element ID (the marker bits ARE part of the ID), false when
// reading an element data size.
function readVint(
  view: DataView,
  offset: number,
  keepMarker: boolean,
): { value: number; bytes: number } {
  if (offset >= view.byteLength) throw new Error('vint: out of bounds');
  const first = view.getUint8(offset);
  if (first === 0) throw new Error('vint: leading zero');
  let mask = 0x80;
  let length = 1;
  while ((first & mask) === 0) {
    mask >>= 1;
    length += 1;
    if (length > 8) throw new Error('vint: > 8 bytes');
  }
  if (offset + length > view.byteLength) throw new Error('vint: truncated');
  let value = keepMarker ? first : first & (mask - 1);
  for (let i = 1; i < length; i += 1) {
    value = value * 256 + view.getUint8(offset + i);
  }
  return { value, bytes: length };
}

function readUint(view: DataView, offset: number, length: number): number {
  if (length === 0) return 0;
  if (offset + length > view.byteLength) throw new Error('uint: truncated');
  let v = 0;
  for (let i = 0; i < length; i += 1) {
    v = v * 256 + view.getUint8(offset + i);
  }
  return v;
}

// Find the LAST occurrence of `pattern` in `bytes`. Returns -1 when
// not found. Linear scan; fine for blobs up to tens of MB.
function findLastBytePattern(bytes: Uint8Array, pattern: readonly number[]): number {
  outer: for (let i = bytes.length - pattern.length; i >= 0; i -= 1) {
    for (let j = 0; j < pattern.length; j += 1) {
      if (bytes[i + j] !== pattern[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// Find the FIRST occurrence of `pattern` (we only need any TimecodeScale
// — there is at most one per Segment).
function findFirstBytePattern(bytes: Uint8Array, pattern: readonly number[]): number {
  outer: for (let i = 0; i <= bytes.length - pattern.length; i += 1) {
    for (let j = 0; j < pattern.length; j += 1) {
      if (bytes[i + j] !== pattern[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// Infer the recording duration in milliseconds from the EBML bytes.
// Returns 0 when no cluster is found, the structure is malformed, or
// the reader hit a truncated VINT — all of which mean we have nothing
// trustworthy to hand to fix-webm-duration.
function inferDurationMs(buf: ArrayBuffer): number {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  if (bytes.length < 16) return 0;

  // TimecodeScale (nanoseconds per tick; default 1_000_000 = 1ms).
  let timecodeScaleNs = 1_000_000;
  const tcsIdAt = findFirstBytePattern(bytes, TIMECODE_SCALE_ID_BYTES);
  if (tcsIdAt >= 0) {
    try {
      const sizeAt = tcsIdAt + TIMECODE_SCALE_ID_BYTES.length;
      const size = readVint(view, sizeAt, false);
      const tcs = readUint(view, sizeAt + size.bytes, size.value);
      if (tcs > 0) timecodeScaleNs = tcs;
    } catch {
      // keep the default
    }
  }

  // Last cluster's Timecode (uint, in TimecodeScale ticks).
  const clusterAt = findLastBytePattern(bytes, CLUSTER_ID_BYTES);
  if (clusterAt < 0) return 0;
  try {
    const clusterSizeAt = clusterAt + CLUSTER_ID_BYTES.length;
    const clusterSize = readVint(view, clusterSizeAt, false);
    const clusterDataAt = clusterSizeAt + clusterSize.bytes;
    // The first child of a Cluster is conventionally Timecode (0xE7).
    // MediaRecorder honors this. If the first byte isn't 0xE7 we bail
    // rather than blindly parse — better to return 0 and let the caller
    // skip the repair than feed a bogus duration to fix-webm-duration.
    if (clusterDataAt >= view.byteLength) return 0;
    if (view.getUint8(clusterDataAt) !== TIMECODE_ELEMENT_ID) return 0;
    const tcSizeAt = clusterDataAt + 1; // single-byte ID
    const tcSize = readVint(view, tcSizeAt, false);
    const timecodeTicks = readUint(view, tcSizeAt + tcSize.bytes, tcSize.value);
    // Convert ticks (in TimecodeScale-ns) to milliseconds.
    const durationMs = Math.round((timecodeTicks * timecodeScaleNs) / 1_000_000);
    return durationMs > 0 ? durationMs : 0;
  } catch {
    return 0;
  }
}

export async function repairWebmDuration(blob: Blob): Promise<RepairWebmResult> {
  const blobBytesBefore = blob.size;
  try {
    const buf = await blob.arrayBuffer();
    const durationMs = inferDurationMs(buf);
    const inferredDurationSec = durationMs / 1000;

    if (durationMs <= 0) {
      // No reliable duration to hand fix-webm-duration. The library
      // would no-op anyway when given duration<=0 in some shapes; we
      // return the original blob unchanged for predictability.
      return {
        blob,
        repaired: false,
        blobBytesBefore,
        blobBytesAfter: blobBytesBefore,
        inferredDurationSec: 0,
      };
    }

    // fix-webm-duration is the Promise-returning overload when called
    // with (blob, duration, options). The library's `logger: false`
    // option suppresses its console.log spam so our [gemini-client]
    // motion-onset trimAttempt: webm-repair line is the only signal in
    // the field log.
    const out = await fixWebmDuration(blob, durationMs, { logger: false });
    // fix-webm-duration returns the SAME blob reference when its
    // internal `fixDuration` decides nothing needs changing (e.g.,
    // when the existing Duration field is already positive). Track
    // `repaired` accordingly — same reference == library short-circuit.
    const repaired = out !== blob;

    return {
      blob: out,
      repaired,
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
