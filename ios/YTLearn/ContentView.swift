import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
    @StateObject private var model = AppModel()
    @State private var showSettings = false

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            // YouTube itself (search, your account, any video), with My tutor inside the page
            WebHost(webView: model.youtube)
            tutorBar
        }
        .onAppear { model.start() }
        .overlay(alignment: .bottom) { toastView }
        .sheet(isPresented: $showSettings) { SettingsView(model: model) }
    }

    /// My tutor's buttons (there is no keyboard on the phone): the same actions as its keyboard shortcuts
    private var tutorBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                Button { model.dream("tutor") } label: {
                    Text(model.tutorOn ? "My tutor ● on" : "My tutor ○ off")
                        .font(.footnote.weight(.semibold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(Capsule().fill(model.tutorOn ? Color(red: 0.12, green: 0.56, blue: 0.24) : Color(red: 0.85, green: 0.19, blue: 0.15)))
                }
                .buttonStyle(.plain)
                if model.tutorOn {
                    tutorButton("stop", "playpause.fill", "Stop / play")
                    tutorButton("explainLast", "text.bubble", "Explain 30 s")
                    tutorButton("explainSentence", "arrow.uturn.backward", "Last sentence")
                    tutorButton("talk", "phone.fill", "Talk")
                    tutorButton("voiceMode", "mic", "Voice")
                    tutorButton("pageAuto", "doc.text", "Page")
                    tutorButton("listening", "book", "Listening")
                    tutorButton("vocab", "character.book.closed", "Words")
                    tutorButton("quick", "slider.horizontal.3", "Settings")
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
        }
        .background(Color(.secondarySystemBackground))
        // (its own view: two sheets on one view do not work on every iOS)
        .sheet(isPresented: $model.sheetOpen) { TutorPageView(model: model) }
    }

    private func tutorButton(_ action: String, _ symbol: String, _ title: String) -> some View {
        Button { model.dream(action) } label: {
            VStack(spacing: 2) {
                Image(systemName: symbol).font(.system(size: 17))
                Text(title).font(.system(size: 10))
            }
            .frame(minWidth: 52)
        }
        .accessibilityLabel(title)
    }

    private var toolbar: some View {
        HStack(spacing: 14) {
            Text("YT Learn").font(.subheadline.weight(.semibold))
            Spacer(minLength: 0)
            Button { model.goHome() } label: { Label("YouTube home", systemImage: "house") }
            Button { model.pasteLink() } label: { Label("Open copied YouTube link", systemImage: "link") }
            Button { showSettings = true } label: { Label("Settings", systemImage: "gearshape") }
        }
        .labelStyle(.iconOnly)
        .font(.title3)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
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
