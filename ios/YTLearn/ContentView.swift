import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
    @StateObject private var model = AppModel()
    @State private var showSettings = false
    @State private var railTouchedAt = Date()
    @State private var railDim = false
    @Environment(\.verticalSizeClass) private var vSize
    @Environment(\.horizontalSizeClass) private var hSize

    /// an iPhone on its side with the video full screen: no bar under the video, a small rail of buttons at the side
    private var compactFull: Bool { model.pageFull && vSize == .compact }
    private var hideBar: Bool { compactFull && !model.barPeek }
    /// an iPad (a wide window): bigger buttons
    private var wide: Bool { hSize == .regular && vSize == .regular }

    var body: some View {
        ZStack(alignment: .trailing) {
            VStack(spacing: 0) {
                // YouTube itself (search, your account, any video), with My tutor inside the page. No bar at the top:
                // Home, Paste link and App settings are the last buttons of the bottom bar.
                WebHost(webView: model.youtube)
                    .ignoresSafeArea(.container, edges: compactFull ? .all : [])
                    // (My tutor's pages; on the web view, which is always there: the bar is not, in full screen)
                    .sheet(isPresented: $model.sheetOpen) { TutorPageView(model: model) }
                if !hideBar { tutorBar }
            }
            if hideBar { sideRail.padding(.trailing, 6) }
        }
        .onAppear { model.start() }
        .overlay(alignment: .bottom) { toastView }
        .overlay(alignment: .bottomTrailing) { volumePanel }
        .statusBarHidden(compactFull)
        .persistentSystemOverlays(compactFull ? .hidden : .automatic)
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
    /// explain the LAST sentence, call the tutor, the tutor's volume (quieter / louder). Swipe the bar for the rest:
    /// in Video mode the two switches (subtitles on / off, the big page on / off), Full screen, Find a video, Voice,
    /// Mode, One button, Sleep, Words, Settings, Check, then the app's own Home, Paste link and App settings.
    /// With the tutor off (free mode: no AI, nothing paid): its switch, play / stop, the volume, the switches, Full
    /// screen, Mode, Find, and those three. One button mode changes NOTHING here (its button shows that it is on).
    private var tutorBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: wide ? 8 : 2) {
                Button { model.dream("tutor") } label: {
                    Circle()
                        .fill(model.tutorOn ? Color(red: 0.12, green: 0.56, blue: 0.24) : Color(red: 0.85, green: 0.19, blue: 0.15))
                        .frame(width: 16, height: 16)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(model.tutorOn ? "My tutor is on: turn it off (a normal YouTube page)" : "My tutor is off: turn it on")
                if model.tutorOn {
                    Group {
                        tutorButton("stop", "playpause.fill", "Play / stop", big: true)
                        tutorButton("explainLast", "text.bubble", "Explain \(model.explainSeconds) s", big: true)
                        tutorButton("explainSentence", "arrow.uturn.backward", "Last sentence", big: true)
                        tutorButton("talk", "phone.fill", "Call", big: true)
                        volumeButton
                    }
                    // (after a swipe)
                    Group {
                        // Video mode: the two switches (the subtitles on the video, the big page at stops)
                        if model.videoMode {
                            tutorButton("band", "captions.bubble", model.bandOn ? "Subtitles on" : "Subtitles off")
                            tutorButton("pageAuto", "doc.text", model.pageOn ? "Page on" : "Page off")
                        }
                        fullButton
                        tutorButton("find", "magnifyingglass", "Find video")
                        tutorButton("voiceMode", "mic", "Voice")
                        tutorButton("mode", "book", "Mode")
                        tutorButton("oneButton", model.oneButton ? "circle.inset.filled" : "circle", model.oneButton ? "One button on" : "One button")
                    }
                    Group {
                        tutorButton("sleep", "moon.zzz", "Sleep")
                        tutorButton("vocab", "character.book.closed", "Words")
                        tutorButton("quick", "slider.horizontal.3", "Settings")
                        tutorButton("check", "stethoscope", "Check")
                    }
                } else {
                    // the tutor is off: a normal YouTube page, nothing of the tutor. One big button turns it on again.
                    Button { model.dream("tutor") } label: { barLabel("power", "Tutor off", big: true) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("My tutor is off: turn it on")
                    if model.freeMode {
                        // (free mode, when Settings asks for it: the video stops at hard words, the card shows the dictionary, no AI)
                        tutorButton("stop", "playpause.fill", "Play / stop", big: true)
                        volumeButton
                        if model.videoMode {
                            tutorButton("band", "captions.bubble", model.bandOn ? "Subtitles on" : "Subtitles off")
                            tutorButton("pageAuto", "doc.text", model.pageOn ? "Page on" : "Page off")
                        }
                        fullButton
                        tutorButton("mode", "book", "Mode")
                        tutorButton("find", "magnifyingglass", "Find video")
                        tutorButton("quick", "slider.horizontal.3", "Settings")
                    }
                }
                appButton("house", "Home") { model.goHome() }
                appButton("book", "Read") { model.showReader = true }
                appButton("safari", "Browser") { model.showBrowser = true }
                appButton("link", "Paste link") { model.pasteLink() }
                appButton("gearshape", "App settings") { showSettings = true }
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
        }
        .background(Color(.secondarySystemBackground))
    }

    /// a button of the bar: a symbol with a word under it. `big`: the main ones (at least 60 pt wide and 48 high; an
    /// iPad: 88 x 56); the others at least 50 x 44
    private func barLabel(_ symbol: String, _ title: String, big: Bool = false) -> some View {
        VStack(spacing: 3) {
            Image(systemName: symbol).font(.system(size: big ? (wide ? 26 : 23) : (wide ? 20 : 17)))
            Text(title).font(.system(size: big ? (wide ? 14 : 12) : (wide ? 12 : 10), weight: big ? .medium : .regular)).lineLimit(1).fixedSize()
        }
        .frame(minWidth: big ? (wide ? 88 : 64) : (wide ? 64 : 50), minHeight: big ? (wide ? 56 : 48) : 44)
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

    // ---- the tutor's volume: one button in the bar opens two big buttons, quieter and louder ----
    private var volumeSymbol: String { model.tutorVolume <= 32 ? "speaker.wave.1" : model.tutorVolume <= 63 ? "speaker.wave.2" : "speaker.wave.3" }
    private var volumeButton: some View {
        Button { model.showVolume() } label: { barLabel(volumeSymbol, "Volume") }
            .buttonStyle(.plain)
            .accessibilityLabel("Tutor volume \(model.tutorVolume) percent: quieter or louder")
    }

    /// quieter / louder, big (60 pt), over the bottom right of the page; it goes by itself 4 s after the last touch
    @ViewBuilder
    private var volumePanel: some View {
        if model.volumeOpen {
            HStack(spacing: 12) {
                Button { model.volumeStep("quieter") } label: {
                    Image(systemName: "minus").font(.system(size: 26, weight: .bold)).frame(width: 64, height: 60).contentShape(Rectangle())
                }
                .accessibilityLabel("Tutor quieter")
                VStack(spacing: 2) {
                    Text("Tutor volume").font(.system(size: 12)).foregroundColor(.secondary)
                    Text("\(model.tutorVolume)%").font(.system(size: 22, weight: .semibold)).monospacedDigit()
                }
                .frame(minWidth: 92)
                Button { model.volumeStep("louder") } label: {
                    Image(systemName: "plus").font(.system(size: 26, weight: .bold)).frame(width: 64, height: 60).contentShape(Rectangle())
                }
                .accessibilityLabel("Tutor louder")
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
            .padding(.trailing, hideBar ? 76 : 10)
            .padding(.bottom, hideBar ? 12 : (wide ? 80 : 68))
        }
    }

    // ---- full screen ----
    private var fullButton: some View {
        Button { model.fullScreen() } label: {
            barLabel(model.pageFull ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right", model.pageFull ? "Leave full" : "Full screen")
        }
        .buttonStyle(.plain)
        .accessibilityLabel(model.pageFull ? "Leave full screen" : "Full screen")
    }

    /// an iPhone on its side, full screen: the main buttons in a rail at the side (60 pt each). It fades a little
    /// when it is not touched for a moment, but it never goes away. "More" brings the whole bar back for 6 s.
    private var sideRail: some View {
        VStack(spacing: 6) {
            railButton("playpause.fill", "Play / stop") { model.dream("stop") }
            if model.tutorOn {
                railButton("text.bubble", "Explain the last \(model.explainSeconds) seconds") { model.dream("explainLast") }
                railButton("phone.fill", "Call") { model.dream("talk") }
            }
            railButton("arrow.down.right.and.arrow.up.left", "Leave full screen") { model.fullScreen() }
            railButton("ellipsis", "More buttons") { model.peekBar() }
        }
        .opacity(railDim ? 0.4 : 1)
        .onAppear { railTouch() }
    }

    private func railButton(_ symbol: String, _ title: String, _ run: @escaping () -> Void) -> some View {
        Button { railTouch(); run() } label: {
            Image(systemName: symbol).font(.system(size: 22, weight: .medium))
                .frame(width: 60, height: 60)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
    }

    private func railTouch() {
        let now = Date()
        railTouchedAt = now
        railDim = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            if railTouchedAt == now { withAnimation(.easeOut(duration: 0.4)) { railDim = true } }
        }
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
    // the API keys, typed here (an empty box keeps the saved key)
    @State private var keyText: [String: String] = [:]
    @State private var keyEnds: [String: String] = [:]
    @State private var region = ""
    @State private var keyNote = ""
    private static let keyRows: [(String, String)] = [("azure", "Microsoft voice (Azure Speech, KEY 1)"), ("anthropic", "Claude"), ("openai", "OpenAI"), ("elevenlabs", "ElevenLabs"), ("github", "GitHub token")]

    private func keyField(_ name: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.footnote).foregroundColor(.secondary)
            SecureField(keyEnds[name].map { "saved (…\($0)): paste a new one to change it" } ?? "paste your key", text: Binding(get: { keyText[name] ?? "" }, set: { keyText[name] = $0 }))
                .textContentType(.oneTimeCode)   // (no "save this password?" question, no strong-password offer)
                .autocapitalization(.none)
                .disableAutocorrection(true)
                .frame(minHeight: 44)
        }
    }

    var body: some View {
        NavigationView {
            Form {
                Section(header: Text("My tutor")) {
                    Button("All settings (voice, Level Check…)") { presentation.wrappedValue.dismiss(); model.openPage("ytlearn://app/dream/options.html") }
                    Button("My Vocabulary") { presentation.wrappedValue.dismiss(); model.openPage("ytlearn://app/dream/vocab.html") }
                }
                Section(header: Text("API keys"),
                        footer: Text("Paste a key, then press Save the keys. An empty box keeps the key that is saved. Keys stay on this device (its Keychain). Claude explains; the Microsoft key (free) gives the natural voice. Test finds the Microsoft region by itself.")) {
                    ForEach(SettingsView.keyRows, id: \.0) { row in keyField(row.0, row.1) }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Microsoft region").font(.footnote).foregroundColor(.secondary)
                        TextField("eastus", text: $region).autocapitalization(.none).disableAutocorrection(true).frame(minHeight: 44)
                    }
                    Button("Save the keys") {
                        let n = model.saveKeys(keyText, region: region)
                        keyText = [:]
                        keyEnds = model.savedKeyEnds()
                        keyNote = n > 0 ? "\(n) key\(n == 1 ? "" : "s") saved." : "Nothing new to save (the region is kept)."
                    }
                    .frame(minHeight: 44)
                    Button("Test the Microsoft voice") {
                        keyNote = "Testing…"
                        model.testMicrosoft { text in keyNote = text; region = model.savedRegion }
                    }
                    .frame(minHeight: 44)
                    if !keyNote.isEmpty { Text(keyNote).font(.footnote) }
                }
                Section(header: Text("My vocabulary file (one for the Mac and this phone)"),
                        footer: Text("On the Mac, Chrome saves vocabulary.json in Documents ▸ MEH English, in iCloud Drive ▸ MEH English, and in Google Drive ▸ MEH English (when Google Drive is installed). iCloud Drive: choose that MEH English folder. Google Drive (the Files app does not let its folders be chosen): choose the file vocabulary.json inside it. The Mac and this phone then share one database: each adds its words, nothing is lost. Without that the words stay in the app (Files ▸ On My iPhone ▸ I Know ▸ vocabulary.json).")) {
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
            .onAppear { keyEnds = model.savedKeyEnds(); region = model.savedRegion }
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
