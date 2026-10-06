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

// Lights
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

// Ground
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

// Runtime state
let rat = null;
let mixer = null;
let clips = [];
let actions = new Map();
let currentAction = null;
let skeletonHelper = null;
let modelAxes = null;
let modelScale = 1;

const keys = new Set();
const velocity = new THREE.Vector3();
const desiredDirection = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);
let verticalVelocity = 0;
let grounded = true;
let lastTime = performance.now();
let frameCounter = 0;
let fpsTime = performance.now();

const MOVE_SPEED = 2.5;
const RUN_SPEED = 5.0;
const GRAVITY = 11;
const JUMP_SPEED = 5.0;

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

function findRoot(object) {
  // FBX는 임포트 후 최상위 Object3D 아래에 Mesh/Skeleton이 배치된다.
  // 캐릭터 이동은 전체 object에 적용한다.
  return object;
}

function prepareModel(object) {
  rat = findRoot(object);
  rat.position.set(0, 0, 0);

  rat.traverse((node) => {
    if (node.isMesh) {
      node.castShadow = true;
      node.receiveShadow = true;
      if (node.material) {
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        materials.forEach((mat) => {
          if ('skinning' in mat) mat.skinning = true;
        });
      }
    }
  });

  // 크기를 자동으로 조정해 테스트하기 좋은 높이로 정규화한다.
  const box = new THREE.Box3().setFromObject(rat);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim > 0) {
    const targetHeight = 2.2;
    modelScale = targetHeight / maxDim;
    rat.scale.setScalar(modelScale);
  }

  // 다시 측정해 바닥에 맞춘다.
  const scaledBox = new THREE.Box3().setFromObject(rat);
  rat.position.y -= scaledBox.min.y;

  scene.add(rat);

  // 리깅/본 구조 확인용
  let skeletonCount = 0;
  rat.traverse((node) => {
    if (node.isBone) skeletonCount++;
  });
  $('boneCount').textContent = String(skeletonCount);

  skeletonHelper = new SkeletonHelper(rat);
  skeletonHelper.visible = false;
  scene.add(skeletonHelper);

  modelAxes = new THREE.AxesHelper(Math.max(0.5, maxDim * modelScale * 0.6));
  modelAxes.visible = false;
  rat.add(modelAxes);

  // 카메라 초기 위치
  const center = new THREE.Vector3();
  new THREE.Box3().setFromObject(rat).getCenter(center);
  orbit.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(4, 2.7, 5));
  orbit.update();
}

function chooseDefaultClip() {
  if (!clips.length) return;
  const lowerNames = clips.map((clip) => clip.name.toLowerCase());

  const idleIndex = lowerNames.findIndex((name) => /(idle|stand|breath|rest)/.test(name));
  const walkIndex = lowerNames.findIndex((name) => /(walk|run|move|locomotion)/.test(name));
  const index = idleIndex >= 0 ? idleIndex : (walkIndex >= 0 ? walkIndex : 0);
  $('animationSelect').value = String(index);
  playClip(index, true);
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
    action.loop = THREE.LoopRepeat;
    action.clampWhenFinished = false;
    actions.set(index, action);
  });

  $('animationSelect').disabled = clips.length === 0;
  $('playButton').disabled = clips.length === 0;
  $('stopButton').disabled = clips.length === 0;
  $('resetButton').disabled = false;

  select.addEventListener('change', () => playClip(Number(select.value), true));

  if (clips.length) chooseDefaultClip();
  else $('currentAnimation').textContent = '애니메이션 클립 없음';
}

function playClip(index, reset = false) {
  if (!mixer || !actions.has(index)) return;
  const next = actions.get(index);
  if (currentAction && currentAction !== next) {
    currentAction.fadeOut(0.15);
  }
  if (reset) next.reset();
  next.fadeIn(0.15).play();
  currentAction = next;
  const name = clips[index]?.name || `Clip ${index}`;
  $('currentAnimation').textContent = name;
}

function stopAnimation() {
  if (!currentAction) return;
  currentAction.stop();
  $('currentAnimation').textContent = '정지';
}

function resetModel() {
  if (!rat) return;
  rat.position.set(0, 0, 0);
  rat.rotation.set(0, 0, 0);
  verticalVelocity = 0;
  grounded = true;
  if (clips.length) {
    const selected = Number($('animationSelect').value || 0);
    playClip(selected, true);
  }
}

function setMovementAnimation() {
  if (!clips.length) return;

  const moving = desiredDirection.lengthSq() > 0.0001;
  const names = clips.map((clip) => (clip.name || '').toLowerCase());
  const candidates = moving
    ? [/run/, /walk/, /move/, /locomotion/]
    : [/idle/, /stand/, /breath/, /rest/];

  let index = -1;
  for (const regex of candidates) {
    index = names.findIndex((name) => regex.test(name));
    if (index >= 0) break;
  }
  if (index < 0) index = 0;

  if (currentAction !== actions.get(index)) {
    $('animationSelect').value = String(index);
    playClip(index, true);
  }
}

function updateMovement(dt) {
  if (!rat) return;

  const forward = (hasKey('KeyW') ? 1 : 0) - (hasKey('KeyS') ? 1 : 0);
  const strafe = (hasKey('KeyD') ? 1 : 0) - (hasKey('KeyA') ? 1 : 0);

  // 월드 기준 WASD 이동: W=북(-Z), S=남(+Z), A=서(-X), D=동(+X)
  desiredDirection.set(strafe, 0, -forward);
  if (desiredDirection.lengthSq() > 1) desiredDirection.normalize();

  const speed = hasKey('ShiftLeft') || hasKey('ShiftRight') ? RUN_SPEED : MOVE_SPEED;
  velocity.lerp(desiredDirection.clone().multiplyScalar(speed), 1 - Math.exp(-12 * dt));

  rat.position.addScaledVector(velocity, dt);

  // 이동 방향으로 모델 회전
  if (desiredDirection.lengthSq() > 0.0001) {
    const targetAngle = Math.atan2(desiredDirection.x, desiredDirection.z);
    // FBX 모델의 정면이 반대라면 아래 + Math.PI 값을 제거/추가하면 된다.
    const correctedAngle = targetAngle + Math.PI;
    let delta = correctedAngle - rat.rotation.y;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    rat.rotation.y += delta * Math.min(1, dt * 12);
  }

  // 간단한 점프/중력
  if (!grounded) {
    verticalVelocity -= GRAVITY * dt;
    rat.position.y += verticalVelocity * dt;
    if (rat.position.y <= 0) {
      rat.position.y = 0;
      verticalVelocity = 0;
      grounded = true;
    }
  }

  setMovementAnimation();
}

function updateCamera() {
  if (!rat) return;
  const target = new THREE.Vector3(0, 1.0, 0).applyMatrix4(rat.matrixWorld);
  orbit.target.lerp(target, 0.15);
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
    const fpsValue = frameCounter * 1000 / (now - fpsTime);
    $('fps').textContent = fpsValue.toFixed(0);
    frameCounter = 0;
    fpsTime = now;
  }
}

// Input
window.addEventListener('keydown', (event) => {
  if (['KeyW','KeyA','KeyS','KeyD','ShiftLeft','ShiftRight','Space'].includes(event.code)) {
    event.preventDefault();
  }
  keys.add(event.code);

  if (event.code === 'Space' && grounded) {
    verticalVelocity = JUMP_SPEED;
    grounded = false;
  }
});

window.addEventListener('keyup', (event) => {
  keys.delete(event.code);
});

window.addEventListener('blur', () => keys.clear());

$('playButton').addEventListener('click', () => {
  const index = Number($('animationSelect').value || 0);
  playClip(index, false);
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
      '1) index.html과 rat.fbx가 같은 폴더에 있는지 확인하세요.\n' +
      '2) file://로 직접 열지 말고 로컬 서버로 실행하세요.\n' +
      '3) 브라우저 개발자 도구(F12)의 Console에서 추가 오류를 확인하세요.\n\n' +
      String(e)
    );
  }
);

animate();
