// The WolfBud head: wolfbud's WolfHead.vue (~/workspace/wolfbud) without Vue
// or Tauri. Same model, framing, lights, idle sway, pet nod and jaw; the jaw
// follows the agent's voice level, the head turns to look at the pointer, and
// it tilts toward the user while they talk.

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

// ── View tuning (from WolfHead.vue) ─────────────────────────────────────────
const BASE_AZ = THREE.MathUtils.degToRad(-42)
const BASE_EL = THREE.MathUtils.degToRad(29)
const DRIFT_AZ = THREE.MathUtils.degToRad(4)
const DRIFT_EL = THREE.MathUtils.degToRad(2.5)
const IDLE_PITCH = 0.025
const IDLE_ROLL = 0.03
const IDLE_BOB = 0.012
const TALK_LIFT = 0.05
const NOD_ANGLE = THREE.MathUtils.degToRad(11)
const NOD_FREQ = 2.3
const NOD_ZETA = 0.32
const NOD_KICK = 22
const NOD_REPEAT = 1.5
const NOD_MAX = 1.4
const NOD_WAG = 0.0015
const JAW_OPEN = 0.38
const CAM_DIST = 6
const FIT_MARGIN = 1.06
// ── Added for the call ──────────────────────────────────────────────────────
/** A curious tilt while the user talks: roll, and a little chin lift. */
const LISTEN_ROLL = THREE.MathUtils.degToRad(7)
const LISTEN_PITCH = THREE.MathUtils.degToRad(-4)
/** Asleep (no call): the head sinks and the sway slows. */
const SLEEP_PITCH = THREE.MathUtils.degToRad(6)
/**
 * Looking at the pointer: the snout aims at it, easing out to LOOK_MAX off the
 * line to the viewer (three quarters of it at LOOK_RANGE px from the head, about
 * all of it at the window's corners); it tilts a little toward the pointer's
 * side, and eases back to the 3/4 rest pose when the pointer leaves.
 */
const LOOK_MAX = THREE.MathUtils.degToRad(42)
const LOOK_RANGE = 220
const LOOK_TILT = THREE.MathUtils.degToRad(6)
const LOOK_TAU = 0.16
const ORIGIN = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)

export type WolfMood = 'asleep' | 'awake' | 'listening' | 'speaking'

export type Wolf = {
  /** The agent's voice: talking, and its level 0..1 (0 falls back to a syllable rhythm). */
  voice(talking: boolean, level: number): void
  /** How much the user is talking right now, 0..1. */
  hear(level: number): void
  mood(mood: WolfMood): void
  pet(): void
  resize(size: number): void
  dispose(): void
}

/** Syllable-ish mouth envelope: three incommensurate sines, gated between "words". */
function talkEnvelope(t: number): number {
  const s = 0.55 * Math.sin(t * 11.0) + 0.3 * Math.sin(t * 17.3 + 1.1) + 0.15 * Math.sin(t * 6.7 + 2.7)
  const gate = Math.min(1, Math.max(0, Math.sin(t * 1.7 + 0.6) * 0.5 + 0.78))
  return Math.max(0, s) * gate
}

function smoothing(dt: number, tau: number): number {
  return 1 - Math.exp(-dt / tau)
}

function saturate(v: number): number {
  return v / (1 + Math.abs(v))
}

export async function createWolf(host: HTMLElement, modelUrl: string, size: number): Promise<Wolf | null> {
  let renderer: THREE.WebGLRenderer
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' })
  } catch (error) {
    console.error('[wolf] WebGL unavailable:', error)
    return null
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(size, size)
  renderer.setClearAlpha(0)
  host.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-0.6, 0.6, 0.6, -0.6, 0.1, 20)
  const key = new THREE.DirectionalLight(0xffffff, 3.1)
  key.position.set(-1.6, 2.4, 2.2)
  const fill = new THREE.DirectionalLight(0xa9b6ff, 0.95)
  fill.position.set(2.4, -0.4, 1.2)
  const rim = new THREE.DirectionalLight(0xc9d4ff, 1.7)
  rim.position.set(0.8, 1.1, -2.4)
  const hemi = new THREE.HemisphereLight(0xdfe4ff, 0x1a1836, 0.85)
  scene.add(key, fill, rim, hemi)

  let model: THREE.Group | null = null
  let jaw: THREE.Object3D | null = null
  let jawRestX = 0

  let isTalking = false
  let voiceLevel = 0
  let heardLevel = 0
  let currentMood: WolfMood = 'asleep'
  let jawValue = 0
  let listen = 0
  let sleep = 1
  let nodPos = 0
  let nodVel = 0
  let pointerX = 0
  let pointerY = 0
  let hasPointer = false
  let tilt = 0
  let raf = 0
  let lastFrame = 0
  const startedAt = performance.now()
  const look = new THREE.Quaternion()
  const lookTarget = new THREE.Quaternion()
  const expression = new THREE.Quaternion()
  const expressionEuler = new THREE.Euler()

  /** Unit vector from the head toward a camera at azimuth `az`, elevation `el`. */
  function cameraDirection(az: number, el: number, out: THREE.Vector3): THREE.Vector3 {
    const cosEl = Math.cos(el)
    return out.set(Math.sin(az) * cosEl, Math.sin(el), Math.cos(az) * cosEl)
  }

  function placeCamera(az: number, el: number) {
    cameraDirection(az, el, camera.position).multiplyScalar(CAM_DIST)
    camera.lookAt(0, 0, 0)
  }

  // The rest view's axes in world space: screen right, screen up, and back toward the viewer.
  const viewRight = new THREE.Vector3()
  const viewUp = new THREE.Vector3()
  const viewBack = new THREE.Vector3()
  new THREE.Matrix4()
    .lookAt(cameraDirection(BASE_AZ, BASE_EL, new THREE.Vector3()), ORIGIN, UP)
    .extractBasis(viewRight, viewUp, viewBack)
  const aim = new THREE.Vector3()
  const aimBasis = new THREE.Matrix4()

  /** The upright rotation that points the snout (+Z) at a pointer `dx`, `dy` px (screen axes) from the head. */
  function aimAt(dx: number, dy: number, out: THREE.Quaternion): THREE.Quaternion {
    const dist = Math.hypot(dx, dy)
    const angle = LOOK_MAX * Math.tanh(dist / LOOK_RANGE)
    const side = dist > 0 ? Math.sin(angle) / dist : 0
    aim
      .copy(viewBack)
      .multiplyScalar(Math.cos(angle))
      .addScaledVector(viewRight, dx * side)
      .addScaledVector(viewUp, -dy * side)
    return out.setFromRotationMatrix(aimBasis.lookAt(aim, ORIGIN, UP))
  }

  function collectPoints(): THREE.Vector3[] {
    const points: THREE.Vector3[] = []
    if (!model) return points
    model.updateWorldMatrix(true, true)
    model.traverse(object => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      const position = mesh.geometry.getAttribute('position')
      for (let i = 0; i < position.count; i++) {
        points.push(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld))
      }
    })
    return points
  }

  /** Sizes the frustum to every pose the head can strike, so nothing clips (see WolfHead.vue). */
  function fitFrustum() {
    if (!model) return
    const restRotation = model.rotation.clone()
    const restPosition = model.position.clone()
    model.rotation.set(0, 0, 0)
    model.position.set(0, 0, 0)
    const poseSets: THREE.Vector3[][] = []
    for (const open of jaw ? [0, JAW_OPEN] : [0]) {
      if (jaw) jaw.rotation.x = jawRestX + open
      poseSets.push(collectPoints())
    }
    if (jaw) jaw.rotation.x = jawRestX
    model.rotation.copy(restRotation)
    model.position.copy(restPosition)

    const maxPitch = NOD_ANGLE * NOD_MAX + IDLE_PITCH + TALK_LIFT + SLEEP_PITCH
    const maxRoll = IDLE_ROLL + NOD_WAG * NOD_KICK * NOD_REPEAT + LISTEN_ROLL + LOOK_TILT
    const swingAz = DRIFT_AZ * 1.4
    const swingEl = DRIFT_EL * 1.4
    // Every way it looks: at rest, at the viewer, and at a pointer near and far, all around.
    const looks = [new THREE.Quaternion(), aimAt(0, 0, new THREE.Quaternion())]
    for (const reach of [LOOK_RANGE, LOOK_RANGE * 1e4]) {
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4
        looks.push(aimAt(Math.cos(a) * reach, Math.sin(a) * reach, new THREE.Quaternion()))
      }
    }
    const pose = new THREE.Matrix4()
    const euler = new THREE.Euler()
    const turn = new THREE.Quaternion()
    const project = new THREE.Matrix4()
    const v = new THREE.Vector3()
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const lookAt of looks) {
      for (const pitch of [-maxPitch, 0, maxPitch]) {
        for (const roll of [-maxRoll, maxRoll]) {
          pose.makeRotationFromQuaternion(turn.setFromEuler(euler.set(pitch, 0, roll)).premultiply(lookAt))
          for (const az of [BASE_AZ - swingAz, BASE_AZ, BASE_AZ + swingAz]) {
            for (const el of [BASE_EL - swingEl, BASE_EL, BASE_EL + swingEl]) {
              placeCamera(az, el)
              camera.updateMatrixWorld()
              project.multiplyMatrices(camera.matrixWorldInverse, pose)
              for (const points of poseSets) {
                for (const p of points) {
                  v.copy(p).applyMatrix4(project)
                  minX = Math.min(minX, v.x)
                  maxX = Math.max(maxX, v.x)
                  minY = Math.min(minY, v.y)
                  maxY = Math.max(maxY, v.y)
                }
              }
            }
          }
        }
      }
    }
    placeCamera(BASE_AZ, BASE_EL)
    if (!Number.isFinite(minX)) return
    minY -= IDLE_BOB
    maxY += IDLE_BOB
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const half = (Math.max(maxX - minX, maxY - minY) / 2) * FIT_MARGIN
    camera.left = cx - half
    camera.right = cx + half
    camera.top = cy + half
    camera.bottom = cy - half
    camera.updateProjectionMatrix()
  }

  function frame(now: number) {
    raf = requestAnimationFrame(frame)
    const t = (now - startedAt) / 1000
    const dt = Math.min(0.1, (now - lastFrame) / 1000) || 0.016
    lastFrame = now

    // Jaw: the agent's level when there is one, a procedural rhythm as its floor.
    const env = talkEnvelope(t)
    const drive = voiceLevel > 0.02 ? Math.max(voiceLevel, env * 0.35) : env * 0.9
    const target = isTalking ? Math.min(1, drive) : 0
    jawValue += (target - jawValue) * smoothing(dt, target > jawValue ? 0.035 : 0.09)
    if (jaw) jaw.rotation.x = jawRestX + jawValue * JAW_OPEN

    const listenTarget = currentMood === 'listening' ? Math.min(1, 0.35 + heardLevel * 1.6) : 0
    listen += (listenTarget - listen) * smoothing(dt, 0.25)
    sleep += ((currentMood === 'asleep' ? 1 : 0) - sleep) * smoothing(dt, 0.6)

    const omega = 2 * Math.PI * NOD_FREQ
    const stiffness = omega * omega
    const damping = 2 * NOD_ZETA * omega
    const substeps = Math.max(1, Math.ceil(dt * 120))
    const h = dt / substeps
    for (let i = 0; i < substeps; i++) {
      nodVel += (-stiffness * nodPos - damping * nodVel) * h
      nodPos = THREE.MathUtils.clamp(nodPos + nodVel * h, -NOD_MAX, NOD_MAX)
    }

    // Look: ease toward the pointer (or back to rest), then layer the sway, nod and moods on top.
    const p = smoothing(dt, LOOK_TAU)
    if (hasPointer) aimAt(pointerX, pointerY, lookTarget)
    else lookTarget.identity()
    look.slerp(lookTarget, p)
    tilt += ((hasPointer ? saturate(pointerX / LOOK_RANGE) * LOOK_TILT : 0) - tilt) * p

    if (model) {
      const sway = 1 - sleep * 0.6
      expressionEuler.set(
        Math.sin(t * 0.53 * sway + 1.3) * IDLE_PITCH -
          jawValue * TALK_LIFT +
          nodPos * NOD_ANGLE +
          listen * LISTEN_PITCH +
          sleep * SLEEP_PITCH,
        0,
        Math.sin(t * 0.7 * sway) * IDLE_ROLL + nodVel * NOD_WAG + listen * LISTEN_ROLL - tilt,
      )
      model.quaternion.copy(look).multiply(expression.setFromEuler(expressionEuler))
      model.position.y = Math.sin(t * 0.9 * sway) * IDLE_BOB
    }

    placeCamera(
      BASE_AZ + Math.sin(t * 0.31) * DRIFT_AZ + Math.sin(t * 0.13 + 2) * DRIFT_AZ * 0.4,
      BASE_EL + Math.sin(t * 0.23 + 1) * DRIFT_EL,
    )
    renderer.render(scene, camera)
  }

  function start() {
    if (raf) return
    lastFrame = performance.now()
    raf = requestAnimationFrame(frame)
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
  }

  const onPointerMove = (event: MouseEvent) => {
    const r = renderer.domElement.getBoundingClientRect()
    pointerX = event.clientX - (r.left + r.width / 2)
    pointerY = event.clientY - (r.top + r.height / 2)
    hasPointer = true
  }
  const onPointerLeave = () => {
    hasPointer = false
  }
  const onVisibility = () => (document.hidden ? stop() : start())
  window.addEventListener('mousemove', onPointerMove)
  document.documentElement.addEventListener('mouseleave', onPointerLeave)
  document.addEventListener('visibilitychange', onVisibility)

  try {
    const gltf = await new GLTFLoader().loadAsync(modelUrl)
    const root = gltf.scene
    const box = new THREE.Box3().setFromObject(root)
    const extent = box.getSize(new THREE.Vector3())
    root.position.sub(box.getCenter(new THREE.Vector3()))
    model = new THREE.Group()
    model.add(root)
    model.scale.setScalar(1 / Math.max(extent.x, extent.y, extent.z))
    scene.add(model)
    jaw = root.getObjectByName('jaw') ?? null
    jawRestX = jaw?.rotation.x ?? 0
    if (!jaw) console.warn("[wolf] no 'jaw' node in the model: no talking")
    fitFrustum()
  } catch (error) {
    console.error('[wolf] failed to load the model:', error)
  }
  start()

  return {
    voice(talking, level) {
      isTalking = talking
      voiceLevel = level
    },
    hear(level) {
      heardLevel = level
    },
    mood(next) {
      currentMood = next
    },
    pet() {
      nodVel = Math.min(nodVel + NOD_KICK, NOD_KICK * NOD_REPEAT)
    },
    resize(next) {
      renderer.setSize(next, next)
    },
    dispose() {
      stop()
      window.removeEventListener('mousemove', onPointerMove)
      document.documentElement.removeEventListener('mouseleave', onPointerLeave)
      document.removeEventListener('visibilitychange', onVisibility)
      scene.traverse(object => {
        const mesh = object as THREE.Mesh
        if (!mesh.isMesh) return
        mesh.geometry.dispose()
        const material = mesh.material
        if (Array.isArray(material)) material.forEach(m => m.dispose())
        else material.dispose()
      })
      renderer.domElement.remove()
      renderer.dispose()
    },
  }
}
