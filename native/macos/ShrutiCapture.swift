// shruti-capture: macOS audio capture sidecar.
//
// Captures two parallel streams and writes them as 16-bit PCM mono WAV
// files at 16 kHz, ready for whisper.cpp:
//   <outdir>/mic.wav     — your microphone
//   <outdir>/system.wav  — system audio out (everyone else in the call)
//
// Lifecycle:
//   1. parses --output <dir> from argv
//   2. starts ScreenCaptureKit audio capture + AVAudioEngine mic tap
//   3. emits one JSON status line per second to stderr (so the parent
//      Node process can show progress)
//   4. on SIGINT/SIGTERM, finalizes the WAV headers and exits 0
//
// Permissions: requires Screen Recording (for system audio under
// ScreenCaptureKit) and Microphone access. Both are prompted by the
// OS the first time the binary runs.
//
// This is intentionally a single file — easy to ship, easy to audit.

import AVFoundation
import Foundation
import ScreenCaptureKit

// MARK: - WAV writer

final class WavWriter {
    private let handle: FileHandle
    private let path: String
    private var samplesWritten: UInt32 = 0
    private let sampleRate: UInt32
    private let bitsPerSample: UInt16 = 16
    private let channels: UInt16 = 1
    private let lock = NSLock()

    init(path: String, sampleRate: UInt32) throws {
        self.path = path
        self.sampleRate = sampleRate
        FileManager.default.createFile(atPath: path, contents: nil)
        guard let h = FileHandle(forWritingAtPath: path) else {
            throw NSError(domain: "shruti", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "cannot open \(path)"])
        }
        self.handle = h
        try writePlaceholderHeader()
    }

    private func writePlaceholderHeader() throws {
        let header = Data(count: 44)
        handle.write(header)
    }

    /// Append 16-bit signed mono PCM samples (host-endian little-endian).
    func appendInt16(_ samples: [Int16]) {
        lock.lock(); defer { lock.unlock() }
        samples.withUnsafeBytes { buf in
            handle.write(Data(buf))
        }
        samplesWritten = samplesWritten &+ UInt32(samples.count)
    }

    func finalize() throws {
        lock.lock(); defer { lock.unlock() }
        let byteRate = sampleRate * UInt32(channels) * UInt32(bitsPerSample / 8)
        let blockAlign = channels * (bitsPerSample / 8)
        let dataSize = samplesWritten * UInt32(channels) * UInt32(bitsPerSample / 8)
        let chunkSize = 36 + dataSize

        var header = Data()
        header.append(contentsOf: Array("RIFF".utf8))
        header.append(le32(chunkSize))
        header.append(contentsOf: Array("WAVE".utf8))
        header.append(contentsOf: Array("fmt ".utf8))
        header.append(le32(16))
        header.append(le16(1))                 // PCM
        header.append(le16(channels))
        header.append(le32(sampleRate))
        header.append(le32(byteRate))
        header.append(le16(blockAlign))
        header.append(le16(bitsPerSample))
        header.append(contentsOf: Array("data".utf8))
        header.append(le32(dataSize))

        try handle.seek(toOffset: 0)
        handle.write(header)
        try handle.close()
    }

    private func le16(_ v: UInt16) -> Data {
        var x = v.littleEndian
        return Data(bytes: &x, count: 2)
    }
    private func le32(_ v: UInt32) -> Data {
        var x = v.littleEndian
        return Data(bytes: &x, count: 4)
    }
}

// MARK: - PCM resample helper

/// Convert any AVAudioPCMBuffer into 16 kHz mono Int16 samples.
///
/// We create a fresh AVAudioConverter per call. Caching one and
/// re-using it across taps is tempting but breaks: the only way to
/// signal "this is the last input I have right now" without leaving
/// the converter waiting is `.endOfStream`, which permanently
/// terminates the converter. On the next call it returns no data.
/// Per-call construction is a few microseconds — cheap vs. the cost
/// of a silent capture bug.
func resampleTo16kMono(_ src: AVAudioPCMBuffer) -> [Int16] {
    guard src.frameLength > 0 else { return [] }
    let outFmt = AVAudioFormat(commonFormat: .pcmFormatInt16,
                               sampleRate: 16000,
                               channels: 1,
                               interleaved: true)!
    guard let conv = AVAudioConverter(from: src.format, to: outFmt) else { return [] }
    let ratio = 16000.0 / src.format.sampleRate
    let outFrameCap = AVAudioFrameCount(Double(src.frameLength) * ratio + 32)
    guard let outBuf = AVAudioPCMBuffer(pcmFormat: outFmt, frameCapacity: outFrameCap) else {
        return []
    }
    var consumed = false
    var err: NSError?
    let status = conv.convert(to: outBuf, error: &err) { _, outStatus in
        if consumed { outStatus.pointee = .endOfStream; return nil }
        consumed = true
        outStatus.pointee = .haveData
        return src
    }
    if status == .error || err != nil { return [] }
    let frames = Int(outBuf.frameLength)
    guard frames > 0, let int16Ptr = outBuf.int16ChannelData?[0] else { return [] }
    return Array(UnsafeBufferPointer(start: int16Ptr, count: frames))
}

// MARK: - Stream output handler

@available(macOS 13.0, *)
final class SystemAudioOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    let writer: WavWriter
    var audioBufferCount: Int = 0
    var screenBufferCount: Int = 0
    var audioWriteCount: Int = 0
    var firstAudioFormat: String = ""

    init(writer: WavWriter) {
        self.writer = writer
    }

    func stream(_ stream: SCStream,
                didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        switch type {
        case .audio:
            audioBufferCount += 1
            guard CMSampleBufferIsValid(sampleBuffer),
                  CMSampleBufferDataIsReady(sampleBuffer),
                  let pcm = pcmBufferFromSampleBuffer(sampleBuffer)
            else { return }
            if firstAudioFormat.isEmpty {
                firstAudioFormat = "rate=\(pcm.format.sampleRate) ch=\(pcm.format.channelCount)"
                FileHandle.standardError.write(
                    "{\"event\":\"sys_first_audio\",\"format\":\"\(firstAudioFormat)\"}\n".data(using: .utf8)!
                )
            }
            let samples = resampleTo16kMono(pcm)
            if !samples.isEmpty {
                writer.appendInt16(samples)
                audioWriteCount += 1
            }
        case .screen:
            screenBufferCount += 1
        default:
            break
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        FileHandle.standardError.write(
            "{\"event\":\"stream_error\",\"message\":\"\(error.localizedDescription)\"}\n".data(using: .utf8)!
        )
    }
}

/// Convert a CMSampleBuffer of audio into an AVAudioPCMBuffer.
///
/// Implementation note: the previous version used a stack-allocated
/// `AudioBufferList` sized for ONE buffer, which silently failed for
/// stereo non-interleaved audio (the format ScreenCaptureKit delivers).
/// The right pattern is to ask Core Media for the required size first,
/// allocate that many bytes, then ask it to fill them.
func pcmBufferFromSampleBuffer(_ sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
    guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
          let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc)
    else { return nil }
    var asbd = asbdPtr.pointee
    guard let format = AVAudioFormat(streamDescription: &asbd) else { return nil }
    let frameCount = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
    guard frameCount > 0,
          let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount)
    else { return nil }
    pcm.frameLength = frameCount

    // Step 1: ask how big the AudioBufferList needs to be.
    var sizeNeeded = 0
    var status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sampleBuffer,
        bufferListSizeNeededOut: &sizeNeeded,
        bufferListOut: nil,
        bufferListSize: 0,
        blockBufferAllocator: nil,
        blockBufferMemoryAllocator: nil,
        flags: 0,
        blockBufferOut: nil
    )
    guard status == noErr, sizeNeeded > 0 else { return nil }

    // Step 2: allocate a buffer of that size and fetch the list.
    let raw = UnsafeMutableRawPointer.allocate(byteCount: sizeNeeded,
                                               alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    let ablPtr = raw.assumingMemoryBound(to: AudioBufferList.self)
    var blockBuffer: CMBlockBuffer?
    status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sampleBuffer,
        bufferListSizeNeededOut: nil,
        bufferListOut: ablPtr,
        bufferListSize: sizeNeeded,
        blockBufferAllocator: nil,
        blockBufferMemoryAllocator: nil,
        flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
        blockBufferOut: &blockBuffer
    )
    guard status == noErr else { return nil }

    let srcABL = UnsafeMutableAudioBufferListPointer(ablPtr)
    let dstABL = UnsafeMutableAudioBufferListPointer(pcm.mutableAudioBufferList)
    let n = min(srcABL.count, dstABL.count)
    for i in 0..<n {
        dstABL[i].mDataByteSize = srcABL[i].mDataByteSize
        if let dst = dstABL[i].mData, let src = srcABL[i].mData {
            memcpy(dst, src, Int(srcABL[i].mDataByteSize))
        }
    }
    return pcm
}

// MARK: - Recorder

@available(macOS 13.0, *)
final class Recorder {
    let outDir: URL
    var systemWriter: WavWriter?
    var micWriter: WavWriter?
    var stream: SCStream?
    var systemOutput: SystemAudioOutput?
    var engine: AVAudioEngine?
    var micBufferCount: Int = 0
    var startedAt: Date?

    init(outDir: URL) { self.outDir = outDir }

    func start() async throws {
        try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
        let micPath = outDir.appendingPathComponent("mic.wav").path
        let sysPath = outDir.appendingPathComponent("system.wav").path
        self.micWriter = try WavWriter(path: micPath, sampleRate: 16000)
        self.systemWriter = try WavWriter(path: sysPath, sampleRate: 16000)

        try await startSystemCapture(writer: systemWriter!)
        try startMicCapture(writer: micWriter!)

        startedAt = Date()
        emit(["event": "started", "outDir": outDir.path])
    }

    func stop() {
        emit(["event": "stopping"])
        if let eng = engine {
            eng.stop()
            eng.inputNode.removeTap(onBus: 0)
        }
        if let s = stream {
            s.stopCapture { err in
                if let err = err {
                    FileHandle.standardError.write(
                        "{\"event\":\"stop_error\",\"message\":\"\(err.localizedDescription)\"}\n".data(using: .utf8)!
                    )
                }
            }
        }
        // Give the stream a moment to flush in-flight buffers.
        Thread.sleep(forTimeInterval: 0.3)
        try? micWriter?.finalize()
        try? systemWriter?.finalize()
        let duration = startedAt.map { Date().timeIntervalSince($0) } ?? 0
        emit([
            "event": "stopped",
            "durationS": duration,
            "micBuffers": micBufferCount,
            "sysScreenBuffers": systemOutput?.screenBufferCount ?? 0,
            "sysAudioBuffers": systemOutput?.audioBufferCount ?? 0,
            "sysAudioWrites": systemOutput?.audioWriteCount ?? 0,
        ])
    }

    private func startSystemCapture(writer: WavWriter) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false,
                                                                           onScreenWindowsOnly: true)
        guard let display = content.displays.first else {
            throw NSError(domain: "shruti", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "no display available"])
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let cfg = SCStreamConfiguration()
        cfg.capturesAudio = true
        cfg.excludesCurrentProcessAudio = false
        cfg.sampleRate = 48000
        cfg.channelCount = 2
        // SCStream requires a sane video config even when we only care
        // about audio. Tiny / degenerate values cause the framework to
        // silently drop the audio output too. Use a small but real
        // resolution at a low frame rate; we never read the video.
        cfg.width = 320
        cfg.height = 240
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 5) // 5 fps
        cfg.queueDepth = 6

        let output = SystemAudioOutput(writer: writer)
        let stream = SCStream(filter: filter, configuration: cfg, delegate: output)
        // We must add a screen handler too — without it, some macOS
        // versions throttle the entire stream including audio.
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: .global(qos: .background))
        try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: .global(qos: .userInitiated))
        try await stream.startCapture()
        self.stream = stream
        self.systemOutput = output
    }

    private func startMicCapture(writer: WavWriter) throws {
        let engine = AVAudioEngine()
        let input = engine.inputNode

        // NOTE: We deliberately do NOT call setVoiceProcessingEnabled(true).
        // Apple's voice processing IO takes the audio path into
        // "communications mode": it ducks system audio AND blocks
        // ScreenCaptureKit from observing the system audio stream — which
        // breaks the dual-channel meeting recording this app exists for.
        // The trade-off is that the mic captures speaker bleed when the
        // user isn't on headphones; we accept that and document headphones
        // as the recommended workflow.

        let format = input.outputFormat(forBus: 0)
        emit(["event": "mic_format",
              "sampleRate": format.sampleRate,
              "channels": Int(format.channelCount)])
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buf, _ in
            guard let self = self else { return }
            let samples = resampleTo16kMono(buf)
            if !samples.isEmpty {
                writer.appendInt16(samples)
                self.micBufferCount += 1
            }
        }
        try engine.start()
        self.engine = engine
    }

    func emit(_ payload: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: payload),
           let str = String(data: data, encoding: .utf8) {
            FileHandle.standardError.write((str + "\n").data(using: .utf8)!)
        }
    }
}

// MARK: - argv

func arg(_ name: String) -> String? {
    let argv = CommandLine.arguments
    guard let i = argv.firstIndex(of: name), i + 1 < argv.count else { return nil }
    return argv[i + 1]
}

// MARK: - main

guard #available(macOS 13.0, *) else {
    FileHandle.standardError.write("shruti-capture requires macOS 13+\n".data(using: .utf8)!)
    exit(1)
}

guard let outArg = arg("--output") else {
    FileHandle.standardError.write("usage: shruti-capture --output <dir>\n".data(using: .utf8)!)
    exit(2)
}

let outDir = URL(fileURLWithPath: outArg)
let recorder = Recorder(outDir: outDir)

let signalSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
let signalSource2 = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)

let stopAndExit: () -> Void = {
    recorder.stop()
    exit(0)
}
signalSource.setEventHandler(handler: stopAndExit)
signalSource2.setEventHandler(handler: stopAndExit)
signalSource.resume()
signalSource2.resume()

Task {
    do {
        try await recorder.start()
    } catch {
        let msg = error.localizedDescription.replacingOccurrences(of: "\"", with: "'")
        FileHandle.standardError.write(
            "{\"event\":\"start_error\",\"message\":\"\(msg)\"}\n".data(using: .utf8)!
        )
        exit(3)
    }
}

FileHandle.standardError.write("{\"event\":\"main_loop\"}\n".data(using: .utf8)!)

dispatchMain()
