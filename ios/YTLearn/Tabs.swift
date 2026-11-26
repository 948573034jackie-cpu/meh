import SwiftUI
import WebKit
import UniformTypeIdentifiers

/// I Know's three tabs at the bottom (at most three: Watch · Words · Settings). I Know Book draws the same bar in its
/// own page (book.html: Books · Words · Settings), with the same look.
enum AppTab: String, CaseIterable {
    case watch, words, settings
}

/// The tab bar: three equal buttons, a symbol and a word; the open tab in the accent colour (its symbol filled).
/// A tap on the open tab again: `again` (Watch again = YouTube's home page).
struct AppTabBar: View {
    @Binding var tab: AppTab
    var again: (AppTab) -> Void = { _ in }
    private let items: [(AppTab, String, String)] = [(.watch, "play.rectangle", "Watch"), (.words, "character.book.closed", "Words"), (.settings, "gearshape", "Settings")]

    var body: some View {
        HStack(spacing: 0) {
            ForEach(items, id: \.0) { item in
                let on = tab == item.0
                Button { if on { again(item.0) } else { tab = item.0 } } label: {
                    VStack(spacing: 3) {
                        Image(systemName: on ? item.1 + ".fill" : item.1).font(.system(size: 22, weight: .medium))
                        Text(item.2).font(Theme.caption)
                    }
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .foregroundColor(on ? Theme.accent : Theme.muted)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.themeBar)
                .accessibilityLabel(item.2)
                .accessibilityAddTraits(on ? [.isSelected] : [])
            }
        }
        .padding(.top, 2)
        .background(Theme.raised.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { Theme.line.frame(height: 1) }
    }
}

/// The Watch tab with no video open: ONE clear main action (paste the YouTube link you copied) and one quieter one
/// (find a video). YouTube itself stays above it (its search, its home page).
struct WatchStartPanel: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(spacing: Theme.Space.xs) {
            Button { model.pasteLink() } label: {
                Label("Paste a YouTube link", systemImage: "link").frame(maxWidth: .infinity)
            }
            .buttonStyle(ThemeButtonStyle(kind: .primary, main: true))
            .accessibilityHint("Opens the YouTube link you copied")
            Button { model.dream("find") } label: {
                Label("Find a video", systemImage: "magnifyingglass").frame(maxWidth: .infinity)
            }
            .buttonStyle(ThemeButtonStyle(kind: .quiet))
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.top, Theme.Space.m)
        .padding(.bottom, Theme.Space.xs)
        .background(Theme.raised)
        .overlay(alignment: .top) { Theme.line.frame(height: 1) }
    }
}

/// The Watch bar's "More": everything of the old long bar that is not used every minute, two taps away
/// (nothing is gone: the same actions as before, in a sheet).
struct WatchMoreSheet: View {
    @ObservedObject var model: AppModel

    private struct Item: Identifiable {
        let id: String
        let symbol: String
        let title: String
        let run: (AppModel) -> Void
    }

    private var items: [Item] {
        var list: [Item] = []
        let full = Item(id: "full", symbol: model.pageFull ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right", title: model.pageFull ? "Leave full screen" : "Full screen") { $0.fullScreen() }
        let video = model.videoMode ? [
            Item(id: "band", symbol: "captions.bubble", title: model.bandOn ? "Subtitles on" : "Subtitles off") { $0.dream("band") },
            Item(id: "pageAuto", symbol: "doc.text", title: model.pageOn ? "Page on" : "Page off") { $0.dream("pageAuto") },
        ] : []
        let find = Item(id: "find", symbol: "magnifyingglass", title: "Find video") { $0.dream("find") }
        let mode = Item(id: "mode", symbol: "book", title: "Mode") { $0.dream("mode") }
        let quick = Item(id: "quick", symbol: "slider.horizontal.3", title: "Quick settings") { $0.dream("quick") }
        let paste = Item(id: "paste", symbol: "link", title: "Paste link") { $0.pasteLink() }
        let home = Item(id: "home", symbol: "house", title: "YouTube home") { $0.goHome() }
        if model.tutorOn {
            list += video
            list += [full, find,
                     Item(id: "voiceMode", symbol: "mic", title: "Voice") { $0.dream("voiceMode") },
                     mode,
                     Item(id: "oneButton", symbol: model.oneButton ? "circle.inset.filled" : "circle", title: model.oneButton ? "One button on" : "One button") { $0.dream("oneButton") },
                     Item(id: "sleep", symbol: "moon.zzz", title: "Sleep") { $0.dream("sleep") },
                     quick, paste, home]
        } else if model.freeMode {
            list += video
            list += [full, mode, find, quick, paste, home]
        } else {
            list += [paste, find, home]
        }
        return list
    }

    /// the tutor's volume, quieter / louder: two big buttons (60 pt), as the old volume panel (one tap each, the sheet stays)
    private var volumeRow: some View {
        HStack(spacing: Theme.Space.m) {
            Button { model.dream("quieter") } label: {
                Image(systemName: "minus").font(.system(size: 26, weight: .bold)).frame(width: 64, height: 60).contentShape(Rectangle())
            }
            .accessibilityLabel("Tutor quieter")
            VStack(spacing: 2) {
                Text("Tutor volume").font(Theme.caption).foregroundColor(Theme.muted)
                Text("\(model.tutorVolume)%").font(Theme.title).monospacedDigit().foregroundColor(Theme.text)
            }
            .frame(maxWidth: .infinity)
            Button { model.dream("louder") } label: {
                Image(systemName: "plus").font(.system(size: 26, weight: .bold)).frame(width: 64, height: 60).contentShape(Rectangle())
            }
            .accessibilityLabel("Tutor louder")
        }
        .buttonStyle(.themeBar)
        .padding(.horizontal, Theme.Space.s)
        .background(Theme.raised, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous).stroke(Theme.line, lineWidth: 1))
    }

    var body: some View {
        NavigationView {
            ScrollView {
                if model.tutorOn || model.freeMode { volumeRow.padding([.horizontal, .top], Theme.Space.l) }
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: Theme.Space.s), count: 3), spacing: Theme.Space.s) {
                    ForEach(items) { item in
                        Button {
                            model.moreOpen = false
                            // (the sheet goes first: what the action shows comes on the page, not under the sheet)
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { item.run(model) }
                        } label: {
                            VStack(spacing: 6) {
                                Image(systemName: item.symbol).font(.system(size: 22, weight: .medium))
                                Text(item.title).font(Theme.caption).multilineTextAlignment(.center).lineLimit(2).minimumScaleFactor(0.9)
                            }
                            .foregroundColor(Theme.text)
                            .frame(maxWidth: .infinity, minHeight: 78)
                            .background(Theme.raised, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous).stroke(Theme.line, lineWidth: 1))
                        }
                        .buttonStyle(.themeBar)
                        .accessibilityLabel(item.title)
                    }
                }
                .padding(Theme.Space.l)
            }
            .background(Theme.bg)
            .navigationTitle("More")
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarItems(trailing: Button("Done") { model.moreOpen = false }.font(Theme.button))
            .toolbarBackground(Theme.bg, for: .navigationBar)
        }
        .navigationViewStyle(.stack)
        .tint(Theme.accent)
        .presentationDetents([.medium, .large])
    }
}

/// The Words tab: My Vocabulary (vocab.html), the same page as before, now one tap away.
struct WordsScreen: View {
    @ObservedObject var model: AppModel

    var body: some View {
        WebHost(webView: model.wordsView())
            .background(Theme.bg.ignoresSafeArea())
            .onAppear { model.showWords() }
    }
}

/// A row of choices in the one look (as the web pages' option buttons): each 44 pt high, the chosen one in the accent.
struct ThemeChoices<T: Hashable>: View {
    let options: [(T, String)]
    let chosen: T
    let pick: (T) -> Void

    var body: some View {
        HStack(spacing: Theme.Space.xs) {
            ForEach(options, id: \.0) { option in
                let on = option.0 == chosen
                Button { pick(option.0) } label: {
                    Text(option.1).font(Theme.button).lineLimit(1).minimumScaleFactor(0.8)
                        .frame(maxWidth: .infinity, minHeight: Theme.Control.min)
                        .foregroundColor(on ? Theme.accent : Theme.muted)
                        .background(on ? Theme.accentSoft : Theme.raised, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous).stroke(on ? Theme.accent : Theme.lineStrong, lineWidth: 1))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(option.1)
                .accessibilityAddTraits(on ? [.isSelected] : [])
            }
        }
        .padding(.vertical, 2)
    }
}

/// The API keys, typed in the app (an empty box keeps the saved key): the same boxes as the old App settings sheet.
struct KeysSection: View {
    @ObservedObject var model: AppModel
    @State private var keyText: [String: String] = [:]
    @State private var keyEnds: [String: String] = [:]
    @State private var region = ""
    @State private var keyNote = ""
    static let rows: [(String, String)] = [("azure", "Microsoft voice (Azure Speech, KEY 1)"), ("anthropic", "Claude"), ("openai", "OpenAI"), ("elevenlabs", "ElevenLabs"), ("github", "GitHub token")]

    private func keyField(_ name: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(Theme.footnote).foregroundColor(Theme.muted)
            SecureField(keyEnds[name].map { "saved (…\($0)): paste a new one to change it" } ?? "paste your key", text: Binding(get: { keyText[name] ?? "" }, set: { keyText[name] = $0 }))
                .textContentType(.oneTimeCode)   // (no "save this password?" question, no strong-password offer)
                .autocapitalization(.none)
                .disableAutocorrection(true)
                .frame(minHeight: 44)
        }
    }

    var body: some View {
        Section(header: Text("API keys"),
                footer: Text("Paste a key, then press Save the keys. An empty box keeps the key that is saved. Keys stay on this device (its Keychain). Claude explains; the Microsoft key (free) gives the natural voice. Test finds the Microsoft region by itself. (The Speechify app code is with the voice: Voice ▸ Speechify.)")) {
            ForEach(KeysSection.rows, id: \.0) { row in keyField(row.0, row.1) }
            VStack(alignment: .leading, spacing: 4) {
                Text("Microsoft region").font(Theme.footnote).foregroundColor(Theme.muted)
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
            if !keyNote.isEmpty { Text(keyNote).font(Theme.footnote) }
        }
        .listRowBackground(Theme.raised)
        .onAppear { keyEnds = model.savedKeyEnds(); region = model.savedRegion }
    }
}

/// The word file shared with the Mac (iCloud Drive or Google Drive): the same three buttons as before.
struct WordFileSection: View {
    @ObservedObject var model: AppModel
    @State private var pickFolder = false
    @State private var pickFile = false

    var body: some View {
        Section(header: Text("My word file (one for the Mac and this phone)"),
                footer: Text("On the Mac, Chrome saves vocabulary.json in Documents ▸ MEH English, in iCloud Drive ▸ MEH English, and in Google Drive ▸ MEH English (when Google Drive is installed). iCloud Drive: choose that MEH English folder. Google Drive (the Files app does not let its folders be chosen): choose the file vocabulary.json inside it. The Mac and this phone then share one database: each adds its words, nothing is lost. Without that the words stay in the app (Files ▸ On My iPhone ▸ I Know ▸ vocabulary.json).")) {
            Text(model.vocabFolder.map { "Shared: \($0)" } ?? "Nothing shared yet: the words stay in the app")
            if !model.vocabStatus.isEmpty {
                Text(model.vocabStatus).font(Theme.footnote).foregroundColor(Theme.muted)
            }
            Button("Choose the folder (iCloud Drive ▸ MEH English)…") { pickFolder = true }
                .frame(minHeight: 44)
            Button("Or choose the file vocabulary.json (Google Drive)…") { pickFile = true }
                .frame(minHeight: 44)
            if model.vocabFolder != nil {
                Button("Stop sharing (keep the words in the app)", role: .destructive) { model.forgetVocabFolder() }
                    .foregroundColor(Theme.off)
                    .frame(minHeight: 44)
            }
        }
        .listRowBackground(Theme.raised)
        .sheet(isPresented: $pickFolder) { FolderPicker(types: [UTType.folder]) { url in model.chooseVocabFolder(url) } }
        .background(EmptyView().sheet(isPresented: $pickFile) { FolderPicker(types: [UTType.json]) { url in model.chooseVocabFolder(url, isFile: true) } })
    }
}

/// the help text of the old App settings sheet (Microphone and voice)
struct MicHelpSection: View {
    var body: some View {
        Section(header: Text("Microphone and voice"), footer: Text("Allow the Microphone and Speech Recognition when iOS asks: the tutor listens only while it waits for you (I know / I don't know, a question, a call, voice mode). Better voices: iOS Settings ▸ Accessibility ▸ Spoken Content ▸ Voices ▸ English ▸ download a Premium or Enhanced voice.")) {
            EmptyView()
        }
        .listRowBackground(Theme.raised)
    }
}

/// The tutor's own settings pages (settings.html, the same rows as the tutor's quick settings on the video, but open
/// without a video): "tutor" = volume, text size, what to explain, the card, the look, the mode and all of Advanced;
/// "voice" = the voice choice (Speechify too), its voice list, the Speechify rows, Test.
struct TutorSettingsScreen: View {
    @ObservedObject var model: AppModel
    let part: String
    let title: String

    var body: some View {
        WebHost(webView: model.prefsView())
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .onAppear { model.showPrefs(part) }
    }
}

/// I Know's Settings tab: ONE place for what was in four (the App settings sheet, the All settings page, the tutor's
/// quick settings, the browser's More). The most used first: My tutor, My level, the voice, "Explain the last";
/// then the keys and the word file; the rare rest under "More settings". Each setting is in one row only.
struct SettingsTab: View {
    @ObservedObject var model: AppModel
    private let levels = ["A1", "A2", "B1", "B2", "C1", "C2"].map { ($0, $0) }

    /// a number of My tutor's extras as a slider (saved when the finger lets go)
    private func sliderRow(_ title: String, key: String, fallback: Double, range: ClosedRange<Double>, step: Double, unit: String, save: @escaping (Int) -> Void) -> some View {
        SettingsSlider(title: title, value: (model.extrasNow[key] as? NSNumber)?.doubleValue ?? fallback, range: range, step: step, unit: unit, save: save)
    }

    /// one kind the tutor explains by itself: on / off, and how much (%)
    @ViewBuilder
    private func kindRows(_ title: String, on key: String, pct: String) -> some View {
        let isOn = model.extrasNow[key] as? Bool ?? true
        let all = (model.extrasNow["explainPct"] as? NSNumber)?.doubleValue ?? 100
        HStack {
            Text(title).font(Theme.body).foregroundColor(Theme.text)
            Spacer()
            ThemeChoices(options: [(true, "On"), (false, "Off")], chosen: isOn) { model.setExtras([key: $0]) }
                .frame(maxWidth: 150)
        }
        SettingsSlider(title: "How much", value: (model.extrasNow[pct] as? NSNumber)?.doubleValue ?? all, range: 0...100, step: 5, unit: "%") { model.setExtras([pct: max(0, min(100, $0))]) }
            .disabled(!isOn)
            .opacity(isOn ? 1 : 0.45)
    }

    private func linkRow(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(Theme.body).foregroundColor(Theme.text)
            Text(detail).font(Theme.footnote).foregroundColor(Theme.muted)
        }
        .frame(minHeight: 44)
    }

    var body: some View {
        NavigationView {
            List {
                Section(header: Text("My tutor")) {
                    sliderRow("Tutor volume", key: "teacherVolume", fallback: 60, range: 0...100, step: 1, unit: "%") { model.setExtras(["teacherVolume": $0, "wordVolume": $0]) }
                    sliderRow("Text size", key: "phoneSizePx", fallback: 21, range: 17...42, step: 1, unit: " px") { model.setExtras(["phoneSizePx": $0]) }
                    NavigationLink(destination: TutorSettingsScreen(model: model, part: "tutor", title: "My tutor")) {
                        linkRow("Tutor settings", "The card, the look, the mode, and everything else (Advanced)")
                    }
                }
                .listRowBackground(Theme.raised)
                Section(header: Text("My level"), footer: Text("Nothing below your level is explained by itself, and nothing you know.")) {
                    ThemeChoices(options: levels, chosen: model.learnerLevel) { model.setLevel($0) }
                }
                .listRowBackground(Theme.raised)
                Section(header: Text("What to explain"), footer: Text("For each kind: on or off, and how much: 100 % = everything at your level or above, a low number = only the hardest, 0 = nothing. A tap on any word still explains it.")) {
                    kindRows("Words", on: "stopItemsOn", pct: "pctWords")
                    kindRows("Phrases", on: "stopPhrasesOn", pct: "pctPhrases")
                    kindRows("Sentences", on: "stopHardOn", pct: "pctSentences")
                }
                .listRowBackground(Theme.raised)
                Section(header: Text("Voice")) {
                    NavigationLink(destination: TutorSettingsScreen(model: model, part: "voice", title: "Voice")) {
                        linkRow("Tutor's voice: \(model.voiceChoiceName)", "Speechify (natural), Microsoft, OpenAI, ElevenLabs or the iPhone voice; Test")
                    }
                }
                .listRowBackground(Theme.raised)
                Section(header: Text("Explain the last"), footer: Text("The Explain button, “hello” and One button explain this much of the video.")) {
                    ThemeChoices(options: [(10, "10 s"), (20, "20 s"), (30, "30 s")], chosen: model.explainSeconds) { model.setExplainSeconds($0) }
                }
                .listRowBackground(Theme.raised)
                KeysSection(model: model)
                WordFileSection(model: model)
                Section {
                    NavigationLink(destination: MoreSettingsScreen(model: model)) {
                        linkRow("More settings", "All settings, Check the app, Read a book or text, Browser, Help")
                    }
                }
                .listRowBackground(Theme.raised)
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("Settings")
            .toolbarBackground(Theme.bg, for: .navigationBar)
        }
        .navigationViewStyle(.stack)
        .tint(Theme.accent)
    }
}

/// A slider of the Settings tab: the title, the number, the slider (44 pt); saved when the finger lets go
struct SettingsSlider: View {
    let title: String
    let value: Double
    let range: ClosedRange<Double>
    let step: Double
    let unit: String
    let save: (Int) -> Void
    @State private var now: Double? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(title).font(Theme.body).foregroundColor(Theme.text)
                Spacer()
                Text("\(Int((now ?? value).rounded()))\(unit)").font(Theme.footnote).monospacedDigit().foregroundColor(Theme.muted)
            }
            Slider(value: Binding(get: { now ?? value }, set: { now = $0 }), in: range, step: step) { editing in
                if !editing, let v = now { save(Int(v.rounded())); DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { now = nil } }
            }
            .frame(minHeight: 44)
            .accessibilityLabel(title)
        }
    }
}

/// The rare things, two taps from Settings: the old All settings page (it was made for Chrome on the Mac), the
/// self-test, the reader, the browser, the help.
struct MoreSettingsScreen: View {
    @ObservedObject var model: AppModel

    private func row(_ symbol: String, _ title: String, _ detail: String, _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            HStack(spacing: Theme.Space.m) {
                Image(systemName: symbol).font(.system(size: 20)).foregroundColor(Theme.accent).frame(width: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(Theme.body).foregroundColor(Theme.text)
                    Text(detail).font(Theme.footnote).foregroundColor(Theme.muted)
                }
            }
            .frame(minHeight: 44)
        }
    }

    var body: some View {
        List {
            Section {
                row("slider.horizontal.3", "All settings (the full page)", "Every setting of My tutor on one long page") { model.openPage("ytlearn://app/dream/options.html") }
                row("stethoscope", "Check the app", "The self-test report (for problems)") { model.tab = .watch; DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { model.dream("check") } }
                row("book", "Read a book or text", "The reader (EPUB, PDF, text)") { model.showReader = true }
                row("safari", "Browser", "Any web page, with Explanation mode") { model.showBrowser = true }
            }
            .listRowBackground(Theme.raised)
            MicHelpSection()
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg)
        .navigationTitle("More settings")
        .navigationBarTitleDisplayMode(.inline)
    }
}

extension AppModel {
    /// = CEFR_START of dream-ext/src/level100.ts (the number the tutor uses for each school level; a test compares them)
    static let levelStart: [String: Int] = ["A1": 4, "A2": 18, "B1": 34, "B2": 50, "C1": 66, "C2": 84]

    /// My level in the tutor's saved settings (B2 when not set yet, as the tutor's own default)
    static func level(in settings: Any?) -> String {
        let l = (settings as? [String: Any])?["learnerLevel"] as? String ?? "B2"
        return levelStart[l] != nil ? l : "B2"
    }

    /// My level chosen on the Settings tab: the same as the tutor's own "My level" buttons (the school level, its
    /// number, the automatic level off)
    func setLevel(_ level: String) {
        guard let start = AppModel.levelStart[level] else { return }
        var s = Store.shared.value(area: "local", key: "drSettings") as? [String: Any] ?? [:]
        s["learnerLevel"] = level
        var x = Store.shared.value(area: "local", key: "drExtras") as? [String: Any] ?? [:]
        x["myLevel"] = start
        x["levelAuto"] = false
        storageSet(area: "local", json: AppModel.jsonString(["drSettings": s, "drExtras": x]), from: nil)
    }

    /// some of My tutor's extras changed on the Settings tab (merged into the saved ones; every window follows)
    func setExtras(_ patch: [String: Any]) {
        var x = Store.shared.value(area: "local", key: "drExtras") as? [String: Any] ?? [:]
        for (k, v) in patch { x[k] = v }
        storageSet(area: "local", json: AppModel.jsonString(["drExtras": x]), from: nil)
    }

    /// "Explain the last 10 / 20 / 30 s" (drSettings.listen.lastSecondsWindow, as the tutor's own buttons)
    func setExplainSeconds(_ seconds: Int) {
        var s = Store.shared.value(area: "local", key: "drSettings") as? [String: Any] ?? [:]
        var listen = s["listen"] as? [String: Any] ?? [:]
        listen["lastSecondsWindow"] = seconds
        s["listen"] = listen
        storageSet(area: "local", json: AppModel.jsonString(["drSettings": s]), from: nil)
    }

    /// the voice choice in words (the Settings tab's Voice row)
    var voiceChoiceName: String {
        switch voiceChoice {
        case "azure": return "Microsoft"
        case "openai": return "OpenAI"
        case "elevenlabs": return "ElevenLabs"
        case "speechify": return "Speechify"
        case "mac": return "iPhone"
        default: return "Auto"
        }
    }

    /// an app page's web view (the same scripts and bridge as the settings sheet: the same store, keys and voices)
    private func pageConfig() -> WKWebViewConfiguration {
        let bridge = Bridge(world: .page)
        bridge.model = self
        return AppModel.makeSheetConfig(bridge: bridge)
    }

    /// the Words tab's page (made once; it learns every change of the words like the other windows)
    func wordsView() -> WKWebView {
        if let w = wordsWeb { return w }
        let w = WKWebView(frame: .zero, configuration: pageConfig())
        w.navigationDelegate = self
        wordsWeb = w
        return w
    }

    /// the Words tab is shown: My Vocabulary (again when another page was opened in it)
    func showWords() {
        let w = wordsView()
        if w.url?.path.hasSuffix("/vocab.html") != true, let url = URL(string: "ytlearn://app/dream/vocab.html") { w.load(URLRequest(url: url)) }
    }

    /// the Settings tab's web page of the tutor's settings (made once)
    func prefsView() -> WKWebView {
        if let w = prefsWeb { return w }
        let w = WKWebView(frame: .zero, configuration: pageConfig())
        w.navigationDelegate = self
        prefsWeb = w
        return w
    }

    /// shows one part of the tutor's settings page ("tutor" or "voice")
    func showPrefs(_ part: String) {
        let w = prefsView()
        if w.url?.path.hasSuffix("/settings.html") == true {
            w.evaluateJavaScript("window.__drSettings && window.__drSettings.show(\(AppModel.jsonString(part))); 0", in: nil, in: .page, completionHandler: nil)
        } else if let url = URL(string: "ytlearn://app/dream/settings.html#\(part)") {
            w.load(URLRequest(url: url))
        }
    }

    /// another tab is shown: leaving Watch, the video and the tutor go quiet (as for the reader and the browser);
    /// back at Watch, the tutor's microphone may open again
    func tabChanged(from old: AppTab) {
        if old == .watch { coverOpened() }
        if tab == .watch { coverClosed() }
    }
}
