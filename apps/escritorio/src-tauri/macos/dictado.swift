// aquiles-dictado: dictado con el reconocedor de voz de macOS (framework Speech) para el núcleo de Aquiles.
//
//   aquiles-dictado [segundos] [idioma]      (por defecto 15 y es-ES)
//
// Escucha el micrófono hasta ~1,5 s de silencio después de hablar, o hasta `segundos` si no se oye nada, y
// escribe una línea JSON: {"texto": "...", "idioma": "es-ES"} o {"error": "...", "detalle": "..."}.
// Va dentro de Aquiles.app (Contents/MacOS), así que los permisos de micrófono y de reconocimiento de voz
// son los de Aquiles, con los textos de su Info.plist. Lo compila instalar.sh con swiftc.

import AVFoundation
import Foundation
import Speech

let argumentos = CommandLine.arguments
let segundos = argumentos.count > 1 ? max(1, Double(argumentos[1]) ?? 15) : 15
let idioma = argumentos.count > 2 ? argumentos[2] : "es-ES"
let silencioFinal: TimeInterval = 1.5

func responder(_ datos: [String: String]) -> Never {
    if let json = try? JSONSerialization.data(withJSONObject: datos), let linea = String(data: json, encoding: .utf8) {
        print(linea)
    }
    fflush(stdout)
    exit(0)
}

final class Dictado {
    let motor = AVAudioEngine()
    let peticion = SFSpeechAudioBufferRecognitionRequest()
    var tarea: SFSpeechRecognitionTask?
    var texto = ""
    var ultimoCambio = Date()
    var oido = false
    var inicio = Date()

    func empezar() {
        guard let reconocedor = SFSpeechRecognizer(locale: Locale(identifier: idioma)) ?? SFSpeechRecognizer(), reconocedor.isAvailable else {
            responder(["error": "sin-reconocedor"])
        }
        // En el propio Mac si se puede: sin enviar la voz a Apple y sin el límite de tiempo del servidor.
        if reconocedor.supportsOnDeviceRecognition {
            peticion.requiresOnDeviceRecognition = true
        }
        peticion.shouldReportPartialResults = true

        let entrada = motor.inputNode
        let formato = entrada.outputFormat(forBus: 0)
        if formato.channelCount == 0 || formato.sampleRate == 0 {
            responder(["error": "sin-microfono"])
        }
        let peticion = self.peticion
        entrada.installTap(onBus: 0, bufferSize: 1024, format: formato) { buffer, _ in
            peticion.append(buffer)
        }
        motor.prepare()
        do {
            try motor.start()
        } catch {
            responder(["error": "sin-microfono", "detalle": error.localizedDescription])
        }
        inicio = Date()

        tarea = reconocedor.recognitionTask(with: peticion) { resultado, error in
            DispatchQueue.main.async {
                if let resultado = resultado {
                    let nuevo = resultado.bestTranscription.formattedString
                    if nuevo != self.texto {
                        self.texto = nuevo
                        self.ultimoCambio = Date()
                        self.oido = !nuevo.isEmpty
                    }
                    if resultado.isFinal {
                        self.terminar()
                    }
                } else if let error = error {
                    // Sin nada oído, «no speech detected» (1110) no es un fallo: no se dijo nada.
                    if self.oido || (error as NSError).code == 1110 {
                        self.terminar()
                    } else {
                        responder(["error": "reconocedor", "detalle": error.localizedDescription])
                    }
                }
            }
        }

        Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { _ in
            let ahora = Date()
            if self.oido && ahora.timeIntervalSince(self.ultimoCambio) >= silencioFinal {
                self.terminar()
            } else if !self.oido && ahora.timeIntervalSince(self.inicio) >= segundos {
                self.terminar()
            } else if ahora.timeIntervalSince(self.inicio) >= segundos + 60 {
                // Hablando sin parar: un límite para no quedarse escuchando siempre.
                self.terminar()
            }
        }
    }

    func terminar() {
        motor.stop()
        motor.inputNode.removeTap(onBus: 0)
        peticion.endAudio()
        tarea?.cancel()
        responder(["texto": texto, "idioma": idioma])
    }
}

let dictado = Dictado()

func pedirMicrofono() {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        dictado.empezar()
    case .notDetermined:
        AVCaptureDevice.requestAccess(for: .audio) { concedido in
            DispatchQueue.main.async {
                if concedido {
                    dictado.empezar()
                } else {
                    responder(["error": "sin-permiso-microfono"])
                }
            }
        }
    default:
        responder(["error": "sin-permiso-microfono"])
    }
}

SFSpeechRecognizer.requestAuthorization { estado in
    DispatchQueue.main.async {
        if estado == .authorized {
            pedirMicrofono()
        } else {
            responder(["error": "sin-permiso-voz"])
        }
    }
}

RunLoop.main.run()
