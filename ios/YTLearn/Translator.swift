// Free mode's translation: a sentence in Chinese by Apple's own Translation, on the device (free, no AI, no key).
// It needs iOS 18 and a build with Xcode 16 or newer; without them the file is left out and the tutor's card shows
// the dictionary only (Bridge.swift answers "needs iOS 18").
// The first time, iOS may ask to download English and Chinese (Settings ▸ Apps ▸ Translate ▸ Languages).
#if canImport(Translation) && compiler(>=6.0)
import SwiftUI
import Translation

/// The sentences the page wants translated (window.webkit.messageHandlers.ytc: { kind: "translate", text }), one at a
/// time, by the translation session that TranslatorHost keeps open. Used on the main thread only.
@available(iOS 18.0, *)
final class FreeTranslator: ObservableObject {
    typealias Reply = (Any?, String?) -> Void
    struct Job { let text: String; let reply: Reply }

    /// English to Chinese (Simplified); nil until the first sentence comes (no session, no download sheet before)
    @Published var config: TranslationSession.Configuration?
    private var jobs: [Job] = []
    /// the session waits for the next sentence
    private var waiting: CheckedContinuation<Job, Never>?

    func translate(_ text: String, reply: @escaping Reply) {
        let job = Job(text: text, reply: reply)
        if let w = waiting { waiting = nil; w.resume(returning: job) } else { jobs.append(job) }
        if config == nil {
            config = TranslationSession.Configuration(source: Locale.Language(identifier: "en"), target: Locale.Language(identifier: "zh-Hans"))
        }
    }

    /// the next sentence (it waits until one comes)
    func next() async -> Job {
        await withCheckedContinuation { (c: CheckedContinuation<Job, Never>) in
            DispatchQueue.main.async {
                if self.jobs.isEmpty { self.waiting?.resume(returning: Job(text: "", reply: { _, _ in })); self.waiting = c }
                else { c.resume(returning: self.jobs.removeFirst()) }
            }
        }
    }
}

/// An invisible view that keeps the translation session open (SwiftUI's .translationTask) and works through the jobs.
@available(iOS 18.0, *)
struct TranslatorHost: View {
    @ObservedObject var translator: FreeTranslator

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .translationTask(translator.config) { session in
                while !Task.isCancelled {
                    let job = await translator.next()
                    if job.text.isEmpty { continue }
                    var text: String?
                    var problem: String?
                    do { text = try await session.translate(job.text).targetText } catch { problem = error.localizedDescription }
                    let (t, p) = (text, problem)
                    DispatchQueue.main.async { job.reply(t, p) }
                }
            }
    }
}
#endif
