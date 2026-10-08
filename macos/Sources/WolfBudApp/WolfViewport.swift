import AppKit
import GLTFKit2
import SceneKit
import SwiftUI
import simd

struct WolfViewport: NSViewRepresentable {
    var driver: WolfDriver

    func makeNSView(context: Context) -> SCNView {
        let view = SCNView()
        view.scene = context.coordinator.scene
        view.pointOfView = context.coordinator.cameraNode
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.antialiasingMode = .multisampling4X
        view.rendersContinuously = true
        view.preferredFramesPerSecond = 60
        view.allowsCameraControl = false
        context.coordinator.load()
        return view
    }

    func updateNSView(_ nsView: SCNView, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(driver: driver)
    }

    final class Coordinator: NSObject, SCNSceneRendererDelegate {
        let driver: WolfDriver
        let scene = SCNScene()
        let cameraNode = SCNNode()
        private let model = SCNNode()
        private var jaw: SCNNode?
        private var jawRest = simd_quatf(angle: 0, axis: SIMD3(1, 0, 0))
        private var jawValue: Float = 0
        private var listen: Float = 0
        private var sleep: Float = 1
        private var nodPos: Float = 0
        private var nodVel: Float = 0
        private var tilt: Float = 0
        private var look = simd_quatf(ix: 0, iy: 0, iz: 0, r: 1)
        private var startedAt: TimeInterval?
        private var lastFrame: TimeInterval = 0
        private let viewRight: SIMD3<Float>
        private let viewUp: SIMD3<Float>
        private let viewBack: SIMD3<Float>

        init(driver: WolfDriver) {
            self.driver = driver
            let rest = Self.lookAt(eye: Self.cameraDirection(az: baseAz, el: baseEl), target: .zero, up: SIMD3(0, 1, 0))
            viewRight = SIMD3(rest.columns.0.x, rest.columns.0.y, rest.columns.0.z)
            viewUp = SIMD3(rest.columns.1.x, rest.columns.1.y, rest.columns.1.z)
            viewBack = SIMD3(rest.columns.2.x, rest.columns.2.y, rest.columns.2.z)
            super.init()
            let camera = SCNCamera()
            camera.usesOrthographicProjection = true
            camera.orthographicScale = 0.62
            camera.zNear = 0.1
            camera.zFar = 20
            cameraNode.camera = camera
            scene.rootNode.addChildNode(cameraNode)
            scene.rootNode.addChildNode(model)
            scene.background.contents = NSColor.clear
            addLights()
            placeCamera(az: baseAz, el: baseEl)
        }

        func load() {
            guard let url = WolfModel.url() else { return }
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                do {
                    let asset = try GLTFAsset(url: url, options: [:])
                    DispatchQueue.main.async { self?.install(asset) }
                } catch {
                    NSLog("WolfBud model: \(error.localizedDescription)")
                }
            }
        }

        func renderer(_ renderer: SCNSceneRenderer, updateAtTime time: TimeInterval) {
            let start = startedAt ?? time
            startedAt = start
            let dt = Float(min(0.1, lastFrame == 0 ? 0.016 : time - lastFrame))
            lastFrame = time
            let t = Float(time - start)
            let drive = driver.snapshot()
            for _ in 0..<driver.takePets() {
                nodVel = min(nodVel + nodKick, nodKick * nodRepeat)
            }

            let env = talkEnvelope(t)
            let level = Float(drive.voiceLevel)
            let voiced = level > 0.02 ? max(level, env * 0.35) : env * 0.9
            let target: Float = drive.talking ? min(1, voiced) : 0
            jawValue += (target - jawValue) * smoothing(dt, tau: target > jawValue ? 0.035 : 0.09)
            jaw?.simdOrientation = jawRest * simd_quatf(angle: jawValue * jawOpen, axis: SIMD3(1, 0, 0))

            let listenTarget: Float = drive.mood == .listening ? min(1, 0.35 + Float(drive.heardLevel) * 1.6) : 0
            listen += (listenTarget - listen) * smoothing(dt, tau: 0.25)
            let sleepTarget: Float = drive.mood == .asleep ? 1 : 0
            sleep += (sleepTarget - sleep) * smoothing(dt, tau: 0.6)

            let omega = 2 * Float.pi * nodFreq
            let stiffness = omega * omega
            let damping = 2 * nodZeta * omega
            let substeps = max(1, Int(ceil(dt * 120)))
            let h = dt / Float(substeps)
            for _ in 0..<substeps {
                nodVel += (-stiffness * nodPos - damping * nodVel) * h
                nodPos = min(nodMax, max(-nodMax, nodPos + nodVel * h))
            }

            let blend = smoothing(dt, tau: lookTau)
            let lookTarget = drive.hasPointer ? aimAt(dx: Float(drive.pointerX), dy: Float(drive.pointerY)) : simd_quatf(ix: 0, iy: 0, iz: 0, r: 1)
            look = simd_slerp(look, lookTarget, blend)
            let tiltTarget: Float = drive.hasPointer ? saturate(Float(drive.pointerX) / lookRange) * lookTilt : 0
            tilt += (tiltTarget - tilt) * blend

            let sway = 1 - sleep * 0.6
            let pitch = sin(t * 0.53 * sway + 1.3) * idlePitch - jawValue * talkLift + nodPos * nodAngle + listen * listenPitch + sleep * sleepPitch
            let roll = sin(t * 0.7 * sway) * idleRoll + nodVel * nodWag + listen * listenRoll - tilt
            model.simdOrientation = look * quatXYZ(x: pitch, y: 0, z: roll)
            model.simdPosition = SIMD3(0, sin(t * 0.9 * sway) * idleBob, 0)

            placeCamera(
                az: baseAz + sin(t * 0.31) * driftAz + sin(t * 0.13 + 2) * driftAz * 0.4,
                el: baseEl + sin(t * 0.23 + 1) * driftEl
            )
        }

        private func install(_ asset: GLTFAsset) {
            let loaded = SCNScene(gltfAsset: asset)
            let root = loaded.rootNode.clone()
            let (boxMin, boxMax) = root.boundingBox
            let extent = SIMD3<Float>(
                Float(boxMax.x - boxMin.x),
                Float(boxMax.y - boxMin.y),
                Float(boxMax.z - boxMin.z)
            )
            let center = SIMD3<Float>(
                Float((boxMin.x + boxMax.x) / 2),
                Float((boxMin.y + boxMax.y) / 2),
                Float((boxMin.z + boxMax.z) / 2)
            )
            root.simdPosition -= center
            let scale = 1 / max(extent.x, max(extent.y, extent.z), 0.0001)
            model.childNodes.forEach { $0.removeFromParentNode() }
            model.addChildNode(root)
            model.simdScale = SIMD3(repeating: scale)
            jaw = root.childNode(withName: "jaw", recursively: true)
            jawRest = jaw?.simdOrientation ?? simd_quatf(ix: 0, iy: 0, iz: 0, r: 1)
            fitFrustum()
        }

        private func fitFrustum() {
            placeCamera(az: baseAz, el: baseEl)
            let (boxMin, boxMax) = model.boundingBox
            let corners: [SIMD3<Float>] = [
                SIMD3(Float(boxMin.x), Float(boxMin.y), Float(boxMin.z)),
                SIMD3(Float(boxMax.x), Float(boxMin.y), Float(boxMin.z)),
                SIMD3(Float(boxMin.x), Float(boxMax.y), Float(boxMin.z)),
                SIMD3(Float(boxMax.x), Float(boxMax.y), Float(boxMin.z)),
                SIMD3(Float(boxMin.x), Float(boxMin.y), Float(boxMax.z)),
                SIMD3(Float(boxMax.x), Float(boxMin.y), Float(boxMax.z)),
                SIMD3(Float(boxMin.x), Float(boxMax.y), Float(boxMax.z)),
                SIMD3(Float(boxMax.x), Float(boxMax.y), Float(boxMax.z)),
            ]
            let view = cameraNode.simdWorldTransform.inverse
            var reach: Float = 0.2
            for corner in corners {
                let world = model.simdConvertPosition(corner, to: nil)
                let camera = view * SIMD4(world, 1)
                reach = max(reach, abs(camera.x), abs(camera.y))
            }
            cameraNode.camera?.orthographicScale = Double(reach) * 1.18
        }

        private func addLights() {
            scene.rootNode.addChildNode(light(NSColor.white, intensity: 1100, position: SCNVector3(-1.6, 2.4, 2.2)))
            scene.rootNode.addChildNode(light(NSColor(calibratedRed: 0xA9 / 255, green: 0xB6 / 255, blue: 1, alpha: 1), intensity: 340, position: SCNVector3(2.4, -0.4, 1.2)))
            scene.rootNode.addChildNode(light(NSColor(calibratedRed: 0xC9 / 255, green: 0xD4 / 255, blue: 1, alpha: 1), intensity: 600, position: SCNVector3(0.8, 1.1, -2.4)))
            let ambient = SCNLight()
            ambient.type = .ambient
            ambient.color = NSColor(calibratedRed: 0xDF / 255, green: 0xE4 / 255, blue: 1, alpha: 1)
            ambient.intensity = 180
            let node = SCNNode()
            node.light = ambient
            scene.rootNode.addChildNode(node)
        }

        private func light(_ color: NSColor, intensity: CGFloat, position: SCNVector3) -> SCNNode {
            let light = SCNLight()
            light.type = .directional
            light.color = color
            light.intensity = intensity
            let node = SCNNode()
            node.light = light
            node.position = position
            node.look(at: SCNVector3Zero)
            return node
        }

        private func placeCamera(az: Float, el: Float) {
            let eye = Self.cameraDirection(az: az, el: el) * camDist
            cameraNode.simdTransform = Self.lookAt(eye: eye, target: .zero, up: SIMD3(0, 1, 0))
        }

        private func aimAt(dx: Float, dy: Float) -> simd_quatf {
            let dist = hypot(dx, dy)
            let angle = lookMax * tanh(dist / lookRange)
            let side: Float = dist > 0 ? sin(angle) / dist : 0
            let aim = viewBack * cos(angle) + viewRight * (dx * side) + viewUp * (-dy * side)
            let basis = Self.lookAt(eye: aim, target: .zero, up: SIMD3(0, 1, 0))
            let rotation = simd_float3x3(
                SIMD3(basis.columns.0.x, basis.columns.0.y, basis.columns.0.z),
                SIMD3(basis.columns.1.x, basis.columns.1.y, basis.columns.1.z),
                SIMD3(basis.columns.2.x, basis.columns.2.y, basis.columns.2.z)
            )
            return simd_quatf(rotation)
        }

        private static func cameraDirection(az: Float, el: Float) -> SIMD3<Float> {
            let cosEl = cos(el)
            return SIMD3(sin(az) * cosEl, sin(el), cos(az) * cosEl)
        }

        private static func lookAt(eye: SIMD3<Float>, target: SIMD3<Float>, up: SIMD3<Float>) -> simd_float4x4 {
            let z = simd_normalize(eye - target)
            let x = simd_normalize(simd_cross(up, z))
            let y = simd_cross(z, x)
            var matrix = matrix_identity_float4x4
            matrix.columns.0 = SIMD4(x, 0)
            matrix.columns.1 = SIMD4(y, 0)
            matrix.columns.2 = SIMD4(z, 0)
            matrix.columns.3 = SIMD4(eye, 1)
            return matrix
        }
    }
}

enum WolfModel {
    static func url() -> URL? {
        if let override = ProcessInfo.processInfo.environment["WOLFBUD_MODEL"],
           FileManager.default.fileExists(atPath: override) {
            return URL(fileURLWithPath: override)
        }
        if let bundled = Bundle.main.url(forResource: "wolf-head", withExtension: "glb") {
            return bundled
        }
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        let model = url.appendingPathComponent("window/public/wolf-head.glb")
        return FileManager.default.fileExists(atPath: model.path) ? model : nil
    }
}

private let baseAz = Float(-42) * .pi / 180
private let baseEl = Float(29) * .pi / 180
private let driftAz = Float(4) * .pi / 180
private let driftEl = Float(2.5) * .pi / 180
private let idlePitch: Float = 0.025
private let idleRoll: Float = 0.03
private let idleBob: Float = 0.012
private let talkLift: Float = 0.05
private let nodAngle = Float(11) * .pi / 180
private let nodFreq: Float = 2.3
private let nodZeta: Float = 0.32
private let nodKick: Float = 22
private let nodRepeat: Float = 1.5
private let nodMax: Float = 1.4
private let nodWag: Float = 0.0015
private let jawOpen: Float = 0.38
private let camDist: Float = 6
private let listenRoll = Float(7) * .pi / 180
private let listenPitch = Float(-4) * .pi / 180
private let sleepPitch = Float(6) * .pi / 180
private let lookMax = Float(42) * .pi / 180
private let lookRange: Float = 220
private let lookTilt = Float(6) * .pi / 180
private let lookTau: Float = 0.16

private func talkEnvelope(_ t: Float) -> Float {
    let s = 0.55 * sin(t * 11) + 0.3 * sin(t * 17.3 + 1.1) + 0.15 * sin(t * 6.7 + 2.7)
    let gate = min(1, max(0, sin(t * 1.7 + 0.6) * 0.5 + 0.78))
    return max(0, s) * gate
}

private func smoothing(_ dt: Float, tau: Float) -> Float {
    1 - exp(-dt / tau)
}

private func saturate(_ value: Float) -> Float {
    value / (1 + abs(value))
}

private func quatXYZ(x: Float, y: Float, z: Float) -> simd_quatf {
    let c1 = cos(x / 2), c2 = cos(y / 2), c3 = cos(z / 2)
    let s1 = sin(x / 2), s2 = sin(y / 2), s3 = sin(z / 2)
    return simd_quatf(
        ix: s1 * c2 * c3 + c1 * s2 * s3,
        iy: c1 * s2 * c3 - s1 * c2 * s3,
        iz: c1 * c2 * s3 + s1 * s2 * c3,
        r: c1 * c2 * c3 - s1 * s2 * s3
    )
}
