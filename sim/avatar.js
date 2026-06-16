/* avatar.js — shared 3D head + playback viewer (three.js module).
 *
 * Used by both the simulator page (index.html) and the gallery (gallery.html).
 * Expects these elements to exist in the page (same markup block on both):
 *   #avatar-canvas, #avatar-loading, #play-btn, #scrubber, #time-display,
 *   .avatar-wrap, .avatar-labels span
 *
 * Public API (on window):
 *   loadEyeTrajectory(traj)   — load a downsampled per-eye trajectory + play UI
 *   _avatarTogglePlay()       — play / pause
 *   _avatarOnScrub(frame)     — seek to a frame
 * Calls window.setPlotTime(seconds) each frame to sync the plot time-cursor.
 *
 * Requires an importmap defining "three" + "three/addons/" in the host page.
 */
import * as THREE     from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ── Renderer + scene ──────────────────────────────────────────────────────────
const canvas   = document.getElementById('avatar-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.autoClear = false;   // we clear manually between viewports

const W = () => canvas.clientWidth  || 820;
const H = () => canvas.clientHeight || 420;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeef0f4);

// Two cameras — world view (left) and head-fixed view (right)
const worldCam = new THREE.PerspectiveCamera(28, W() / 2 / H(), 0.001, 10000);
const headCam  = new THREE.PerspectiveCamera(28, W() / 2 / H(), 0.001, 10000);
// Layer 1 = world-only props (target sphere, gaze rays). World view sees layers
// 0+1; head-fixed close-up sees only layer 0 (no clutter over the eyeballs).
worldCam.layers.enable(1);

function resize() {
  renderer.setSize(W(), H(), false);
  // Camera aspect ratios are set per-frame in renderViewports() based on _headMoves
}
new ResizeObserver(resize).observe(canvas);
resize();

scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const key = new THREE.DirectionalLight(0xffffff, 1.4);
key.position.set(1, 3, 2); scene.add(key);
scene.add(new THREE.DirectionalLight(0x8899ff, 0.4)).position.set(-2, 1, 1);

// ── Avatar ────────────────────────────────────────────────────────────────────
let leftEyeBone  = null;
let rightEyeBone = null;
let headBone     = null;
let restL = null, restR = null, restHead = null;
let coverMeshL   = null, coverMeshR = null;
let faceMesh     = null;   // skinned mesh carrying the ARKit morph targets (eyelids)

// Target sphere + gaze rays. Everything in WORLD space; the eye anchor is the
// eye bone's getWorldPosition() (the canonical, already-correct world position —
// the same one the head-fixed camera uses).
let targetSphere = null, gazeRayL = null, gazeRayR = null;
let sceneDots = null;               // low-contrast world surround group (rotates + flows)
let _dotLayers = null, _dotH = 1;   // per-size dot layers {geom, base} + half-extent (wrap flow)
let _restEyeMid  = null;            // world eye-mid at rest (for the world-fixed target)
let _gazeAxisL   = null, _gazeAxisR = null;  // eye-local axis that points along gaze
let _headLocalFwd = null;           // head-local "forward" (for head-fixed cover offset)
let _eyeOffL = null, _eyeOffR = null;      // rest bone→rendered-eye offset (world, head-frame)
let _headQuatRestInv = null;               // inverse of head world quat at rest
let _modelUnit   = 1;               // world units per metre (from eye separation)
let _hasTarget   = false, _hasScene = false, _hasLocomotion = false, _showWorld = false;
// World-camera view presets (switchable via keys d/t/l/r — temporary debug aid).
let _camRefEye = null, _camRefSize = 1, _camNear = 0.01, _camFar = 100;

function setWorldView(mode) {
  if (!_camRefEye) return;
  const e = _camRefEye, s = _camRefSize, u = _modelUnit;
  worldCam.fov = 36;
  const fwd = 0.5 * u;   // aim at the eye→target midpoint (target ≈ 1 u in front)
  let pos, look;
  if (mode === 'top') {
    pos  = new THREE.Vector3(e.x, e.y + s * 1.9, e.z - s * 0.15);
    look = new THREE.Vector3(e.x, e.y, e.z + fwd);
  } else if (mode === 'left') {
    pos  = new THREE.Vector3(e.x - s * 1.8, e.y + s * 0.25, e.z + fwd);
    look = new THREE.Vector3(e.x, e.y, e.z + fwd);
  } else if (mode === 'right') {
    pos  = new THREE.Vector3(e.x + s * 1.8, e.y + s * 0.25, e.z + fwd);
    look = new THREE.Vector3(e.x, e.y, e.z + fwd);
  } else {  // default: behind + above
    pos  = new THREE.Vector3(e.x + s * 0.35, e.y + s * 0.65, e.z - s * 1.15);
    look = new THREE.Vector3(e.x, e.y - s * 0.05, e.z + fwd);
  }
  worldCam.position.copy(pos);
  worldCam.lookAt(look);
  worldCam.near = _camNear; worldCam.far = Math.max(_camFar, s * 60);
  worldCam.updateProjectionMatrix();
}

const AVATAR_PATH = 'avatar/avatar.glb';

new GLTFLoader().load(AVATAR_PATH, (gltf) => {
  const model = gltf.scene;
  scene.add(model);

  model.traverse(obj => {
    if (obj.name === 'LeftEye'  || obj.name === 'LeftEye_08')  leftEyeBone  = obj;
    if (obj.name === 'RightEye' || obj.name === 'RightEye_09') rightEyeBone = obj;
    // First skinned/standard mesh that carries ARKit blendshapes = the face.
    if (obj.isMesh && obj.morphTargetDictionary && !faceMesh) faceMesh = obj;
  });
  console.log('Face morph targets:', faceMesh ? Object.keys(faceMesh.morphTargetDictionary).length : 0);

  // Rotate the whole model for head/body movement — avoids neck artifacts
  headBone = model;

  if (leftEyeBone)  restL    = leftEyeBone.rotation.clone();
  if (rightEyeBone) restR    = rightEyeBone.rotation.clone();
  restHead = model.rotation.clone();
  console.log('Bones found — leftEye:', !!leftEyeBone, 'rightEye:', !!rightEyeBone);
  console.log('restHead:', restHead);

  // Use actual eye bone world positions for precise camera targeting
  const box  = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const near = size.y * 0.001, far = size.y * 20;

  const posL = new THREE.Vector3(), posR = new THREE.Vector3();
  leftEyeBone.getWorldPosition(posL);
  rightEyeBone.getWorldPosition(posR);
  const eyeMid = new THREE.Vector3().addVectors(posL, posR).multiplyScalar(0.5);

  // Head-fixed (right): close-up, eye midpoint target
  headCam.position.set(eyeMid.x, eyeMid.y, eyeMid.z + size.y * 0.18);
  headCam.lookAt(eyeMid);
  headCam.near = near; headCam.far = far; headCam.updateProjectionMatrix();

  // ── Target + gaze-ray anchor ──────────────────────────────────────────────
  // The skinned head renders WITHOUT the faceMesh node offset, so the rendered
  // eye = the bone world position mapped into faceMesh-local space (offset
  // removed). Confirmed on-screen: this point lands exactly on the eyes.
  _restEyeMid = faceMesh.worldToLocal(eyeMid.clone());
  // World units per metre, referenced to the SIM's IPD (SensoryParams.ipd = 0.064 m)
  // so the avatar's eye separation matches the IPD the sim used for the per-eye
  // angles — i.e. the two gaze rays converge exactly on the target.
  _modelUnit  = posL.distanceTo(posR) / 0.064;

  model.updateMatrixWorld(true);
  const qL0 = leftEyeBone.getWorldQuaternion(new THREE.Quaternion());
  const qR0 = rightEyeBone.getWorldQuaternion(new THREE.Quaternion());
  _gazeAxisL = new THREE.Vector3(0, 0, 1).applyQuaternion(qL0.clone().invert());
  _gazeAxisR = new THREE.Vector3(0, 0, 1).applyQuaternion(qR0.clone().invert());
  // World forward at rest is +Z; store it in the head bone's local frame so the
  // (head-fixed) cover patch can sit in front of the eye along HEAD forward,
  // independent of where the eye is pointing.
  if (headBone) {
    const qH0 = headBone.getWorldQuaternion(new THREE.Quaternion());
    _headLocalFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(qH0.invert());
    // Rest offset (world space) from each eye BONE position to the calibrated
    // rendered-eye anchor. eyeWorldPos = live bone world pos (already tracks head
    // rotation) + this offset rotated by the head's rotation since rest. This
    // makes the ray/cover origin orbit with the head during VOR. (faceMesh.world
    // ToLocal alone is model-rotation-invariant — it pinned origins to rest.)
    const _t = new THREE.Vector3(), _b = new THREE.Vector3();
    leftEyeBone.getWorldPosition(_b);  faceMesh.worldToLocal(_t.copy(_b));
    _eyeOffL = _t.sub(_b).clone();
    rightEyeBone.getWorldPosition(_b); faceMesh.worldToLocal(_t.copy(_b));
    _eyeOffR = _t.sub(_b).clone();
    _headQuatRestInv = headBone.getWorldQuaternion(new THREE.Quaternion()).invert();
  }

  // Normal opaque material so the head correctly occludes the props (a target
  // in front of the face is hidden by the head from the behind camera).
  // frustumCulled:false because per-frame repositioning + dual-camera rendering
  // otherwise wrongly culls them.
  const overlay = (color) => new THREE.MeshBasicMaterial({ color, toneMapped: false });
  // Layer 0 (proven to render in the world view); hidden from the head-fixed
  // close-up manually in renderViewports. (Layer 1 did not render reliably here.)
  const prop = (mesh) => { mesh.frustumCulled = false; mesh.visible = false;
                           scene.add(mesh); return mesh; };

  targetSphere = prop(new THREE.Mesh(new THREE.SphereGeometry(0.022 * _modelUnit, 20, 14), overlay(0xe23b3b)));
  gazeRayL = prop(new THREE.Mesh(new THREE.CylinderGeometry(0.004 * _modelUnit, 0.004 * _modelUnit, 1, 8), overlay(0x2166ac)));   // left  — blue (matches plots)
  gazeRayR = prop(new THREE.Mesh(new THREE.CylinderGeometry(0.004 * _modelUnit, 0.004 * _modelUnit, 1, 8), overlay(0xd6604d)));   // right — red  (matches plots)

  // ── World dot-cloud (visual surround) ─────────────────────────────────────
  // A low-contrast box of dots around the eye. World-fixed (added to scene, not
  // the head): stays put during head rotation (VOR), rotates with the scene's
  // angular position (OKN), and wraps around the eye as the head translates
  // (locomotion) for seamless optic flow at any distance.
  {
    const N = 1800, H = 6 * _modelUnit, hole = 1.2 * _modelUnit;
    _dotH = H;
    // World-space dot sizes (metres) with sizeAttenuation:true → dots shrink
    // with distance like real objects (perspective), instead of a fixed pixel
    // size. Three discrete sizes via three Points layers (PointsMaterial has one
    // global size); most dots small, a few large. SIZE × _modelUnit converts
    // metres → world units. Round sprite texture so big dots aren't blocky.
    const SIZES = [0.05, 0.12, 0.26];   // metres
    const FRAC  = [0.55, 0.30, 0.15];   // share of dots per size
    const dotTex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const g = c.getContext('2d');
      g.beginPath(); g.arc(32, 32, 30, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
      const t = new THREE.CanvasTexture(c); return t;
    })();
    sceneDots = new THREE.Group();
    sceneDots.position.copy(_restEyeMid);   // centred on the eye; rotates about it
    sceneDots.frustumCulled = false;
    sceneDots.visible = false;
    _dotLayers = [];
    for (let s = 0; s < SIZES.length; s++) {
      const n = Math.round(N * FRAC[s]);
      const base = new Float32Array(n * 3);
      const arr  = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        let x, y, z;
        do { x = (Math.random()*2-1)*H; y = (Math.random()*2-1)*H; z = (Math.random()*2-1)*H; }
        while (x*x + y*y + z*z < hole*hole);   // no dots inside the head
        base[i*3] = x; base[i*3+1] = y; base[i*3+2] = z;
        arr[i*3]  = x; arr[i*3+1]  = y; arr[i*3+2]  = z;
      }
      const dg = new THREE.BufferGeometry();
      dg.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      const pts = new THREE.Points(dg, new THREE.PointsMaterial({
        color: 0x9aa2ae, size: SIZES[s] * _modelUnit, sizeAttenuation: true,
        map: dotTex, alphaTest: 0.1,
        transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false }));
      pts.frustumCulled = false;
      sceneDots.add(pts);
      _dotLayers.push({ geom: dg, base });
    }
    scene.add(sceneDots);
  }


  // World (left) camera: stable side-three-quarter framing of head + target,
  // set ONCE here (after the model loads) so it never races the async load.
  // World camera: store reference frame, then apply the default view. Switch
  // views with d (default) / t (top) / l (left) / r (right).
  _camRefEye = eyeMid.clone(); _camRefSize = size.y; _camNear = near; _camFar = far;
  setWorldView('default');

  // Eye-cover patches: an opaque disc over a covered eyeball, shown when that eye
  // is in darkness (monocular cover). Anchored per-frame to the rendered eye (the
  // same faceMesh-local-of-bone point the target/rays use), in the scene so it
  // appears in both views. Sits in FRONT of the eye and is clearly bigger than
  // it: ~5 cm diameter (radius 0.025 m). Medium gray (not near-black) so it
  // stays visible against the dark eye/socket.
  const coverGeo = new THREE.SphereGeometry(0.025 * _modelUnit, 20, 14);
  const coverMat = new THREE.MeshBasicMaterial({ color: 0x6a6a6a, toneMapped: false });
  coverMeshL = new THREE.Mesh(coverGeo, coverMat);
  coverMeshR = new THREE.Mesh(coverGeo, coverMat);
  coverMeshL.frustumCulled = false; coverMeshR.frustumCulled = false;
  coverMeshL.visible = false;       coverMeshR.visible = false;
  scene.add(coverMeshL); scene.add(coverMeshR);

  document.getElementById('avatar-loading').style.display = 'none';

}, undefined, err => {
  console.error('Avatar load error:', err);
  document.getElementById('avatar-loading').textContent = 'Avatar failed to load';
});

// ── Eyelids (ARKit blendshapes) ────────────────────────────────────────────────
function setMorph(name, value) {
  if (!faceMesh) return;
  const i = faceMesh.morphTargetDictionary[name];
  if (i !== undefined) faceMesh.morphTargetInfluences[i] = value;
}

// Spontaneous blink: a short 0->1->0 close every few seconds (real-time clock,
// so the avatar looks alive even when paused). Advanced from animate(ts).
let _blink = 0;
let _nextBlinkTs = 0;
function updateBlink(ts) {
  if (_nextBlinkTs === 0) { _nextBlinkTs = ts + 2000 + Math.random() * 3500; return; }
  const since = ts - _nextBlinkTs;      // >= 0 once the blink has started
  const DUR = 150;                      // ms
  if (since >= 0 && since <= DUR) {
    const ph = since / DUR;
    _blink = ph < 0.5 ? ph * 2 : (1 - ph) * 2;   // triangle 0->1->0
  } else if (since > DUR) {
    _blink = 0;
    _nextBlinkTs = ts + 2000 + Math.random() * 3500;
  }
}

// ── Bone application ──────────────────────────────────────────────────────────
const DEG = Math.PI / 180;
const _UP = new THREE.Vector3(0, 1, 0);

// Map a sim target (metres, world Cartesian: x=right, y=up, z=forward) to a world
// offset from the eye. TRUE distance (no compression) so the two per-eye gaze
// rays actually converge on the sphere — compressing it would move the sphere off
// the convergence point. Sign on x matches the rendered eye (rightward → world −X).
function targetWorld(p) {
  return new THREE.Vector3(-p[0], p[1], p[2]).multiplyScalar(_modelUnit).add(_restEyeMid);
}

// Eye-centre world position + gaze direction. Uses the LIVE bone world position
// (which orbits with the head, headBone = model) plus the rest bone→eye offset
// rotated by the head's rotation since rest, so the origin tracks head rotation
// (VOR). At rest the delta is identity → the calibrated rest anchor.
const _rQ = new THREE.Quaternion();
const _qNow = new THREE.Quaternion(), _qDelta = new THREE.Quaternion();
function eyeWorldPos(bone, out) {
  bone.getWorldPosition(out);
  if (_eyeOffL && headBone && _headQuatRestInv) {
    headBone.getWorldQuaternion(_qNow);
    _qDelta.copy(_qNow).multiply(_headQuatRestInv);          // head rotation since rest
    const off = (bone === rightEyeBone ? _eyeOffR : _eyeOffL).clone().applyQuaternion(_qDelta);
    return out.add(off);
  }
  return faceMesh.worldToLocal(out);                          // fallback (pre-capture)
}
function eyeGazeDir(bone, axis) {
  bone.getWorldQuaternion(_rQ);
  return axis.clone().applyQuaternion(_rQ).normalize();
}

// Closest-approach midpoint of the two gaze lines (the vergence point). Returns
// null if they're ~parallel or diverging (looking at "infinity").
function convergePoint(oL, dL, oR, dR) {
  const r = oL.clone().sub(oR);
  const b = dL.dot(dR), d = dL.dot(r), e = dR.dot(r);
  const denom = 1 - b * b;
  if (Math.abs(denom) < 1e-4) return null;
  const tL = (b * e - d) / denom, tR = (e - b * d) / denom;
  if (tL <= 0 || tR <= 0) return null;
  return oL.clone().addScaledVector(dL, tL)
    .add(oR.clone().addScaledVector(dR, tR)).multiplyScalar(0.5);
}

// Lay a cylinder from origin o along unit dir d for length len.
function setRay(cyl, o, d, len) {
  len = Math.max(0.02, len);
  cyl.position.copy(o).addScaledVector(d, len / 2);
  cyl.quaternion.setFromUnitVectors(_UP, d);
  cyl.scale.set(1, len, 1);
  cyl.visible = true;
}

// Head forward in world space (head-fixed; independent of eye rotation). Falls
// back to +Z if there is no head bone.
const _fwdTmp = new THREE.Vector3();
function headForward() {
  if (headBone && _headLocalFwd) {
    headBone.getWorldQuaternion(_rQ);
    return _fwdTmp.copy(_headLocalFwd).applyQuaternion(_rQ).normalize();
  }
  return _fwdTmp.set(0, 0, 1);
}

// Re-anchor the (visible) cover spheres. Called once per render pass, AFTER the
// head bone is set to its pose, so the cover tracks the head in both the world
// view (head rotated) and the head-fixed view (head reset to rest).
//
// The patch is HEAD-FIXED (it sits on glasses): anchored at the eyeball centre
// (the bone origin, which doesn't move when the eye rotates) and pushed forward
// along HEAD forward — NOT gaze — so it stays put while the eye roves beneath it.
const _COVER_FWD = 0.028;   // metres forward — sits clearly in front of the eyeball
function anchorCovers() {
  if (!coverMeshL || !faceMesh || !leftEyeBone) return;
  const fwd = headForward();
  if (coverMeshL.visible)
    eyeWorldPos(leftEyeBone,  coverMeshL.position).addScaledVector(fwd, _COVER_FWD * _modelUnit);
  if (coverMeshR.visible)
    eyeWorldPos(rightEyeBone, coverMeshR.position).addScaledVector(fwd, _COVER_FWD * _modelUnit);
}

// eye_pos in simulation = head-fixed plant state [yaw, pitch, roll] deg
// head_pos              = integrated head velocity [yaw, pitch, roll] deg
function applyFrame(fi) {
  if (!leftEyeBone || !rightEyeBone || !_traj) return;
  const L = _traj.left[fi];
  const R = _traj.right[fi];

  leftEyeBone.rotation.set(
    restL.x - L[1] * DEG,   // pitch
    restL.y - L[0] * DEG,   // yaw
    restL.z
  );
  rightEyeBone.rotation.set(
    restR.x - R[1] * DEG,
    restR.y - R[0] * DEG,
    restR.z
  );

  // Head rotation for world view (applied before left render, removed before right)
  if (headBone && _traj.head) {
    const Hd = _traj.head[fi];
    headBone.rotation.set(
      restHead.x - Hd[1] * DEG,   // pitch
      restHead.y - Hd[0] * DEG,   // yaw
      restHead.z
    );
  }

  // Cover patches: a near-black sphere over a covered eye. Set visibility here
  // (for the world-view render, head rotated); anchorCovers() positions them and
  // is called again after the head reset for the head-fixed render.
  if (coverMeshL && faceMesh) {
    coverMeshL.visible = !!(_traj.cover_L && _traj.cover_L[fi]);
    coverMeshR.visible = !!(_traj.cover_R && _traj.cover_R[fi]);
    anchorCovers();
  }

  // Eyelids: spontaneous blink + upper lid follows vertical gaze (downgaze
  // lowers the lid via eyeBlink; upgaze retracts it via eyeWide). L/R = [yaw,
  // pitch, roll] deg; pitch > 0 = up.
  if (faceMesh) {
    const downL = Math.max(0, -L[1]) / 70, upL = Math.max(0, L[1]) / 45;
    const downR = Math.max(0, -R[1]) / 70, upR = Math.max(0, R[1]) / 45;
    setMorph('eyeBlinkLeft',  Math.min(1, Math.max(_blink, downL * 0.4)));
    setMorph('eyeBlinkRight', Math.min(1, Math.max(_blink, downR * 0.4)));
    setMorph('eyeWideLeft',  Math.min(0.5, upL) * (1 - _blink));
    setMorph('eyeWideRight', Math.min(0.5, upR) * (1 - _blink));
  }

  // Target sphere (world-fixed) — only when a foveal target is present.
  if (targetSphere && _restEyeMid) {
    const present = _traj.target && _traj.target[fi] &&
                    (!_traj.target_present || !!_traj.target_present[fi]);
    targetSphere.visible = !!present;
    if (present) targetSphere.position.copy(targetWorld(_traj.target[fi]));
  }

  // Gaze rays — ALWAYS shown in the world view. Length runs to the target if one
  // is present, else to the two rays' vergence point, else a 1 m default.
  if (gazeRayL && _restEyeMid && faceMesh) {
    const oL = eyeWorldPos(leftEyeBone,  new THREE.Vector3());
    const oR = eyeWorldPos(rightEyeBone, new THREE.Vector3());
    const dL = eyeGazeDir(leftEyeBone,  _gazeAxisL);
    const dR = eyeGazeDir(rightEyeBone, _gazeAxisR);
    let lenL, lenR;
    if (targetSphere.visible) {
      lenL = targetSphere.position.distanceTo(oL);
      lenR = targetSphere.position.distanceTo(oR);
    } else {
      const c = convergePoint(oL, dL, oR, dR);
      if (c) { lenL = c.clone().sub(oL).dot(dL); lenR = c.clone().sub(oR).dot(dR); }
      else   { lenL = lenR = 1.0 * _modelUnit; }   // parallel/diverging → 1 m
    }
    setRay(gazeRayL, oL, dL, lenL);
    setRay(gazeRayR, oR, dR, lenR);
  }

  // World dot-cloud: rotate with the scene (OKN) and flow opposite the head's
  // linear motion (locomotion). Hidden when the scene is off (dark).
  if (sceneDots) {
    const present = !_traj.scene_present || !!_traj.scene_present[fi];
    sceneDots.visible = present && !!(_traj.scene_pos || _traj.head_lin_pos);
    if (sceneDots.visible) {
      // Translational optic flow: shift dots opposite the head displacement,
      // wrapping the box so the field never runs out. (avatar x = −sim x.)
      const hd = _traj.head_lin_pos && _traj.head_lin_pos[fi];
      if (hd && _dotLayers) {
        const u = _modelUnit, H = _dotH, m = 2 * H;
        const dx = hd[0] * u, dy = hd[1] * u, dz = hd[2] * u;
        const wrap = (v) => { let x = (v + H) % m; if (x < 0) x += m; return x - H; };
        for (const layer of _dotLayers) {
          const buf = layer.geom.attributes.position.array, b = layer.base;
          for (let i = 0; i < buf.length; i += 3) {
            buf[i]     = wrap(b[i]     + dx);   // + because avatar x is flipped
            buf[i + 1] = wrap(b[i + 1] - dy);
            buf[i + 2] = wrap(b[i + 2] - dz);
          }
          layer.geom.attributes.position.needsUpdate = true;
        }
      }
      // Rotational drift (OKN): rotate the whole field about the eye.
      const sp = _traj.scene_pos && _traj.scene_pos[fi];
      if (sp) sceneDots.rotation.set(-sp[1] * DEG, -sp[0] * DEG, sp[2] * DEG);
    }
  }
}

// ── Playback ──────────────────────────────────────────────────────────────────
let _traj      = null;
let _frame     = 0;
let _playing   = false;
let _lastRafTs = null;
let _headMoves = false;

function updateTimeDisplay(fi) {
  if (!_traj) return;
  document.getElementById('time-display').textContent =
    `${(fi / _traj.fps).toFixed(1)} / ${_traj.duration_s.toFixed(1)} s`;
  // Sync the plot time-cursor to the current playback/scrub time.
  if (window.setPlotTime) window.setPlotTime(fi / _traj.fps);
}

window.loadEyeTrajectory = function(traj) {
  _traj    = traj;
  _frame   = 0;
  _playing = false;

  // Detect meaningful head movement (any axis > 1 deg peak displacement)
  _headMoves = false;
  if (traj.head) {
    const maxDisp = Math.max(
      ...traj.head.map(h => Math.sqrt(h[0]*h[0] + h[1]*h[1] + h[2]*h[2]))
    );
    _headMoves = maxDisp > 1.0;
  }

  // One-time diagnostic: if a trajectory has any cover_L/R frames > 0,
  // log it so we can see in the console that the data path is intact.
  // (Data flows: stimuli.build_visual_flags → simulate → server _build_traj
  //  → cover_L/cover_R int arrays → window.loadEyeTrajectory.)
  if (traj.cover_L || traj.cover_R) {
    const sumL = (traj.cover_L || []).reduce((a, b) => a + b, 0);
    const sumR = (traj.cover_R || []).reduce((a, b) => a + b, 0);
    console.log(`Cover data: L=${sumL} frames covered, R=${sumR} frames covered.`);
  }

  // A foveal target — or a moving visual scene (OKN) — makes the world view
  // meaningful even without head movement.
  _hasTarget = !!traj.target && (!traj.target_present || traj.target_present.some(v => v));
  _hasScene  = !!traj.scene_pos && !!traj.scene_present && traj.scene_present.some(v => v)
    && Math.max(...traj.scene_pos.map(p => Math.hypot(p[0], p[1], p[2]))) > 1.0;
  _hasLocomotion = !!traj.head_lin_pos
    && Math.max(...traj.head_lin_pos.map(p => Math.hypot(p[0], p[1], p[2]))) > 0.1;
  _showWorld = _headMoves || _hasTarget || _hasScene || _hasLocomotion;

  // Show/hide world-view label + divider
  const labels = document.querySelectorAll('.avatar-labels span');
  if (labels[0]) labels[0].style.display = _showWorld ? '' : 'none';
  const wrap = document.querySelector('.avatar-wrap');
  if (wrap) wrap.classList.toggle('single-view', !_showWorld);

  document.getElementById('play-btn').textContent = '▶';
  document.getElementById('scrubber').max         = traj.n_frames - 1;
  document.getElementById('scrubber').value       = 0;
  updateTimeDisplay(0);
  applyFrame(0);
};

window._avatarTogglePlay = function() {
  if (!_traj) return;
  _playing = !_playing;
  if (_playing) {
    if (_frame >= _traj.n_frames - 1) _frame = 0;
    _lastRafTs = null;
    document.getElementById('play-btn').textContent = '⏸';
  } else {
    document.getElementById('play-btn').textContent = '▶';
  }
};

window._avatarOnScrub = function(val) {
  if (!_traj) return;
  _frame = val; _lastRafTs = null;
  applyFrame(val);
  updateTimeDisplay(val);
};

// ── Render loop (scissor split) ───────────────────────────────────────────────
function renderViewports() {
  const w = W(), h = H();
  const fi = Math.min(Math.floor(_frame), _traj ? _traj.n_frames - 1 : 0);

  renderer.clear();

  if (_showWorld) {
    // Split: left = world view, right = head-fixed view
    const hw = Math.floor(w / 2);
    const a  = hw / h;
    worldCam.aspect = a; worldCam.updateProjectionMatrix();
    headCam.fov = 28; headCam.aspect = a; headCam.updateProjectionMatrix();

    // Left — world view: apply head rotation
    applyFrame(fi);
    renderer.setViewport(0, 0, hw, h);
    renderer.setScissor(0, 0, hw, h);
    renderer.setScissorTest(true);
    renderer.render(scene, worldCam);

    // Right — head-fixed view: head bone at rest, eyes unchanged. Hide the
    // world-only props (target + rays) so they don't clutter the eyeball close-up.
    if (headBone && restHead) headBone.rotation.copy(restHead);
    anchorCovers();   // re-anchor covers to the rest-head eyeball for the head view
    const _pv = [targetSphere, gazeRayL, gazeRayR].map(m => m && m.visible);
    [targetSphere, gazeRayL, gazeRayR].forEach(m => { if (m) m.visible = false; });
    renderer.setViewport(hw, 0, w - hw, h);
    renderer.setScissor(hw, 0, w - hw, h);
    renderer.render(scene, headCam);
    [targetSphere, gazeRayL, gazeRayR].forEach((m, i) => { if (m) m.visible = _pv[i]; });
  } else {
    // No head movement — single full-width head-fixed view, zoomed in on eyes
    headCam.fov = 14; headCam.aspect = w / h; headCam.updateProjectionMatrix();
    applyFrame(fi);
    if (headBone && restHead) headBone.rotation.copy(restHead);
    anchorCovers();   // re-anchor covers to the rest-head eyeball for the head view
    renderer.setViewport(0, 0, w, h);
    renderer.setScissor(0, 0, w, h);
    renderer.setScissorTest(true);
    renderer.render(scene, headCam);
  }
}

function animate(ts) {
  requestAnimationFrame(animate);
  updateBlink(ts);   // spontaneous blink (eyelids), independent of playback

  if (_playing && _traj) {
    if (_lastRafTs !== null) {
      _frame += (ts - _lastRafTs) / 1000 * _traj.fps;
      if (_frame >= _traj.n_frames) {
        _frame = _traj.n_frames - 1; _playing = false;
        document.getElementById('play-btn').textContent = '▶';
      }
      const fi = Math.min(Math.floor(_frame), _traj.n_frames - 1);
      applyFrame(fi);
      document.getElementById('scrubber').value = fi;
      updateTimeDisplay(fi);
    }
    _lastRafTs = ts;
  }

  renderViewports();
}
requestAnimationFrame(animate);

// Temporary world-camera view controls: d=default, t=top, l=left, r=right.
// Ignored while typing in a form field.
window.addEventListener('keydown', (e) => {
  if (e.target && /^(input|textarea|select)$/i.test(e.target.tagName)) return;
  const k = e.key.toLowerCase();
  if      (k === 'd') setWorldView('default');
  else if (k === 't') setWorldView('top');
  else if (k === 'l') setWorldView('left');
  else if (k === 'r') setWorldView('right');
});
