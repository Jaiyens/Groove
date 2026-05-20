import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCoverGeometry,
  projectNormalized,
} from '../lib/pose/projection.ts';

describe('object-cover geometry', () => {
  it('square video into square container has no crop', () => {
    const g = computeCoverGeometry(640, 640, 400, 400);
    assert.equal(g.scale, 400 / 640);
    assert.equal(g.renderedWidth, 400);
    assert.equal(g.renderedHeight, 400);
    assert.equal(g.offsetX, 0);
    assert.equal(g.offsetY, 0);
  });

  it('landscape camera into portrait container crops left/right', () => {
    // typical webcam (16:9 landscape) into a phone portrait container
    const g = computeCoverGeometry(1280, 720, 430, 700);
    // cover-scale is max(430/1280, 700/720) = 700/720 ≈ 0.972
    const expectedScale = 700 / 720;
    assert.ok(Math.abs(g.scale - expectedScale) < 1e-9);
    // rendered width overflows the container — offsetX is negative (cropped)
    assert.ok(g.renderedWidth > 430);
    assert.ok(g.offsetX < 0);
    assert.equal(g.offsetY, 0);
  });

  it('portrait camera into portrait container crops top/bottom', () => {
    const g = computeCoverGeometry(480, 800, 430, 700);
    // scale = max(430/480, 700/800) = max(0.896, 0.875) = 0.896
    const expectedScale = 430 / 480;
    assert.ok(Math.abs(g.scale - expectedScale) < 1e-9);
    assert.equal(g.renderedWidth, 430);
    assert.ok(g.renderedHeight > 700);
    assert.equal(g.offsetX, 0);
    assert.ok(g.offsetY < 0);
  });

  it('projects centre of image to centre of container regardless of crop', () => {
    const g = computeCoverGeometry(1280, 720, 430, 700);
    const p = projectNormalized({ x: 0.5, y: 0.5 }, g);
    assert.ok(Math.abs(p.x - 215) < 1e-9);
    assert.ok(Math.abs(p.y - 350) < 1e-9);
  });

  it('projects landmark at native top-left out of frame when cropped', () => {
    // Landscape into portrait: x=0 (camera left) should be off-screen-left
    // because of the symmetric crop.
    const g = computeCoverGeometry(1280, 720, 430, 700);
    const p = projectNormalized({ x: 0, y: 0.5 }, g);
    assert.ok(p.x < 0, `expected p.x < 0 (cropped left), got ${p.x}`);
  });

  it('zero dimensions return a non-NaN identity geometry', () => {
    const g = computeCoverGeometry(0, 0, 0, 0);
    assert.equal(g.scale, 1);
    assert.equal(g.renderedWidth, 0);
    assert.equal(g.renderedHeight, 0);
  });
});
