import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SkeletonHelper } from 'three';

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

// 플레이어 컨트롤러와 FBX 모델을 분리한다.
// FBX의 시각적 정면(로컬 -Z)을 그대로 플레이어의 앞 방향으로 사용한다.
let player = null;
let rat = null;
let mixer = null;
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
let verticalVelocity = 0;
let grounded = true;
let movementState = 'idle';
let lastTime = performance.now();
let frameCounter = 0;
let fpsTime = performance.now();

const MOVE_SPEED = 2.5;
const RUN_SPEED = 5.0;
const GRAVITY = 11;
const JUMP_SPEED = 5.0;
const STATE_FADE = 0.12;

// 행동별 연결된 clip index. -1은 애니메이션 없음.
const stateAnimation = {
  idle: -1,
  walk: -1,
  jump: -1,
  run: -1
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

function setupStateSelect(selectId) {
  const select = $(selectId);
  select.innerHTML = '';
  const none = document.createElement('option');
  none.value = '-1';
  none.textContent = '없음 (Bind Pose)';
  select.appendChild(none);

  clips.forEach((clip, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `${index}: ${clip.name || `Clip ${index}`} (${clip.duration.toFixed(2)}s)`;
    select.appendChild(option);
  });
  return select;
}

function findClipIndex(patterns) {
  for (const pattern of patterns) {
    const index = clips.findIndex((clip) => pattern.test((clip.name || '').toLowerCase()));
    if (index >= 0) return index;
  }
  return -1;
}

function configureAnimationMapping() {
  stateAnimation.idle = findClipIndex([/idle/, /stand/, /breath/, /rest/]);
  stateAnimation.walk = findClipIndex([/walk/, /move/, /locomotion/]);
  stateAnimation.run = findClipIndex([/run/, /sprint/]);
  stateAnimation.jump = findClipIndex([/jump/, /leap/, /hop/]);

  const idleSelect = setupStateSelect('idleSelect');
  const walkSelect = setupStateSelect('walkSelect');
  const jumpSelect = setupStateSelect('jumpSelect');

  idleSelect.value = String(stateAnimation.idle);
  walkSelect.value = String(stateAnimation.walk >= 0 ? stateAnimation.walk : stateAnimation.run);
  jumpSelect.value = String(stateAnimation.jump);

  // 사용자가 상태별 애니메이션을 직접 지정할 수 있다.
  idleSelect.addEventListener('change', () => {
    stateAnimation.idle = Number(idleSelect.value);
    if (movementState === 'idle') updateAnimationState(true);
  });
  walkSelect.addEventListener('change', () => {
    stateAnimation.walk = Number(walkSelect.value);
    if (movementState === 'walk' || movementState === 'run') updateAnimationState(true);
  });
  jumpSelect.addEventListener('change', () => {
    stateAnimation.jump = Number(jumpSelect.value);
    if (movementState === 'jump') updateAnimationState(true);
  });

  const hasEnoughNamedStates = stateAnimation.idle >= 0 && stateAnimation.walk >= 0 && stateAnimation.jump >= 0;
  if (!hasEnoughNamedStates) {
    console.warn(
      'FBX에서 Idle/Walk/Jump용 별도 클립을 모두 찾지 못했습니다. ' +
      '현재 파일에 Take 001 하나만 있다면 FBX 내부의 동작을 자동으로 나눌 수 없습니다.'
    );
  }
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

  // 모델 높이를 2.2 기준으로 맞춘다.
  const box = new THREE.Box3().setFromObject(rat);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim > 0) {
    const modelScale = 2.2 / maxDim;
    rat.scale.setScalar(modelScale);
  }

  // 스케일 적용 후 모델 발밑이 y=0이 되도록 조정한다.
  const scaledBox = new THREE.Box3().setFromObject(rat);
  rat.position.y -= scaledBox.min.y;

  let skeletonCount = 0;
  rat.traverse((node) => {
    if (node.isBone) skeletonCount++;
  });
  $('boneCount').textContent = String(skeletonCount);

  skeletonHelper = new SkeletonHelper(rat);
  skeletonHelper.visible = false;
  scene.add(skeletonHelper);

  // 이 축은 FBX의 실제 로컬축을 직접 확인하기 위한 용도다.
  modelAxes = new THREE.AxesHelper(Math.max(0.5, 1.3));
  modelAxes.visible = false;
  rat.add(modelAxes);

  player.position.set(0, 0, 0);
  player.rotation.y = 0;

  const center = new THREE.Vector3();
  new THREE.Box3().setFromObject(player).getCenter(center);
  orbit.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(4, 2.7, 5));
  orbit.update();
}

function setupAnimations(object) {
  clips = Array.isArray(object.animations) ? object.animations : [];
  mixer = new THREE.AnimationMixer(object);

  $('clipCount').textContent = String(clips.length);

  const select = $('animationSelect');
  select.innerHTML = '';
  clips.forEach((clip, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `${index}: ${clip.name || `Clip ${index}`} (${clip.duration.toFixed(2)}s)`;
    select.appendChild(option);
  });

  clips.forEach((clip, index) => {
    const action = mixer.clipAction(clip);
    action.enabled = true;
    action.setEffectiveWeight(0);
    action.loop = THREE.LoopRepeat;
    action.clampWhenFinished = false;
    action.stop();
    actions.set(index, action);
  });

  $('animationSelect').disabled = clips.length === 0;
  $('playButton').disabled = clips.length === 0;
  $('stopButton').disabled = clips.length === 0;
  $('resetButton').disabled = false;

  configureAnimationMapping();
  movementState = 'idle';
  updateAnimationState(true);

  if (clips.length === 1 && stateAnimation.idle < 0 && stateAnimation.walk < 0 && stateAnimation.jump < 0) {
    $('currentAnimation').textContent = '자동 재생 없음: 행동별 클립 지정 필요';
  } else if (!clips.length) {
    $('currentAnimation').textContent = '애니메이션 클립 없음';
  }
}

function fadeToAction(index, loopMode = THREE.LoopRepeat, reset = true) {
  // index가 -1이면 모든 자동 애니메이션을 멈춘다.
  if (index < 0 || !actions.has(index)) {
    actions.forEach((action) => action.stop());
    currentAction = null;
    currentAnimationIndex = -1;
    $('currentAnimation').textContent = '없음 (Bind Pose)';
    return;
  }

  const next = actions.get(index);
  if (currentAction === next && !reset) return;

  if (currentAction && currentAction !== next) {
    currentAction.fadeOut(STATE_FADE);
  }

  next.enabled = true;
  next.setLoop(loopMode, loopMode === THREE.LoopOnce ? 1 : Infinity);
  next.clampWhenFinished = loopMode === THREE.LoopOnce;
  if (reset) next.reset();
  next.fadeIn(STATE_FADE).play();

  currentAction = next;
  currentAnimationIndex = index;
  $('currentAnimation').textContent = clips[index]?.name || `Clip ${index}`;
}

function updateAnimationState(force = false) {
  if (!mixer || !clips.length || !player) return;

  const moving = desiredDirection.lengthSq() > 0.0001;
  const running = moving && (hasKey('ShiftLeft') || hasKey('ShiftRight')) && stateAnimation.run >= 0;
  const nextState = !grounded ? 'jump' : (running ? 'run' : (moving ? 'walk' : 'idle'));

  if (!force && nextState === movementState) return;
  movementState = nextState;

  let index = -1;
  let label = '대기';
  let loopMode = THREE.LoopRepeat;

  if (nextState === 'idle') {
    index = stateAnimation.idle;
    label = '대기';
  } else if (nextState === 'walk') {
    index = stateAnimation.walk;
    label = '걷기';
  } else if (nextState === 'run') {
    index = stateAnimation.run >= 0 ? stateAnimation.run : stateAnimation.walk;
    label = '달리기';
  } else if (nextState === 'jump') {
    index = stateAnimation.jump;
    label = '점프';
    loopMode = THREE.LoopOnce;
  }

  $('movementState').textContent = label;
  fadeToAction(index, loopMode, true);
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
  verticalVelocity = 0;
  grounded = true;
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

  // 핵심 수정:
  // 키 입력을 월드 X/Z에 직접 대입하지 않고, 플레이어의 로컬 축으로 변환한다.
  // Three.js의 getWorldDirection()은 로컬 -Z를 바라보므로 FBX의 정면과 일치한다.
  player.getWorldDirection(forward);
  forward.y = 0;
  forward.normalize();

  right.set(1, 0, 0).applyQuaternion(player.quaternion);
  right.y = 0;
  right.normalize();

  localInput.set(0, 0, 0);
  localInput.addScaledVector(forward, forwardInput);
  localInput.addScaledVector(right, strafeInput);

  if (localInput.lengthSq() > 1) localInput.normalize();
  desiredDirection.copy(localInput);

  const speed = (hasKey('ShiftLeft') || hasKey('ShiftRight')) ? RUN_SPEED : MOVE_SPEED;
  const targetVelocity = desiredDirection.clone().multiplyScalar(speed);
  velocity.lerp(targetVelocity, 1 - Math.exp(-12 * dt));

  player.position.addScaledVector(velocity, dt);

  // 모델의 정면 방향은 유지한다.
  // WASD가 모델의 로컬축을 따르므로, 월드 축과 모델 축이 달라도 이동 방향이 어긋나지 않는다.

  if (!grounded) {
    verticalVelocity -= GRAVITY * dt;
    player.position.y += verticalVelocity * dt;
    if (player.position.y <= 0) {
      player.position.y = 0;
      verticalVelocity = 0;
      grounded = true;
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
  if (['KeyW','KeyA','KeyS','KeyD','ShiftLeft','ShiftRight','Space'].includes(event.code)) {
    event.preventDefault();
  }
  keys.add(event.code);

  if (event.code === 'Space' && grounded) {
    verticalVelocity = JUMP_SPEED;
    grounded = false;
    updateAnimationState(true);
  }
});

window.addEventListener('keyup', (event) => keys.delete(event.code));
window.addEventListener('blur', () => keys.clear());

$('playButton').addEventListener('click', () => {
  const index = Number($('animationSelect').value || 0);
  fadeToAction(index, THREE.LoopRepeat, true);
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
    if (xhr.total) {
      $('modelStatus').textContent = `${Math.round((xhr.loaded / xhr.total) * 100)}%`;
    }
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
