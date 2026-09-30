import Foundation

/// A second-order filter (RBJ cookbook), used to keep only the human-voice band.
struct Biquad {
    var b0: Double, b1: Double, b2: Double, a1: Double, a2: Double
    var z1 = 0.0
    var z2 = 0.0

    static func highpass(sampleRate: Double, frequency: Double, q: Double) -> Biquad {
        let w0 = 2 * Double.pi * frequency / sampleRate
        let alpha = sin(w0) / (2 * q)
        let c = cos(w0)
        let a0 = 1 + alpha
        return Biquad(b0: (1 + c) / 2 / a0, b1: -(1 + c) / a0, b2: (1 + c) / 2 / a0,
                      a1: -2 * c / a0, a2: (1 - alpha) / a0)
    }

    static func lowpass(sampleRate: Double, frequency: Double, q: Double) -> Biquad {
        let w0 = 2 * Double.pi * frequency / sampleRate
        let alpha = sin(w0) / (2 * q)
        let c = cos(w0)
        let a0 = 1 + alpha
        return Biquad(b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, b2: (1 - c) / 2 / a0,
                      a1: -2 * c / a0, a2: (1 - alpha) / a0)
    }

    mutating func process(_ x: Double) -> Double {
        let y = b0 * x + z1
        z1 = b1 * x - a1 * y + z2
        z2 = b2 * x - a2 * y
        return y
    }
}

/// Turns raw microphone samples into one loudness value (dBFS) per 20 ms, voice band only
/// (120 Hz to 3.8 kHz, like the Mac app), so fan rumble, hiss and table knocks count for less.
final class LevelMeter {
    private var highpass: Biquad
    private var lowpass: Biquad
    private let window: Int
    private var sum = 0.0
    private var count = 0

    init(sampleRate: Double) {
        highpass = Biquad.highpass(sampleRate: sampleRate, frequency: 120, q: 0.7)
        lowpass = Biquad.lowpass(sampleRate: sampleRate, frequency: min(3800, sampleRate * 0.45), q: 0.7)
        window = max(1, Int((sampleRate * 0.02).rounded()))
    }

    /// Feed samples; get back one dBFS value for every completed 20 ms window.
    func process(_ samples: [Float]) -> [Double] {
        var out: [Double] = []
        for s in samples {
            let y = lowpass.process(highpass.process(Double(s)))
            sum += y * y
            count += 1
            if count >= window {
                let rms = (sum / Double(count)).squareRoot()
                out.append(20 * log10(max(rms, 1e-6)))
                sum = 0
                count = 0
            }
        }
        return out
    }
}
