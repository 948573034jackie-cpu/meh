import AudioToolbox
import CoreMedia
import XCTest
@testable import ClaudeEyes

final class AudioSamplesTests: XCTestCase {
    func makeBuffer(_ data: Data, frames: Int, rate: Double, channels: UInt32,
                    bits: UInt32, float: Bool, planar: Bool) -> CMSampleBuffer {
        let bytesPerSample = bits / 8
        var flags: AudioFormatFlags = float ? kAudioFormatFlagIsFloat : kAudioFormatFlagIsSignedInteger
        flags |= kAudioFormatFlagIsPacked
        if planar { flags |= kAudioFormatFlagIsNonInterleaved }
        var asbd = AudioStreamBasicDescription(
            mSampleRate: rate, mFormatID: kAudioFormatLinearPCM, mFormatFlags: flags,
            mBytesPerPacket: planar ? bytesPerSample : bytesPerSample * channels, mFramesPerPacket: 1,
            mBytesPerFrame: planar ? bytesPerSample : bytesPerSample * channels,
            mChannelsPerFrame: channels, mBitsPerChannel: bits, mReserved: 0)
        var format: CMAudioFormatDescription?
        XCTAssertEqual(CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &asbd, layoutSize: 0, layout: nil,
                                                      magicCookieSize: 0, magicCookie: nil, extensions: nil,
                                                      formatDescriptionOut: &format), noErr)
        var block: CMBlockBuffer?
        XCTAssertEqual(CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: data.count,
                                                          blockAllocator: kCFAllocatorDefault, customBlockSource: nil,
                                                          offsetToData: 0, dataLength: data.count, flags: 0,
                                                          blockBufferOut: &block), noErr)
        data.withUnsafeBytes { raw in
            XCTAssertEqual(CMBlockBufferReplaceDataBytes(with: raw.baseAddress!, blockBuffer: block!, offsetIntoDestination: 0,
                                                         dataLength: data.count), noErr)
        }
        var sample: CMSampleBuffer?
        XCTAssertEqual(CMAudioSampleBufferCreateReadyWithPacketDescriptions(
            allocator: kCFAllocatorDefault, dataBuffer: block!, formatDescription: format!, sampleCount: frames,
            presentationTimestamp: .zero, packetDescriptions: nil, sampleBufferOut: &sample), noErr)
        return sample!
    }

    func data<T>(_ values: [T]) -> Data { values.withUnsafeBufferPointer { Data(buffer: $0) } }

    func testInt16Mono() throws {
        let sb = makeBuffer(data([Int16(16384), Int16(-16384), Int16(0), Int16(32767)]), frames: 4, rate: 44100,
                            channels: 1, bits: 16, float: false, planar: false)
        let r = try XCTUnwrap(AudioSamples.mono(from: sb))
        XCTAssertEqual(r.rate, 44100)
        XCTAssertEqual(r.samples.count, 4)
        XCTAssertEqual(r.samples[0], 0.5, accuracy: 0.001)
        XCTAssertEqual(r.samples[1], -0.5, accuracy: 0.001)
        XCTAssertEqual(r.samples[3], 1.0, accuracy: 0.001)
    }

    func testFloatStereoInterleavedIsAveraged() throws {
        // frames: (0.2, 0.4), (-0.6, 0.0)
        let sb = makeBuffer(data([Float(0.2), 0.4, -0.6, 0.0]), frames: 2, rate: 48000,
                            channels: 2, bits: 32, float: true, planar: false)
        let r = try XCTUnwrap(AudioSamples.mono(from: sb))
        XCTAssertEqual(r.rate, 48000)
        XCTAssertEqual(r.samples.count, 2)
        XCTAssertEqual(r.samples[0], 0.3, accuracy: 0.001)
        XCTAssertEqual(r.samples[1], -0.3, accuracy: 0.001)
    }

    func testFloatStereoPlanarIsAveraged() throws {
        // left channel first, then the right channel
        let sb = makeBuffer(data([Float(0.2), -0.6, 0.4, 0.0]), frames: 2, rate: 48000,
                            channels: 2, bits: 32, float: true, planar: true)
        let r = try XCTUnwrap(AudioSamples.mono(from: sb))
        XCTAssertEqual(r.samples.count, 2)
        XCTAssertEqual(r.samples[0], 0.3, accuracy: 0.001)
        XCTAssertEqual(r.samples[1], -0.3, accuracy: 0.001)
    }

    func testInt32Mono() throws {
        let sb = makeBuffer(data([Int32(1_073_741_824)]), frames: 1, rate: 16000,
                            channels: 1, bits: 32, float: false, planar: false)
        let r = try XCTUnwrap(AudioSamples.mono(from: sb))
        XCTAssertEqual(r.samples[0], 0.5, accuracy: 0.001)
    }
}
