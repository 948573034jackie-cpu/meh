import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
    @StateObject private var model = AppModel()
    @State private var railTouchedAt = Date()
    @State private var railDim = false
    @Environment(\.verticalSizeClass) private var vSize
    @Environment(\.horizontalSizeClass) private var hSize

    /// an iPhone on its side with the video full screen: no bar under the video, a small rail of buttons at the side
    private var compactFull: Bool { model.pageFull && vSize == .compact }
    private var hideBar: Bool { compactFull && !model.barPeek }
    /// an iPad (a wide window): bigger buttons
    private var wide: Bool { hSize == .regular && vSize == .regular }

    /// Three tabs at the bottom: Watch (YouTube with the tutor), Words (My Vocabulary), Settings (one place for every
    /// setting). The YouTube page stays loaded behind the other two (nothing is lost when you come back).
    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                watchScreen
                    .opacity(model.tab == .watch ? 1 : 0)
                    .allowsHitTesting(model.tab == .watch)
                    .accessibilityHidden(model.tab != .watch)
                if model.tab == .words { WordsScreen(model: model) }
                if model.tab == .settings { SettingsTab(model: model) }
            }
            // (full screen on an iPhone on its side: no tab bar, as no bar)
            if !compactFull {
                AppTabBar(tab: $model.tab) { again in if again == .watch { model.goHome() } }
            }
        }
        .onAppear {
            model.start()
            model.openShotScreen { model.tab = .settings }   // (only with -shot <name>: the build server's pictures)
        }
        .overlay(alignment: .bottom) { toastView.padding(.bottom, compactFull ? 0 : 56) }
        .statusBarHidden(compactFull)
        .persistentSystemOverlays(compactFull ? .hidden : .automatic)
        // (My tutor's All settings page; on the root, so it opens from any tab)
        .sheet(isPresented: $model.sheetOpen) { TutorPageView(model: model) }
        .background(EmptyView().sheet(isPresented: $model.moreOpen) { WatchMoreSheet(model: model) })
        .background(translatorHost)
        .background(AppCovers(model: model))        // the reader and the browser, full screen
        .onOpenURL { model.openLink($0) }           // "Open this link in I Know": iknow://open?url=…
    }

    /// The Watch tab: YouTube itself (search, your account, any video), with My tutor inside the page. Under it: with a
    /// video open, the bar of the study buttons; with none, the one big "Paste a YouTube link".
    private var watchScreen: some View {
        ZStack(alignment: .trailing) {
            VStack(spacing: 0) {
                WebHost(webView: model.youtube)
                    .ignoresSafeArea(.container, edges: compactFull ? .all : [])
                if !hideBar {
                    if model.videoOpen { tutorBar } else { WatchStartPanel(model: model) }
                }
            }
            if hideBar { sideRail.padding(.trailing, 6) }
        }
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

    /// The bar under a video: only what is used all the time, one tap each. Left to right: the tutor's switch (a small
    /// dot, where you wanted it), play / stop, explain the last N seconds, explain the LAST sentence, call the tutor,
    /// and "More" (a sheet with the rest, two taps: the volume, the two switches of Video mode, full screen, find a
    /// video, voice, mode, One button, sleep, quick settings, paste link, YouTube home). Words and Settings are tabs.
    /// With the tutor off (no AI, nothing paid): its switch, the big "Tutor off", play / stop in free mode, and More.
    private var tutorBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: wide ? 8 : 2) {
                Button { model.dream("tutor") } label: {
                    Circle()
                        .fill(model.tutorOn ? Theme.on : Theme.off)
                        .frame(width: 16, height: 16)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(model.tutorOn ? "My tutor is on: turn it off (a normal YouTube page)" : "My tutor is off: turn it on")
                if model.tutorOn {
                    tutorButton("stop", "playpause.fill", "Play / stop", big: true)
                    tutorButton("explainLast", "text.bubble", "Explain \(model.explainSeconds) s", big: true)
                    tutorButton("explainSentence", "arrow.uturn.backward", "Last sentence", big: true)
                    tutorButton("talk", "phone.fill", "Call", big: true)
                } else {
                    // the tutor is off: a normal YouTube page, nothing of the tutor. One big button turns it on again.
                    Button { model.dream("tutor") } label: { barLabel("power", "Tutor off", big: true) }
                        .buttonStyle(.themeBar)
                        .accessibilityLabel("My tutor is off: turn it on")
                    if model.freeMode {
                        // (free mode, when Settings asks for it: the video stops at hard words, the card shows the dictionary, no AI)
                        tutorButton("stop", "playpause.fill", "Play / stop", big: true)
                    }
                }
                appButton("ellipsis.circle", "More") { model.moreOpen = true }
            }
            .padding(.horizontal, Theme.Space.xs + 2)
            .padding(.vertical, Theme.Space.xs)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.raised)
        .overlay(alignment: .top) { Theme.line.frame(height: 1) }
    }

    /// a button of the bar: a symbol with a word under it. `big`: the main ones (at least 60 pt wide and 48 high; an
    /// iPad: 88 x 56); the others at least 50 x 44
    private func barLabel(_ symbol: String, _ title: String, big: Bool = false) -> some View {
        VStack(spacing: 3) {
            Image(systemName: symbol).font(.system(size: big ? (wide ? 26 : 23) : (wide ? 20 : 18)))
            // (the one look: a bar's word is 12 pt at least, 13 for the main buttons)
            Text(title).font(.system(size: big ? (wide ? 15 : 13) : (wide ? 13 : 12), weight: big ? .semibold : .medium)).lineLimit(1).fixedSize()
        }
        .foregroundColor(Theme.text)
        .frame(minWidth: big ? (wide ? 88 : 64) : (wide ? 64 : 54), minHeight: big ? (wide ? 56 : Theme.Control.main) : Theme.Control.min)
        .contentShape(Rectangle())
    }

    /// one of My tutor's actions (window.__ytcDream.action in the page)
    private func tutorButton(_ action: String, _ symbol: String, _ title: String, big: Bool = false) -> some View {
        Button { model.dream(action) } label: { barLabel(symbol, title, big: big) }
            .buttonStyle(.themeBar)
            .accessibilityLabel(title)
    }

    /// one of the app's own buttons (they were the bar at the top)
    private func appButton(_ symbol: String, _ title: String, _ run: @escaping () -> Void) -> some View {
        Button(action: run) { barLabel(symbol, title) }
            .buttonStyle(.themeBar)
            .accessibilityLabel(title)
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
            railButton("ellipsis", "More buttons") { model.moreOpen = true }
        }
        .opacity(railDim ? 0.4 : 1)
        .onAppear { railTouch() }
    }

    private func railButton(_ symbol: String, _ title: String, _ run: @escaping () -> Void) -> some View {
        Button { railTouch(); run() } label: {
            Image(systemName: symbol).font(.system(size: 22, weight: .medium))
                .frame(width: 60, height: 60)
                .foregroundColor(Theme.text)
                .background(Theme.raised.opacity(0.92), in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
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
            // (the one look's toast: dark on a light iPhone, light on a dark one, like the web pages')
            Text(text)
                .font(Theme.footnote)
                .foregroundColor(Theme.bg)
                .padding(.horizontal, Theme.Space.l).padding(.vertical, Theme.Space.m - 2)
                .background(Theme.text, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
                .padding()
                .onTapGesture { model.toast = nil }
        }
    }
}

/// I Know Book's own settings sheet ("My word file, and more settings" on the book's Settings page): the word file
/// shared with the Mac, the old All settings page, the help. (Its keys are on the book's Settings page with the other
/// tutor settings, and My Vocabulary is its Words tab: one place for each.) I Know has the Settings tab instead (Tabs.swift).
struct SettingsView: View {
    @ObservedObject var model: AppModel
    @Environment(\.presentationMode) private var presentation

    var body: some View {
        NavigationView {
            Form {
                WordFileSection(model: model)
                Section(header: Text("My tutor")) {
                    Button("All settings (the full page)") { presentation.wrappedValue.dismiss(); model.openPage("ytlearn://app/dream/options.html") }
                        .frame(minHeight: 44)
                }
                .listRowBackground(Theme.raised)
                MicHelpSection()
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("More settings")
            .navigationBarItems(trailing: Button("Done") { presentation.wrappedValue.dismiss() }.font(Theme.button))
            .toolbarBackground(Theme.bg, for: .navigationBar)
        }
        .navigationViewStyle(.stack)
        .tint(Theme.accent)
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
                .background(Theme.bg)
                .navigationTitle("My tutor")
                .navigationBarTitleDisplayMode(.inline)
                .navigationBarItems(trailing: Button("Done") { model.sheetOpen = false }.font(Theme.button))
                .toolbarBackground(Theme.bg, for: .navigationBar)
                .toolbarBackground(.visible, for: .navigationBar)
        }
        .navigationViewStyle(.stack)
        .tint(Theme.accent)
    }
}
