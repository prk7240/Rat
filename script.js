import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8ea0ad);
scene.fog = new THREE.Fog(0x8ea0ad, 20, 70);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 300);
camera.position.set(4, 3, 6);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById('app').appendChild(renderer.domElement);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 1, 0);
orbit.enableDamping = true;
orbit.minDistance = 2;
orbit.maxDistance = 18;
orbit.maxPolarAngle = Math.PI * 0.48;

scene.add(new THREE.HemisphereLight(0xffffff, 0x53606b, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 3.0);
sun.position.set(8, 12, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 60;
sun.shadow.camera.left = -20;
sun.shadow.camera.right = 20;
sun.shadow.camera.top = 20;
sun.shadow.camera.bottom = -20;
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(100, 100),
  new THREE.MeshStandardMaterial({ color: 0x6d747a, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(100, 100, 0xb9c0c4, 0x7c858b);
grid.position.y = 0.006;
scene.add(grid);

const origin = new THREE.AxesHelper(2);
origin.position.y = 0.01;
scene.add(origin);

let player = null;
let rat = null;
let mixer = null;
let sourceClip = null;
let clips = [];
const actions = new Map();
let currentAction = null;
let currentAnimationIndex = -1;
let skeletonHelper = null;
let modelAxes = null;

const keys = new Set();
const velocity = new THREE.Vector3();
const desiredDirection = new THREE.Vector3();
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const localInput = new THREE.Vector3();
const cameraTarget = new THREE.Vector3();

let grounded = true;
let movementState = 'idle';
let jumpElapsed = 0;
let lastTime = performance.now();
let frameCounter = 0;
let fpsTime = performance.now();

const MOVE_SPEED = 2.5;
const RUN_SPEED = 4.5;
const STATE_FADE = 0.10;
const ANIMATION_FPS = 30;

// rat.fbx를 분석한 결과.
// 40~80  : Walk  - 네 다리가 대각선으로 교차하는 보행 구간
// 80~120  : Idle  - 다리는 정지하고 척추/머리/꼬리가 미세하게 움직이는 구간
// 240~270 : Jump  - Root 높이가 크게 상승했다가 착지하는 구간
const SOURCE_RANGES = {
  walk: { start: 40, end: 78 },
  idle: { start: 82, end: 117 },
  jump: { start: 240, end: 270 }
};

const $ = (id) => document.getElementById(id);
const loading = $('loading');
const error = $('error');

function setError(message) {
  console.error(message);
  error.textContent = message;
  error.classList.remove('hidden');
  loading.classList.add('hidden');
}

function hasKey(code) {
  return keys.has(code);
}

function setRangeInfo() {
  const fps = ANIMATION_FPS;
  $('idleRange').textContent = `${SOURCE_RANGES.idle.start}–${SOURCE_RANGES.idle.end}F (${((SOURCE_RANGES.idle.end - SOURCE_RANGES.idle.start) / fps).toFixed(2)}s)`;
  $('walkRange').textContent = `${SOURCE_RANGES.walk.start}–${SOURCE_RANGES.walk.end}F (${((SOURCE_RANGES.walk.end - SOURCE_RANGES.walk.start) / fps).toFixed(2)}s)`;
  $('jumpRange').textContent = `${SOURCE_RANGES.jump.start}–${SOURCE_RANGES.jump.end}F (${((SOURCE_RANGES.jump.end - SOURCE_RANGES.jump.start) / fps).toFixed(2)}s)`;
}

function createSeparatedClips(source) {
  const make = (name, range) => {
    const clip = THREE.AnimationUtils.subclip(
      source,
      name,
      range.start,
      range.end,
      ANIMATION_FPS
    );
    // Subclip으로 잘라낸 클립은 시작 시간을 0부터 사용한다.
    clip.resetDuration();
    return clip;
  };

  return [
    make('Rat_Idle', SOURCE_RANGES.idle),
    make('Rat_Walk', SOURCE_RANGES.walk),
    make('Rat_Jump', SOURCE_RANGES.jump)
  ];
}

function updateAnimationList() {
  const select = $('animationSelect');
  select.innerHTML = '';

  clips.forEach((clip, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `${index}: ${clip.name} (${clip.duration.toFixed(2)}s)`;
    select.appendChild(option);
  });

  $('clipCount').textContent = String(clips.length);
  select.disabled = clips.length === 0;
  $('playButton').disabled = clips.length === 0;
  $('stopButton').disabled = clips.length === 0;
}

function prepareModel(object) {
  player = new THREE.Group();
  player.name = 'RatPlayerController';
  scene.add(player);

  rat = object;
  rat.position.set(0, 0, 0);
  player.add(rat);

  rat.traverse((node) => {
    if (!node.isMesh) return;
    node.castShadow = true;
    node.receiveShadow = true;
    if (node.material) {
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach((mat) => {
        if ('skinning' in mat) mat.skinning = true;
      });
    }
  });

  const box = new THREE.Box3().setFromObject(rat);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim > 0) rat.scale.setScalar(2.2 / maxDim);

  const scaledBox = new THREE.Box3().setFromObject(rat);
  rat.position.y -= scaledBox.min.y;

  let skeletonCount = 0;
  rat.traverse((node) => {
    if (node.isBone) skeletonCount++;
  });
  $('boneCount').textContent = String(skeletonCount);

  skeletonHelper = new THREE.SkeletonHelper(rat);
  skeletonHelper.visible = false;
  scene.add(skeletonHelper);

  modelAxes = new THREE.AxesHelper(1.3);
  modelAxes.visible = false;
  rat.add(modelAxes);

  // 중요: FBX 내부에서 Head_CTRL가 Root_CTRL의 +Z 쪽에 있으므로
  // 이 모델의 실제 정면은 로컬 +Z다. Three.js의 기본 -Z 전진축을 사용하지 않는다.
  player.rotation.y = 0;
  player.position.set(0, 0, 0);

  const center = new THREE.Vector3();
  new THREE.Box3().setFromObject(player).getCenter(center);
  orbit.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(4, 2.7, 5));
  orbit.update();
}

function setupAnimations(object) {
  sourceClip = Array.isArray(object.animations) ? object.animations[0] : null;
  mixer = new THREE.AnimationMixer(object);

  if (!sourceClip) {
    clips = [];
    updateAnimationList();
    $('currentAnimation').textContent = '애니메이션 없음';
    return;
  }

  // Take 001 하나를 실제 동작 구간별로 분리한다.
  clips = createSeparatedClips(sourceClip);
  updateAnimationList();
  $('sourceAnimation').textContent = `${sourceClip.name || 'Take 001'} · ${sourceClip.duration.toFixed(2)}s`;

  clips.forEach((clip, index) => {
    const action = mixer.clipAction(clip);
    action.enabled = true;
    action.setEffectiveWeight(0);
    action.stop();
    actions.set(index, action);
  });

  // 사용자 입력이 없어도 "가만히 있음" 상태에서는 Idle만 재생한다.
  movementState = 'idle';
  grounded = true;
  updateAnimationState(true);
}

function fadeToAction(index, loopMode = THREE.LoopRepeat, reset = true) {
  if (index < 0 || !actions.has(index)) {
    actions.forEach((action) => action.stop());
    currentAction = null;
    currentAnimationIndex = -1;
    $('currentAnimation').textContent = '없음 (Bind Pose)';
    return;
  }

  const next = actions.get(index);
  if (currentAction === next && !reset) return;

  if (currentAction && currentAction !== next) currentAction.fadeOut(STATE_FADE);

  next.enabled = true;
  next.setLoop(loopMode, loopMode === THREE.LoopOnce ? 1 : Infinity);
  next.clampWhenFinished = loopMode === THREE.LoopOnce;

  if (reset) next.reset();
  next.setEffectiveWeight(1);
  next.fadeIn(STATE_FADE).play();

  currentAction = next;
  currentAnimationIndex = index;
  $('currentAnimation').textContent = clips[index]?.name || `Clip ${index}`;

  if (loopMode === THREE.LoopOnce) {
    jumpElapsed = 0;
  }
}

function updateAnimationState(force = false) {
  if (!mixer || !player || clips.length < 3) return;

  const moving = desiredDirection.lengthSq() > 0.0001;
  const nextState = !grounded ? 'jump' : (moving ? 'walk' : 'idle');

  if (!force && nextState === movementState) return;
  movementState = nextState;

  if (nextState === 'idle') {
    $('movementState').textContent = '대기';
    fadeToAction(0, THREE.LoopRepeat, true);
  } else if (nextState === 'walk') {
    $('movementState').textContent = hasKey('ShiftLeft') || hasKey('ShiftRight') ? '걷기 · 빠르게' : '걷기';
    fadeToAction(1, THREE.LoopRepeat, true);
  } else {
    $('movementState').textContent = '점프';
    fadeToAction(2, THREE.LoopOnce, true);
  }
}

function stopAnimation() {
  actions.forEach((action) => action.stop());
  currentAction = null;
  currentAnimationIndex = -1;
  $('currentAnimation').textContent = '수동 정지';
}

function resetModel() {
  if (!player) return;
  player.position.set(0, 0, 0);
  player.rotation.set(0, 0, 0);
  velocity.set(0, 0, 0);
  desiredDirection.set(0, 0, 0);
  grounded = true;
  jumpElapsed = 0;
  movementState = 'idle';

  actions.forEach((action) => action.stop());
  currentAction = null;
  currentAnimationIndex = -1;
  updateAnimationState(true);
}

function updateMovement(dt) {
  if (!player) return;

  const forwardInput = (hasKey('KeyW') ? 1 : 0) - (hasKey('KeyS') ? 1 : 0);
  const strafeInput = (hasKey('KeyD') ? 1 : 0) - (hasKey('KeyA') ? 1 : 0);

  // 카메라가 바라보는 수평 방향을 기준으로 이동한다.
  // W = 카메라 정면, S = 카메라 후면, A/D = 카메라 기준 좌/우
  camera.getWorldDirection(forward);
  forward.y = 0;

  // 카메라가 거의 수직으로 내려다보는 상황에서는 수평 전진축이
  // 0에 가까워질 수 있으므로 안전한 기본 방향을 사용한다.
  if (forward.lengthSq() < 0.000001) {
    forward.set(0, 0, -1);
  } else {
    forward.normalize();
  }

  // forward × up = camera 기준 오른쪽
  right.crossVectors(forward, scene.up);
  right.y = 0;
  right.normalize();

  localInput.set(0, 0, 0);
  localInput.addScaledVector(forward, forwardInput);
  localInput.addScaledVector(right, strafeInput);
  if (localInput.lengthSq() > 1) localInput.normalize();
  desiredDirection.copy(localInput);

  // 모델의 실제 정면(+Z)을 이동 방향에 맞춘다.
  // 따라서 카메라가 방향을 바꾸면 W를 눌렀을 때 모델도 카메라 전방을 바라본다.
  if (desiredDirection.lengthSq() > 0.0001) {
    const targetYaw = Math.atan2(desiredDirection.x, desiredDirection.z);
    player.rotation.y = THREE.MathUtils.dampAngle(
      player.rotation.y,
      targetYaw,
      14,
      dt
    );
  }

  const fast = hasKey('ShiftLeft') || hasKey('ShiftRight');
  const speed = fast ? RUN_SPEED : MOVE_SPEED;
  const targetVelocity = desiredDirection.clone().multiplyScalar(speed);
  velocity.lerp(targetVelocity, 1 - Math.exp(-12 * dt));
  player.position.addScaledVector(velocity, dt);

  // Jump 클립 자체에 Root의 상승/하강 키가 들어있기 때문에
  // 이 테스트에서는 별도의 Y 물리를 적용하지 않는다.
  if (!grounded) {
    jumpElapsed += dt;
    const jumpDuration = clips[2]?.duration || 1;
    if (jumpElapsed >= jumpDuration) {
      grounded = true;
      jumpElapsed = 0;
      updateAnimationState(true);
    }
  }

  updateAnimationState(false);
}

function updateCamera() {
  if (!player) return;
  cameraTarget.set(0, 1.0, 0).applyMatrix4(player.matrixWorld);
  orbit.target.lerp(cameraTarget, 0.15);
}

function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  updateMovement(dt);
  if (mixer) mixer.update(dt);
  updateCamera();
  orbit.update();
  renderer.render(scene, camera);

  frameCounter++;
  if (now - fpsTime >= 500) {
    $('fps').textContent = (frameCounter * 1000 / (now - fpsTime)).toFixed(0);
    frameCounter = 0;
    fpsTime = now;
  }
}

window.addEventListener('keydown', (event) => {
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight', 'Space'].includes(event.code)) {
    event.preventDefault();
  }

  const wasDown = keys.has(event.code);
  keys.add(event.code);

  // Space는 최초 입력 순간에만 점프를 시작한다.
  if (event.code === 'Space' && !wasDown && grounded && clips.length >= 3) {
    grounded = false;
    jumpElapsed = 0;
    desiredDirection.set(0, 0, 0);
    updateAnimationState(true);
  }
});

window.addEventListener('keyup', (event) => keys.delete(event.code));
window.addEventListener('blur', () => keys.clear());

$('playButton').addEventListener('click', () => {
  const index = Number($('animationSelect').value || 0);
  fadeToAction(index, index === 2 ? THREE.LoopOnce : THREE.LoopRepeat, true);
});
$('stopButton').addEventListener('click', stopAnimation);
$('resetButton').addEventListener('click', resetModel);
$('skeletonToggle').addEventListener('change', (event) => {
  if (skeletonHelper) skeletonHelper.visible = event.target.checked;
});
$('axesToggle').addEventListener('change', (event) => {
  if (modelAxes) modelAxes.visible = event.target.checked;
});

window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

setRangeInfo();

const loader = new FBXLoader();
loader.load(
  './rat.fbx',
  (object) => {
    try {
      prepareModel(object);
      setupAnimations(object);
      $('modelStatus').textContent = '로딩 성공';
      loading.classList.add('hidden');
    } catch (e) {
      setError(`모델 초기화 중 오류가 발생했습니다.\n\n${e?.stack || e}`);
    }
  },
  (xhr) => {
    if (xhr.total) $('modelStatus').textContent = `${Math.round((xhr.loaded / xhr.total) * 100)}%`;
  },
  (e) => {
    setError(
      'rat.fbx를 불러오지 못했습니다.\n\n' +
      '1) index.html과 rat.fbx가 같은 폴더인지 확인하세요.\n' +
      '2) file://로 직접 열지 말고 로컬 서버로 실행하세요.\n' +
      '3) F12 Console에서 추가 오류를 확인하세요.\n\n' + String(e)
    );
  }
);

animate();
