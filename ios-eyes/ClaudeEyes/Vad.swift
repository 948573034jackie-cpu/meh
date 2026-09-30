import Foundation

/// Decides when a person STARTS speaking, from one loudness value (dBFS) every ~20 ms.
/// A port of the Mac app's detector (src/vad.js), same numbers and same behaviour:
/// it reacts after ~60 ms of sustained sound, treats a pause shorter than 1.2 s as the same sentence,
/// adapts to steady background noise, and never fires twice inside the wait time.
struct VoiceDetector {
    enum Sensitivity: String, CaseIterable {
        case low, normal, high
        var marginDb: Double {
            switch self {
            case .low: return 18
            case .normal: return 12
            case .high: return 8
            }
        }
        var minDb: Double {
            switch self {
            case .low: return -42
            case .normal: return -48
            case .high: return -54
            }
        }
    }

    enum Event: Equatable {
        case start          // a new sentence began and the wait time was over: take the picture now
        case suppressed     // speech began, but it is too soon after the last picture
        case end(String)    // "silence" or "noise"
    }

    var frameMs = 20.0
    var onsetMs = 60.0
    var hangoverMs = 1200.0
    var minIntervalMs = 30_000.0
    var warmupMs = 500.0
    var maxSpeechMs = 15_000.0
    var sensitivity: Sensitivity = .normal

    private let floorInitDb = -65.0
    private let floorMinDb = -90.0
    private let floorMaxDb = -25.0

    private(set) var floorDb = -65.0
    private(set) var speaking = false
    private var aboveFrames = 0
    private var startedAt: Double?
    private var speechStartTs = 0.0
    private var lastVoiceTs = 0.0
    private var lastTriggerTs = -Double.infinity

    var thresholdDb: Double { max(sensitivity.minDb, floorDb + sensitivity.marginDb) }

    mutating func reset() {
        floorDb = floorInitDb
        speaking = false
        aboveFrames = 0
        startedAt = nil
        speechStartTs = 0
        lastVoiceTs = 0
        lastTriggerTs = -Double.infinity
    }

    /// The picture was not actually sent: let the next speech trigger at once.
    mutating func forgetLastTrigger() {
        lastTriggerTs = -Double.infinity
    }

    private mutating func updateFloor(_ db: Double) {
        if db < floorDb {
            floorDb = floorDb * 0.5 + db * 0.5          // follow quiet quickly
        } else {
            floorDb += 0.02 * (db - floorDb)            // follow rising noise slowly
        }
        floorDb = min(floorMaxDb, max(floorMinDb, floorDb))
    }

    /// db: loudness of the latest frame in dBFS. now: time in milliseconds.
    mutating func process(db rawDb: Double, now: Double) -> Event? {
        let db = rawDb.isFinite ? rawDb : floorMinDb
        if startedAt == nil { startedAt = now }
        let warm = now - (startedAt ?? now) >= warmupMs
        let above = db > thresholdDb

        if !speaking {
            if above {
                aboveFrames += 1
                if Double(aboveFrames) * frameMs >= onsetMs && warm {
                    speaking = true
                    speechStartTs = now
                    lastVoiceTs = now
                    if now - lastTriggerTs >= minIntervalMs {
                        lastTriggerTs = now
                        return .start
                    }
                    return .suppressed
                }
            } else {
                aboveFrames = 0
                updateFloor(db)
            }
            return nil
        }

        if above {
            lastVoiceTs = now
            if now - speechStartTs > maxSpeechMs {
                // never-ending loud sound is background noise, not a person: adapt to it
                floorDb = min(floorMaxDb, db)
                speaking = false
                aboveFrames = 0
                return .end("noise")
            }
        } else if now - lastVoiceTs >= hangoverMs {
            speaking = false
            aboveFrames = 0
            return .end("silence")
        }
        return nil
    }
}
