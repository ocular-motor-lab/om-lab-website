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

const AVATAR_PATH = 'avatar/scene.gltf';

new GLTFLoader().load(AVATAR_PATH, (gltf) => {
  const model = gltf.scene;
  scene.add(model);

  model.traverse(obj => {
    if (obj.name === 'LeftEye_08')  leftEyeBone  = obj;
    if (obj.name === 'RightEye_09') rightEyeBone = obj;
  });

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

  // World (left): further back so neck is visible, same target
  worldCam.position.set(eyeMid.x, eyeMid.y, eyeMid.z + size.y * 0.26);
  worldCam.lookAt(eyeMid);
  worldCam.near = near; worldCam.far = far; worldCam.updateProjectionMatrix();

  // Build procedural eye-cover patches — black disc parented to the model
  // root (acts as head bone) so they stay head-fixed: the eyeball rotates
  // beneath the disc while the disc stays put on the face.  Visibility is
  // toggled per frame from _traj.cover_L / _traj.cover_R.
  //
  // Material choices that matter:
  //   MeshBasicMaterial   — no lighting required, guaranteed solid black
  //   DoubleSide          — visible from either side (model rotates in world view)
  //   depthTest:false     — never occluded by face mesh
  //   renderOrder: 999    — drawn last so it lands on top of everything
  //   transparent:false   — avoid three.js transparent-sort quirks
  const coverGeo = new THREE.CircleGeometry(size.y * 0.028, 48);
  const coverMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    side: THREE.DoubleSide,
    depthTest:  false,
    depthWrite: false,
    transparent: false,
  });

  // Make sure all matrices are current before computing offsets.
  model.updateMatrixWorld(true);

  // Forward direction (toward camera) in MODEL-local coords.  The camera
  // sits at +Z relative to the eye midpoint in world space; the face is
  // oriented such that this is "out of the head" — exactly what we want.
  const fwdLocalModel = new THREE.Vector3(0, 0, 1)
      .transformDirection(new THREE.Matrix4().copy(model.matrixWorld).invert());

  // Build a temporary "cover anchor" in model-local space, just in front
  // of each eye, then reparent to the model root.  Parenting to model
  // (not the eye bone) keeps the cover head-fixed: the eye rotates
  // beneath the cover, the cover stays put on the face.
  const fwdOffset = size.y * 0.05;

  // posL / posR are world positions of the eye bones — convert to model-local.
  const eyeL_local = model.worldToLocal(posL.clone());
  const eyeR_local = model.worldToLocal(posR.clone());

  coverMeshL = new THREE.Mesh(coverGeo, coverMat);
  coverMeshR = new THREE.Mesh(coverGeo, coverMat.clone());
  coverMeshL.position.copy(eyeL_local).addScaledVector(fwdLocalModel, fwdOffset);
  coverMeshR.position.copy(eyeR_local).addScaledVector(fwdLocalModel, fwdOffset);
  coverMeshL.renderOrder = 999;
  coverMeshR.renderOrder = 999;
  coverMeshL.visible = false;
  coverMeshR.visible = false;
  model.add(coverMeshL);
  model.add(coverMeshR);

  // Orient discs to face the camera.  At load time the model is at its
  // rest pose, so the head-fixed view sees the discs head-on.  In world
  // view the model rotates and the cover rotates with it — DoubleSide
  // material keeps it visible from either side.
  coverMeshL.lookAt(headCam.position);
  coverMeshR.lookAt(headCam.position);

  console.log('Eye-cover meshes created, parented to avatar root, hidden by default.');

  document.getElementById('avatar-loading').style.display = 'none';

}, undefined, err => {
  console.error('Avatar load error:', err);
  document.getElementById('avatar-loading').textContent = 'Avatar failed to load';
});

// ── Bone application ──────────────────────────────────────────────────────────
const DEG = Math.PI / 180;

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

  // Cover patches
  if (coverMeshL) coverMeshL.visible = !!(_traj.cover_L && _traj.cover_L[fi]);
  if (coverMeshR) coverMeshR.visible = !!(_traj.cover_R && _traj.cover_R[fi]);
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

  // Show/hide world-view label + divider
  const labels = document.querySelectorAll('.avatar-labels span');
  if (labels[0]) labels[0].style.display = _headMoves ? '' : 'none';
  const wrap = document.querySelector('.avatar-wrap');
  if (wrap) wrap.classList.toggle('single-view', !_headMoves);

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

  if (_headMoves) {
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

    // Right — head-fixed view: head bone at rest, eyes unchanged
    if (headBone && restHead) headBone.rotation.copy(restHead);
    renderer.setViewport(hw, 0, w - hw, h);
    renderer.setScissor(hw, 0, w - hw, h);
    renderer.render(scene, headCam);
  } else {
    // No head movement — single full-width head-fixed view, zoomed in on eyes
    headCam.fov = 14; headCam.aspect = w / h; headCam.updateProjectionMatrix();
    applyFrame(fi);
    if (headBone && restHead) headBone.rotation.copy(restHead);
    renderer.setViewport(0, 0, w, h);
    renderer.setScissor(0, 0, w, h);
    renderer.setScissorTest(true);
    renderer.render(scene, headCam);
  }
}

function animate(ts) {
  requestAnimationFrame(animate);

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
