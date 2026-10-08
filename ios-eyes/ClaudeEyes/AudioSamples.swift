import AudioToolbox
import CoreMedia

/// Turns the microphone buffers that the screen broadcast delivers into plain mono Float samples.
/// Handles 16-bit / 32-bit integer and 32-bit float, one or more channels, interleaved or not.
enum AudioSamples {
    static func mono(from sampleBuffer: CMSampleBuffer) -> (samples: [Float], rate: Double)? {
        guard let format = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(format) else { return nil }
        let asbd = asbdPtr.pointee
        guard asbd.mFormatID == kAudioFormatLinearPCM, asbd.mSampleRate > 0 else { return nil }
        let frames = CMSampleBufferGetNumSamples(sampleBuffer)
        guard frames > 0 else { return nil }

        var needed = 0
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: &needed, bufferListOut: nil, bufferListSize: 0,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
        guard needed > 0 else { return nil }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: needed, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        let listPtr = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
        var block: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: nil, bufferListOut: listPtr, bufferListSize: needed,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &block)
        guard status == noErr else { return nil }
        let buffers = UnsafeMutableAudioBufferListPointer(listPtr)
        guard buffers.count > 0 else { return nil }

        let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        let planar = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
        let bits = Int(asbd.mBitsPerChannel)
        let channels = max(1, Int(asbd.mChannelsPerFrame))

        var out = [Float](repeating: 0, count: frames)
        if planar {
            var used = 0
            for b in buffers {
                let ch = decode(b, count: frames, isFloat: isFloat, bits: bits)
                if ch.isEmpty { continue }
                used += 1
                for i in 0..<min(frames, ch.count) { out[i] += ch[i] }
            }
            guard used > 0 else { return nil }
            if used > 1 { let k = 1 / Float(used); for i in 0..<frames { out[i] *= k } }
        } else {
            let all = decode(buffers[0], count: frames * channels, isFloat: isFloat, bits: bits)
            guard all.count >= channels else { return nil }
            let n = min(frames, all.count / channels)
            out = [Float](repeating: 0, count: n)
            for f in 0..<n {
                var s: Float = 0
                for c in 0..<channels { s += all[f * channels + c] }
                out[f] = s / Float(channels)
            }
        }
        return (out, asbd.mSampleRate)
    }

    private static func decode(_ buffer: AudioBuffer, count: Int, isFloat: Bool, bits: Int) -> [Float] {
        guard let data = buffer.mData else { return [] }
        let bytes = Int(buffer.mDataByteSize)
        switch (isFloat, bits) {
        case (true, 32):
            let n = min(count, bytes / 4)
            let p = data.bindMemory(to: Float.self, capacity: max(n, 1))
            return Array(UnsafeBufferPointer(start: p, count: n))
        case (false, 16):
            let n = min(count, bytes / 2)
            let p = data.bindMemory(to: Int16.self, capacity: max(n, 1))
            return UnsafeBufferPointer(start: p, count: n).map { Float($0) / 32768 }
        case (false, 32):
            let n = min(count, bytes / 4)
            let p = data.bindMemory(to: Int32.self, capacity: max(n, 1))
            return UnsafeBufferPointer(start: p, count: n).map { Float($0) / 2147483648 }
        default:
            return []
        }
    }
}
