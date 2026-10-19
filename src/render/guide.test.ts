// Steini on the mats: a scene change (a new spot more than JUMP_M away) places him there at once —
// he stands on his final side from the first frame instead of sliding across the screen — while a
// small step still blends.
import '../../dev/character-stub';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GuideModel, JUMP_M } from './guide';
import { BONE } from './climber';
import { REGION } from './materials';
import { WallFrame } from './wall-frame';

const dt = 1 / 60;

function pelvisX(g: GuideModel): number {
  return g.rig.bones[BONE.pelvis].position.x;
}

describe('GuideModel spot changes', () => {
  const frame = new WallFrame(0);
  it('places the guide at once on a jump > JUMP_M (no slide across the mats)', () => {
    const g = new GuideModel();
    for (let i = 0; i < 60; i++) g.setState({ x: -1.4, depth: 1.3, pose: 'idle', lookAt: { x: 0, y: 2 } }, frame, dt);
    expect(pelvisX(g)).toBeCloseTo(frame.origin.x - 1.4, 1);
    // the tutorial moves him from its wide spot to the lesson spot on the other side
    g.setState({ x: 1.2, depth: 1.2, pose: 'idle', lookAt: { x: 0, y: 2 } }, frame, dt);
    expect(Math.abs(pelvisX(g) - (frame.origin.x + 1.2))).toBeLessThan(0.05);
    // and both feet came along (no leg stretched back to the old spot)
    const hipX = pelvisX(g);
    for (const s of [0, 1]) expect(Math.abs(g.rig.joints.ankle[s].x - hipX)).toBeLessThan(0.35);
    expect(JUMP_M).toBe(1);
  });

  it('a small step still blends over a few frames', () => {
    const g = new GuideModel();
    for (let i = 0; i < 60; i++) g.setState({ x: 0, depth: 1.3, pose: 'idle' }, frame, dt);
    const x0 = pelvisX(g);
    g.setState({ x: 0.4, depth: 1.3, pose: 'idle' }, frame, dt);
    const x1 = pelvisX(g);
    expect(x1 - x0).toBeGreaterThan(0.005);
    expect(x1 - x0).toBeLessThan(0.2);
    for (let i = 0; i < 90; i++) g.setState({ x: 0.4, depth: 1.3, pose: 'idle' }, frame, dt);
    expect(pelvisX(g)).toBeCloseTo(frame.origin.x + 0.4, 1);
  });

  it('wears the white instructor tee', () => {
    const g = new GuideModel();
    const top = new THREE.Color();
    const pal = (g.rig.material.userData.body.uPal.value as THREE.Color[])[REGION.top];
    top.copy(pal);
    // white tee: bright and neutral
    expect(top.r).toBeGreaterThan(0.8);
    expect(top.g).toBeGreaterThan(0.8);
    expect(top.b).toBeGreaterThan(0.75);
  });
});
