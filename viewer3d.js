import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { TGALoader } from "three/addons/loaders/TGALoader.js";

try {
  Object.defineProperty(THREE, "TGALoader", { value: TGALoader, configurable: true });
} catch {
  /* ES-Module-Namespace schreibgeschützt – Texturen werden nach dem Laden nachgeladen */
}

let renderer, scene, camera, controls, currentModel, animationId;
let initialCameraPos = null;
let initialTarget = null;
let modelRadius = 1;
let modelRotateHandlers = null;

const rotateAxisY = new THREE.Vector3(0, 1, 0);
const rotateAxisX = new THREE.Vector3();

const TEXTURE_MAP_KEYS = ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap", "bumpMap"];

function updateLoadingProgress(xhr) {
  const el = document.getElementById("loadingMsg");
  if (!el) return;
  if (xhr.lengthComputable) {
    const pct = ((xhr.loaded / xhr.total) * 100).toFixed(0);
    el.textContent = `Lade 3D-Modell… ${pct}%`;
  } else {
    const kb = (xhr.loaded / 1024).toFixed(0);
    el.textContent = `Lade 3D-Modell… ${kb} KB`;
  }
}

function getModelStem(fileName) {
  return fileName.replace(/\.fbx$/i, "");
}

function normalizeTexturePath(url) {
  return decodeURIComponent(url).replace(/\\/g, "/");
}

function stemVariants(stem) {
  const lower = stem.toLowerCase();
  const upper = stem.charAt(0).toUpperCase() + lower.slice(1);
  return [...new Set([stem, lower, upper])];
}

function looksLikeTexturePath(value) {
  if (!value || typeof value !== "string") return false;
  return (
    /\.(tga|tif|tiff|png|jpe?g)$/i.test(value) ||
    /\.fbm[\\/]/i.test(value)
  );
}

function extractRelativeTexturePath(textureRef) {
  const normalized = normalizeTexturePath(textureRef);
  const match = normalized.match(/([a-z0-9_.-]+\.fbm\/[^/]+)$/i);
  if (match) return match[1];
  if (!normalized.includes("/") && looksLikeTexturePath(normalized)) return normalized;
  return normalized.replace(/^.*\//, "");
}

function buildTextureCandidates(basePath, stem, textureRef) {
  if (!textureRef) return [];

  const relative = extractRelativeTexturePath(textureRef);
  if (!relative) return [];

  const fileName = relative.split("/").pop();
  const nameNoExt = fileName.replace(/\.[^.]+$/, "");
  const origExt = (fileName.split(".").pop() || "").toLowerCase();
  const altExts = ["tga", "tif", "tiff", "png", "jpg", "jpeg"].filter((ext) => ext !== origExt);
  const candidates = new Set();

  for (const variant of stemVariants(stem)) {
    candidates.add(`${basePath}${variant}.fbm/${fileName}`);
    for (const ext of altExts) {
      candidates.add(`${basePath}${variant}.fbm/${nameNoExt}.${ext}`);
    }
  }

  candidates.add(`${basePath}${relative}`);
  return [...candidates];
}

function isBrokenTexture(texture) {
  if (!texture) return true;
  const img = texture.image;
  if (!img) return true;
  if (img.width <= 1 && img.height <= 1) return true;
  return false;
}

function configureTexture(texture) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
}

const textureExistsCache = new Map();

async function textureUrlExists(url) {
  if (textureExistsCache.has(url)) return textureExistsCache.get(url);
  try {
    let response = await fetch(url, { method: "HEAD" });
    if (response.status === 405 || response.status === 501) {
      response = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" } });
    }
    const ok = response.ok;
    textureExistsCache.set(url, ok);
    return ok;
  } catch {
    textureExistsCache.set(url, false);
    return false;
  }
}

async function loadTiffTexture(url) {
  if (typeof UTIF === "undefined") throw new Error("UTIF nicht geladen");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  const ifds = UTIF.decode(buffer);
  if (!ifds?.[0]) throw new Error("Ungültige TIFF-Datei");
  UTIF.decodeImage(buffer, ifds[0]);
  const rgba = UTIF.toRGBA8(ifds[0]);
  const texture = new THREE.DataTexture(
    rgba,
    ifds[0].width,
    ifds[0].height,
    THREE.RGBAFormat
  );
  texture.flipY = false;
  configureTexture(texture);
  return texture;
}

async function loadTgaTexture(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  const texture = new TGALoader().parse(buffer);
  configureTexture(texture);
  return texture;
}

async function loadImageTexture(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  const texture = new THREE.Texture(bitmap);
  configureTexture(texture);
  return texture;
}

async function loadTextureCandidate(url) {
  const ext = url.split(".").pop().toLowerCase();
  if (ext === "tga") return loadTgaTexture(url);
  if (ext === "tif" || ext === "tiff") return loadTiffTexture(url);
  return loadImageTexture(url);
}

async function loadFirstAvailableTexture(candidates) {
  for (const url of candidates) {
    if (!(await textureUrlExists(url))) continue;
    try {
      return await loadTextureCandidate(url);
    } catch {
      textureExistsCache.set(url, false);
    }
  }
  return null;
}

function defaultMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0x9fb8c9,
    roughness: 0.65,
    metalness: 0.1,
    side: THREE.DoubleSide,
  });
}

function ensureMeshMaterial(mesh) {
  if (!mesh.material || (Array.isArray(mesh.material) && mesh.material.length === 0)) {
    mesh.material = defaultMaterial();
    return [mesh.material];
  }
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

function collectTextureRefs(model) {
  const refs = new Set();
  model.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      for (const key of TEXTURE_MAP_KEYS) {
        const name = material[key]?.name;
        if (looksLikeTexturePath(name)) refs.add(normalizeTexturePath(name));
      }
    }
  });
  return [...refs];
}

function buildCandidateList(basePath, stem, refs) {
  const candidates = new Set();
  for (const ref of refs) {
    for (const url of buildTextureCandidates(basePath, stem, ref)) {
      candidates.add(url);
    }
  }
  return [...candidates];
}

async function fixMaterialTextures(material, basePath, stem, modelRefs) {
  material.side = THREE.DoubleSide;

  if (material.map && !isBrokenTexture(material.map)) {
    configureTexture(material.map);
    return;
  }

  if (material.map && isBrokenTexture(material.map)) {
    material.map.dispose?.();
    material.map = null;
  }

  const refs = new Set(modelRefs);
  if (looksLikeTexturePath(material.map?.name)) {
    refs.add(normalizeTexturePath(material.map.name));
  }

  const candidates = buildCandidateList(basePath, stem, [...refs]);
  const replacement = await loadFirstAvailableTexture(candidates);
  if (replacement) {
    material.map = replacement;
    material.needsUpdate = true;
  } else if (!material.color) {
    material.color = new THREE.Color(0x9fb8c9);
  }
}

async function prepareMaterials(model, basePath, stem) {
  const modelRefs = collectTextureRefs(model);
  const tasks = [];

  model.traverse((child) => {
    if (!child.isMesh) return;

    const materials = ensureMeshMaterial(child);
    materials.forEach((material, index) => {
      if (!material) {
        materials[index] = defaultMaterial();
        return;
      }
      tasks.push(fixMaterialTextures(material, basePath, stem, modelRefs));
    });

    child.material = Array.isArray(child.material) ? materials : materials[0];
    child.castShadow = false;
    child.receiveShadow = false;
  });

  await Promise.all(tasks);
}

function hasValidPositions(geometry) {
  const position = geometry?.attributes?.position;
  if (!position || position.count === 0) return false;

  const values = position.array;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) return false;
  }
  return true;
}

function sanitizeModel(model) {
  const invalidMeshes = [];

  model.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;
    if (!hasValidPositions(child.geometry)) invalidMeshes.push(child);
  });

  invalidMeshes.forEach((mesh) => {
    mesh.parent?.remove(mesh);
    mesh.geometry?.dispose?.();
    if (mesh.material) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((material) => material?.dispose?.());
    }
  });
}

function getMeshBounds(mesh) {
  const position = mesh.geometry?.attributes?.position;
  if (!position || position.count === 0) return null;

  const box = new THREE.Box3();
  const vertex = new THREE.Vector3();

  for (let i = 0; i < position.count; i++) {
    vertex.fromBufferAttribute(position, i);
    if (!Number.isFinite(vertex.x) || !Number.isFinite(vertex.y) || !Number.isFinite(vertex.z)) {
      return null;
    }
    vertex.applyMatrix4(mesh.matrixWorld);
    box.expandByPoint(vertex);
  }

  return box.isEmpty() ? null : box;
}

function getModelBounds(model) {
  model.updateMatrixWorld(true);
  const box = new THREE.Box3();
  let found = false;

  model.traverse((child) => {
    if (!child.isMesh || !child.visible || !child.geometry) return;
    const meshBox = getMeshBounds(child);
    if (!meshBox) return;
    box.union(meshBox);
    found = true;
  });

  if (!found) {
    box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(1, 1, 1));
  }

  return box;
}

function resolveTextureUrl(url, basePath, stem) {
  let normalized = normalizeTexturePath(url);
  const relative = normalized.match(/([a-z0-9_.-]+\.fbm\/[^/]+)$/i);
  if (relative) normalized = relative[1];

  normalized = normalized.replace(/^([^/]+\.fbm)\//i, (match, folder) => {
    const folderLower = folder.toLowerCase();
    for (const variant of stemVariants(stem)) {
      if (`${variant}.fbm`.toLowerCase() === folderLower) return `${variant}.fbm/`;
    }
    return match;
  });

  if (normalized.startsWith("http") || normalized.startsWith(basePath)) return normalized;
  return basePath + normalized.replace(/^\//, "");
}

function getModelExtension(path) {
  return (path.split(".").pop() || "").toLowerCase();
}

function prepareGLTFMaterials(model) {
  model.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = false;
    child.receiveShadow = false;

    const materials = ensureMeshMaterial(child);
    for (const material of materials) {
      material.side = THREE.DoubleSide;
      for (const key of TEXTURE_MAP_KEYS) {
        if (material[key]) configureTexture(material[key]);
      }
    }
    child.material = Array.isArray(child.material) ? materials : materials[0];
  });
}

async function loadGLTFModel(path) {
  const loader = new GLTFLoader();
  const gltf = await new Promise((resolve, reject) => {
    loader.load(
      path,
      resolve,
      updateLoadingProgress,
      () => reject(new Error(`3D-Modell konnte nicht geladen werden (${path})`))
    );
  });

  const model = gltf.scene;
  sanitizeModel(model);
  prepareGLTFMaterials(model);
  return model;
}

async function loadFBXModel(path) {
  const basePath = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
  const stem = getModelStem(path.split("/").pop() || path);

  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => resolveTextureUrl(url, basePath, stem));

  const loader = new FBXLoader(manager);
  loader.setResourcePath(basePath);

  const model = await new Promise((resolve, reject) => {
    loader.load(
      path,
      resolve,
      updateLoadingProgress,
      () => reject(new Error(`3D-Modell konnte nicht geladen werden (${path})`))
    );
  });

  sanitizeModel(model);
  await prepareMaterials(model, basePath, stem);
  return model;
}

export async function loadModel(path) {
  const ext = getModelExtension(path);
  if (ext === "glb" || ext === "gltf") return loadGLTFModel(path);
  if (ext === "fbx") return loadFBXModel(path);
  throw new Error(`Dateiformat ".${ext}" wird nicht unterstützt (${path})`);
}

function detachModelRotation() {
  if (!modelRotateHandlers) return;
  const { domElement, onDown, onMove, onUp } = modelRotateHandlers;
  domElement.removeEventListener("pointerdown", onDown);
  domElement.removeEventListener("pointermove", onMove);
  domElement.removeEventListener("pointerup", onUp);
  domElement.removeEventListener("pointercancel", onUp);
  modelRotateHandlers = null;
}

function attachModelRotation(domElement) {
  detachModelRotation();

  const drag = { active: false, x: 0, y: 0, id: -1 };
  const speed = 0.005;

  function onDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    drag.active = true;
    drag.x = e.clientX;
    drag.y = e.clientY;
    drag.id = e.pointerId;
    domElement.setPointerCapture(e.pointerId);
  }

  function onMove(e) {
    if (!drag.active || e.pointerId !== drag.id || !currentModel || !camera) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (dx === 0 && dy === 0) return;

    currentModel.rotateOnWorldAxis(rotateAxisY, dx * speed);
    rotateAxisX.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    currentModel.rotateOnWorldAxis(rotateAxisX, dy * speed);
  }

  function onUp(e) {
    if (e.pointerId !== drag.id) return;
    drag.active = false;
    domElement.releasePointerCapture(e.pointerId);
  }

  domElement.addEventListener("pointerdown", onDown);
  domElement.addEventListener("pointermove", onMove);
  domElement.addEventListener("pointerup", onUp);
  domElement.addEventListener("pointercancel", onUp);
  modelRotateHandlers = { domElement, onDown, onMove, onUp };
}

export function disposeScene() {
  if (animationId) cancelAnimationFrame(animationId);
  animationId = null;
  window.removeEventListener("resize", onResize);

  detachModelRotation();

  if (controls) {
    controls.dispose();
    controls = null;
  }
  if (renderer) {
    renderer.dispose();
    if (renderer.domElement && renderer.domElement.parentNode) {
      renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
    renderer = null;
  }
  if (scene) {
    scene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose?.();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m) => {
          for (const key in m) {
            if (m[key] && m[key].isTexture) m[key].dispose();
          }
          m.dispose?.();
        });
      }
    });
    scene = null;
  }
  currentModel = null;
}

function updateCameraClipping() {
  if (!camera || !controls) return;
  const dist = camera.position.distanceTo(controls.target);
  const near = Math.max(dist * 0.002, modelRadius * 0.0002, 0.001);
  const far = Math.max(dist * 80, modelRadius * 40, 100);
  if (Math.abs(camera.near - near) / near > 0.15 || Math.abs(camera.far - far) / far > 0.15) {
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
  }
}

function onResize() {
  if (!renderer || !camera) return;
  const container = document.getElementById("modelContainer");
  const w = container.clientWidth;
  const h = container.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

export function setupScene(model) {
  disposeScene();

  const container = document.getElementById("modelContainer");
  Array.from(container.querySelectorAll("canvas")).forEach((c) => c.remove());

  const unavailable = container.querySelector(".model-unavailable");
  if (unavailable) unavailable.remove();

  scene = new THREE.Scene();
  scene.background = null;

  const ambient = new THREE.AmbientLight(0xffffff, 0.45);
  scene.add(ambient);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x6a8aaa, 1.0);
  scene.add(hemi);

  const frontLight = new THREE.DirectionalLight(0xffffff, 1.8);
  frontLight.position.set(0, 2, 10);
  scene.add(frontLight);

  const dir = new THREE.DirectionalLight(0xffffff, 0.7);
  dir.position.set(5, 10, 7);
  scene.add(dir);

  const dir2 = new THREE.DirectionalLight(0xc8dff0, 0.5);
  dir2.position.set(-5, -3, -5);
  scene.add(dir2);

  const w = container.clientWidth;
  const h = container.clientHeight;

  camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 10000);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const box = getModelBounds(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const boundsSphere = new THREE.Sphere();
  box.getBoundingSphere(boundsSphere);
  modelRadius = Math.max(boundsSphere.radius, Math.max(size.x, size.y, size.z) / 2) || 1;

  model.position.x -= center.x;
  model.position.y -= center.y;
  model.position.z -= center.z;

  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const fitDist = maxDim / (2 * Math.tan((Math.PI * camera.fov) / 360));
  const distance = fitDist * 1.6;

  camera.position.set(distance * 0.6, distance * 0.4, distance);
  camera.lookAt(0, 0, 0);
  updateCameraClipping();

  scene.add(model);
  currentModel = model;

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableRotate = false;
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.zoomSpeed = 0.9;
  controls.minDistance = modelRadius * 0.55;
  controls.maxDistance = modelRadius * 10;
  controls.target.set(0, 0, 0);
  controls.update();

  attachModelRotation(renderer.domElement);

  initialCameraPos = camera.position.clone();
  initialTarget = controls.target.clone();

  window.addEventListener("resize", onResize);

  function loop() {
    animationId = requestAnimationFrame(loop);
    controls.update();
    updateCameraClipping();
    renderer.render(scene, camera);
  }
  loop();
}

export function resetView() {
  if (camera && controls && initialCameraPos && initialTarget) {
    camera.position.copy(initialCameraPos);
    controls.target.copy(initialTarget);
    controls.update();
  }
  if (currentModel) {
    currentModel.rotation.set(0, 0, 0);
  }
}
