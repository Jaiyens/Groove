// Pure-TS projection of normalized pose landmarks → display pixel coords,
// honouring CSS object-fit: cover. Swift-portable (no DOM imports).
//
// MediaPipe returns landmarks as normalized image coordinates (x, y ∈ [0, 1])
// relative to the camera frame's native dimensions (videoWidth × videoHeight).
// The on-screen video element is sized by CSS (clientWidth × clientHeight) and
// uses `object-fit: cover`, which scales the frame so it fills the container
// without distortion, cropping the long axis.
//
// To draw a skeleton overlay that lines up with the body:
//   scale     = max(clientW / videoW, clientH / videoH)
//   renderedW = videoW * scale
//   renderedH = videoH * scale
//   offsetX   = (clientW - renderedW) / 2   (negative when cropped)
//   offsetY   = (clientH - renderedH) / 2
//   px(nx)    = offsetX + nx * renderedW
//   py(ny)    = offsetY + ny * renderedH
//
// Horizontal mirroring (selfie camera) is handled at the canvas/CSS layer, not
// here — keep this math in the camera's native (un-mirrored) coordinate frame.

export interface ObjectCoverGeometry {
  scale: number;
  renderedWidth: number;
  renderedHeight: number;
  offsetX: number;
  offsetY: number;
  containerWidth: number;
  containerHeight: number;
}

export function computeCoverGeometry(
  videoWidth: number,
  videoHeight: number,
  containerWidth: number,
  containerHeight: number,
): ObjectCoverGeometry {
  if (videoWidth <= 0 || videoHeight <= 0 || containerWidth <= 0 || containerHeight <= 0) {
    return {
      scale: 1,
      renderedWidth: containerWidth,
      renderedHeight: containerHeight,
      offsetX: 0,
      offsetY: 0,
      containerWidth,
      containerHeight,
    };
  }
  const scale = Math.max(containerWidth / videoWidth, containerHeight / videoHeight);
  const renderedWidth = videoWidth * scale;
  const renderedHeight = videoHeight * scale;
  return {
    scale,
    renderedWidth,
    renderedHeight,
    offsetX: (containerWidth - renderedWidth) / 2,
    offsetY: (containerHeight - renderedHeight) / 2,
    containerWidth,
    containerHeight,
  };
}

export interface NormalizedPoint {
  x: number;
  y: number;
}

export function projectNormalized(
  point: NormalizedPoint,
  geom: ObjectCoverGeometry,
): { x: number; y: number } {
  return {
    x: geom.offsetX + point.x * geom.renderedWidth,
    y: geom.offsetY + point.y * geom.renderedHeight,
  };
}
