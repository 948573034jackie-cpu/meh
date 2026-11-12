import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
    @StateObject private var model = AppModel()
    @State private var showSettings = false

    var body: some View {
        VStack(spacing: 0) {
            // YouTube itself (search, your account, any video), with My tutor inside the page. No bar at the top:
            // Home, Paste link and App settings are the last buttons of the bottom bar.
            WebHost(webView: model.youtube)
            tutorBar
        }
        .onAppear { model.start() }
        .overlay(alignment: .bottom) { toastView }
        .sheet(isPresented: $showSettings) { SettingsView(model: model) }
        .background(translatorHost)
        .background(AppCovers(model: model))        // the reader and the browser, full screen
        .onOpenURL { model.openLink($0) }           // "Open this link in I Know": iknow://open?url=…
    }

    /// free mode's translation (Apple's Translation, iOS 18): an invisible view keeps its session open
    @ViewBuilder
    private var translatorHost: some View {
        #if canImport(Translation) && compiler(>=6.0)
        if #available(iOS 18.0, *) {
            if let t = model.translator as? FreeTranslator { TranslatorHost(translator: t) }
        }
        #endif
    }

    /// The one bar of the app (there is no keyboard on the phone: the same actions as My tutor's keyboard shortcuts).
    /// Left to right, in view on an iPhone: the tutor's switch (a small dot), play / stop, explain the last N seconds,
    /// explain the LAST sentence, in Video mode the two switches (subtitles on / off, the big page on / off), call the
    /// tutor, bigger than before (the ask box is gone). Swipe the bar for the
    /// rest: Find a video, Voice, Mode, One button, Sleep, Words, Settings, Check, then the app's own Home, Paste link
    /// and App settings. With the tutor off (free mode: no AI, nothing paid): its switch, play / stop, in Video mode the
    /// two switches, Mode, Find, and those three. In one-button mode: only the way out.
    private var tutorBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                Button { model.dream("tutor") } label: {
                    Circle()
                        .fill(model.tutorOn ? Color(red: 0.12, green: 0.56, blue: 0.24) : Color(red: 0.85, green: 0.19, blue: 0.15))
                        .frame(width: 16, height: 16)
                        .frame(width: 30, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(model.tutorOn ? "My tutor is on: switch to free mode" : "Free mode (no AI): turn My tutor on")
                if model.tutorOn && model.oneButton {
                    Button { model.dream("oneButton") } label: {
                        Text("Leave one-button mode").font(.system(size: 13, weight: .semibold))
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .background(Capsule().fill(Color(.tertiarySystemFill)))
                    }
                    .buttonStyle(.plain)
                } else if model.tutorOn {
                    Group {
                        tutorButton("stop", "playpause.fill", "Play / stop", big: true)
                        tutorButton("explainLast", "text.bubble", "Explain \(model.explainSeconds) s", big: true)
                        tutorButton("explainSentence", "arrow.uturn.backward", "Last sentence", big: true)
                        // Video mode: the two switches (the subtitles on the video, the big page at stops)
                        if model.videoMode {
                            tutorButton("band", "captions.bubble", model.bandOn ? "Subtitles on" : "Subtitles off", big: true)
                            tutorButton("pageAuto", "doc.text", model.pageOn ? "Page on" : "Page off", big: true)
                        }
                        tutorButton("talk", "phone.fill", "Call", big: true)
                    }
                    // (after a swipe)
                    Group {
                        tutorButton("find", "magnifyingglass", "Find video")
                        tutorButton("voiceMode", "mic", "Voice")
                        tutorButton("mode", "book", "Mode")
                        tutorButton("oneButton", "circle.fill", "One button")
                    }
                    Group {
                        tutorButton("sleep", "moon.zzz", "Sleep")
                        tutorButton("vocab", "character.book.closed", "Words")
                        tutorButton("quick", "slider.horizontal.3", "Settings")
                        tutorButton("check", "stethoscope", "Check")
                    }
                } else {
                    // free mode: the video stops at hard words by itself, the card shows the dictionary (no AI)
                    tutorButton("stop", "playpause.fill", "Play / stop", big: true)
                    if model.videoMode {
                        tutorButton("band", "captions.bubble", model.bandOn ? "Subtitles on" : "Subtitles off", big: true)
                        tutorButton("pageAuto", "doc.text", model.pageOn ? "Page on" : "Page off", big: true)
                    }
                    tutorButton("mode", "book", "Mode")
                    tutorButton("find", "magnifyingglass", "Find video")
                }
                if !(model.tutorOn && model.oneButton) {
                    appButton("house", "Home") { model.goHome() }
                    appButton("book", "Read") { model.showReader = true }
                    appButton("safari", "Browser") { model.showBrowser = true }
                    appButton("link", "Paste link") { model.pasteLink() }
                    appButton("gearshape", "App settings") { showSettings = true }
                }
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
        }
        .background(Color(.secondarySystemBackground))
        // (its own view: two sheets on one view do not work on every iOS)
        .sheet(isPresented: $model.sheetOpen) { TutorPageView(model: model) }
    }

    /// a button of the bar: a symbol with a word under it. `big`: the four main ones (they fit side by side on 375 pt)
    private func barLabel(_ symbol: String, _ title: String, big: Bool = false) -> some View {
        VStack(spacing: 3) {
            Image(systemName: symbol).font(.system(size: big ? 23 : 17))
            Text(title).font(.system(size: big ? 12 : 10, weight: big ? .medium : .regular)).lineLimit(1).fixedSize()
        }
        .frame(minWidth: big ? 74 : 50, minHeight: big ? 48 : 40)
        .contentShape(Rectangle())
    }

    /// one of My tutor's actions (window.__ytcDream.action in the page)
    private func tutorButton(_ action: String, _ symbol: String, _ title: String, big: Bool = false) -> some View {
        Button { model.dream(action) } label: { barLabel(symbol, title, big: big) }
            .buttonStyle(.plain)
            .accessibilityLabel(title)
    }

    /// one of the app's own buttons (they were the bar at the top)
    private func appButton(_ symbol: String, _ title: String, _ run: @escaping () -> Void) -> some View {
        Button(action: run) { barLabel(symbol, title) }
            .buttonStyle(.plain)
            .accessibilityLabel(title)
    }

    @ViewBuilder
    private var toastView: some View {
        if let text = model.toast {
            Text(text)
                .font(.footnote)
                .padding(10)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 10))
                .padding()
                .onTapGesture { model.toast = nil }
        }
    }
}

struct SettingsView: View {
    @ObservedObject var model: AppModel
    @Environment(\.presentationMode) private var presentation
    @State private var pickFolder = false
    @State private var pickFile = false

    var body: some View {
        NavigationView {
            Form {
                Section(header: Text("My tutor")) {
                    Button("All settings (API keys, voice, Level Check…)") { presentation.wrappedValue.dismiss(); model.openPage("ytlearn://app/dream/options.html") }
                    Button("My Vocabulary") { presentation.wrappedValue.dismiss(); model.openPage("ytlearn://app/dream/vocab.html") }
                }
                Section(header: Text("My vocabulary file (one for the Mac and this phone)"),
                        footer: Text("On the Mac, Chrome saves vocabulary.json in Documents ▸ MEH English, in iCloud Drive ▸ MEH English, and in Google Drive ▸ MEH English (when Google Drive is installed). iCloud Drive: choose that MEH English folder. Google Drive (the Files app does not let its folders be chosen): choose the file vocabulary.json inside it. The Mac and this phone then share one database: each adds its words, nothing is lost. Without that the words stay in the app (Files ▸ On My iPhone ▸ YT Learn ▸ vocabulary.json).")) {
                    Text(model.vocabFolder.map { "Shared: \($0)" } ?? "Nothing shared yet: the words stay in the app")
                    if !model.vocabStatus.isEmpty {
                        Text(model.vocabStatus).font(.footnote).foregroundColor(.secondary)
                    }
                    Button("Choose the folder (iCloud Drive ▸ MEH English)…") { pickFolder = true }
                    Button("Or choose the file vocabulary.json (Google Drive)…") { pickFile = true }
                    if model.vocabFolder != nil {
                        Button("Stop sharing (keep the words in the app)", role: .destructive) { model.forgetVocabFolder() }
                    }
                }
                Section(header: Text("Microphone and voice"), footer: Text("Allow the Microphone and Speech Recognition when iOS asks: the tutor listens only while it waits for you (I know / I don't know, a question, a call, voice mode). Better voices: iOS Settings ▸ Accessibility ▸ Spoken Content ▸ Voices ▸ English ▸ download a Premium or Enhanced voice.")) {
                    EmptyView()
                }
            }
            .navigationTitle("Settings")
            .navigationBarItems(trailing: Button("Done") { presentation.wrappedValue.dismiss() })
        }
        .navigationViewStyle(.stack)
        .sheet(isPresented: $pickFolder) { FolderPicker(types: [UTType.folder]) { url in model.chooseVocabFolder(url) } }
        .background(EmptyView().sheet(isPresented: $pickFile) { FolderPicker(types: [UTType.json]) { url in model.chooseVocabFolder(url, isFile: true) } })
    }
}

/// the Files app: pick a folder (iCloud Drive, On My iPhone, …) or one file, opened in place
struct FolderPicker: UIViewControllerRepresentable {
    let types: [UTType]
    let picked: (URL) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(picked: picked) }

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: false)
        picker.allowsMultipleSelection = false
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIDocumentPickerViewController, context: Context) {}

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let picked: (URL) -> Void
        init(picked: @escaping (URL) -> Void) { self.picked = picked }
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            if let url = urls.first { picked(url) }
        }
    }
}

/// My tutor's settings page or My Vocabulary (ytlearn://app/dream/…), in a sheet
struct TutorPageView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        NavigationView {
            WebHost(webView: model.sheet)
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle("My tutor")
                .navigationBarTitleDisplayMode(.inline)
                .navigationBarItems(trailing: Button("Done") { model.sheetOpen = false })
        }
        .navigationViewStyle(.stack)
    }
}
