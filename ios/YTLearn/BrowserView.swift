import SwiftUI
import WebKit

/// The browser's screen: the address / search bar on top, the page, and one bar of big buttons at the bottom:
/// back, forward, the Explanation mode switch, Explain (what is on the screen now) / Stop, the tabs, and "More"
/// (bookmarks, history, the reader, share, Safari). "Done" goes back to the video.
struct BrowserScreen: View {
    @ObservedObject var model: AppModel
    @ObservedObject var browser: BrowserModel
    @State private var typed = ""
    @State private var editing = false
    @State private var list: BrowserList?
    @State private var sharing: ShareItem?
    @State private var promptText = ""
    @FocusState private var addressFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            if let tab = browser.current {
                BrowserTop(model: model, browser: browser, tab: tab, typed: $typed, editing: $editing, addressFocused: $addressFocused)
                if let note = browser.note {
                    Text(note).font(.footnote).foregroundColor(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.vertical, 6)
                        .background(Color(.tertiarySystemBackground))
                        .onTapGesture { browser.note = nil }
                }
                BrowserPageArea(browser: browser, tab: tab)
                BrowserBar(browser: browser, tab: tab, list: $list, sharing: $sharing)
            }
        }
        .onAppear {
            model.coverOpened()
            browser.setShown(true)
        }
        .onDisappear {
            browser.setShown(false)
            model.coverClosed()
        }
        .sheet(item: $list) { which in BrowserListView(browser: browser, which: which) }
        .background(Color.clear.sheet(item: $sharing) { item in ShareSheet(items: [item.url]) })
        .alert(browser.ask?.title ?? "", isPresented: Binding(get: { browser.ask != nil }, set: { on in
            // (a button's own answer comes first; this is only for an alert that went away by itself)
            let id = browser.ask?.id
            if !on { DispatchQueue.main.async { if browser.ask?.id == id { browser.answer(false) } } }
        }), presenting: browser.ask) { q in
            switch q.kind {
            case .alert:
                Button("OK") { browser.answer(true) }
            case .confirm:
                Button("OK") { browser.answer(true) }
                Button("Cancel", role: .cancel) { browser.answer(false) }
            case .prompt:
                TextField("", text: $promptText)
                Button("OK") { browser.answer(true, promptText) }
                Button("Cancel", role: .cancel) { browser.answer(false) }
            case .openApp:
                Button("Open") { browser.answer(true) }
                Button("Cancel", role: .cancel) { browser.answer(false) }
            }
        } message: { q in
            Text(q.message)
        }
        .onChange(of: browser.ask?.id) { _ in promptText = browser.ask?.preset ?? "" }
    }
}

enum BrowserList: String, Identifiable {
    case tabs, bookmarks, history
    var id: String { rawValue }
}

struct ShareItem: Identifiable {
    let id = UUID()
    let url: URL
}

/// the top row: Done, the address / search field, reload or stop; the thin progress line under it
private struct BrowserTop: View {
    @ObservedObject var model: AppModel
    @ObservedObject var browser: BrowserModel
    @ObservedObject var tab: BrowserTab
    @Binding var typed: String
    @Binding var editing: Bool
    var addressFocused: FocusState<Bool>.Binding

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Button { model.showBrowser = false } label: {
                    Text("Done").font(.system(size: 16, weight: .semibold)).frame(minWidth: 54, minHeight: 44).contentShape(Rectangle())
                }
                .accessibilityLabel("Done: back to the video")
                TextField("Search or type an address", text: Binding(get: { editing ? typed : BrowserModel.short(tab.address) }, set: { typed = $0 }))
                    .focused(addressFocused)
                    .keyboardType(.webSearch)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled(true)
                    .submitLabel(.go)
                    .font(.system(size: 17))
                    .padding(.horizontal, 12)
                    .frame(minHeight: 44)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Color(.tertiarySystemFill)))
                    .onSubmit {
                        let text = typed
                        editing = false
                        addressFocused.wrappedValue = false
                        browser.go(text)
                    }
                    .onChange(of: addressFocused.wrappedValue) { on in
                        // (the whole address shows while it is edited)
                        if on { typed = tab.address; editing = true } else { editing = false }
                    }
                Button { browser.reloadOrStop() } label: {
                    Image(systemName: tab.loading ? "xmark" : "arrow.clockwise").font(.system(size: 18, weight: .medium)).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                .accessibilityLabel(tab.loading ? "Stop loading" : "Reload")
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            ProgressView(value: min(1, max(0, tab.progress)))
                .progressViewStyle(.linear)
                .frame(height: 2)
                .opacity(tab.loading ? 1 : 0)
        }
        .background(Color(.secondarySystemBackground))
    }
}

/// the page itself; an empty tab shows the start page; a page that could not load shows why, with Reload
private struct BrowserPageArea: View {
    @ObservedObject var browser: BrowserModel
    @ObservedObject var tab: BrowserTab

    var body: some View {
        ZStack {
            WebHost(webView: tab.web).id(tab.id)
            if tab.isEmpty && tab.problem == nil { startPage }
            if let problem = tab.problem { problemPage(problem) }
        }
    }

    private var startPage: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Browser").font(.largeTitle.bold())
                Text("Type an address or what you look for in the bar at the top. Turn the tutor on at the bottom: then a tap on a word explains it.")
                    .foregroundColor(.secondary)
                Button { browser.pasteLink() } label: {
                    Label("Paste link", systemImage: "doc.on.clipboard").font(.system(size: 18, weight: .semibold))
                        .frame(maxWidth: .infinity, minHeight: 60)
                        .background(RoundedRectangle(cornerRadius: 14).fill(Color.accentColor.opacity(0.15)))
                }
                if !browser.bookmarks.isEmpty {
                    Text("Bookmarks").font(.headline).padding(.top, 8)
                    ForEach(browser.bookmarks.prefix(12)) { page in
                        Button { browser.go(page.url) } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(page.name).font(.system(size: 17)).lineLimit(1)
                                Text(BrowserModel.short(page.url)).font(.footnote).foregroundColor(.secondary).lineLimit(1)
                            }
                            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(20)
            .frame(maxWidth: 640)
            .frame(maxWidth: .infinity)
        }
        .background(Color(.systemBackground))
    }

    private func problemPage(_ text: String) -> some View {
        VStack(spacing: 16) {
            Text("This page did not open").font(.title2.bold())
            Text(text).multilineTextAlignment(.center).foregroundColor(.secondary)
            Button { browser.reloadOrStop() } label: {
                Label("Reload", systemImage: "arrow.clockwise").font(.system(size: 18, weight: .semibold))
                    .frame(minWidth: 180, minHeight: 60)
                    .background(RoundedRectangle(cornerRadius: 14).fill(Color.accentColor.opacity(0.15)))
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
    }
}

/// the bottom bar: every button at least 44 pt, the two study buttons (the mode switch, Explain / Stop) at least 60 pt
private struct BrowserBar: View {
    @ObservedObject var browser: BrowserModel
    @ObservedObject var tab: BrowserTab
    @Binding var list: BrowserList?
    @Binding var sharing: ShareItem?

    var body: some View {
        HStack(spacing: 2) {
            small("chevron.left", "Back", enabled: tab.canGoBack) { browser.back() }
            small("chevron.right", "Forward", enabled: tab.canGoForward) { browser.forward() }
            Spacer(minLength: 0)
            // Explanation mode: ONE button. On = a tap on a word explains it. Off = a normal browser.
            Button { browser.setExplain(!browser.explainOn) } label: {
                big(browser.explainOn ? "graduationcap.fill" : "graduationcap", browser.explainOn ? "Tutor on" : "Tutor off")
                    .foregroundColor(browser.explainOn ? .white : .primary)
                    .background(RoundedRectangle(cornerRadius: 12).fill(browser.explainOn ? Color(red: 0.12, green: 0.56, blue: 0.24) : Color(.tertiarySystemFill)))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(browser.explainOn ? "Explanation mode is on: turn it off" : "Explanation mode is off: turn it on")
            // Explain what is on the screen now; while the tutor talks: Stop
            Button { browser.explainOrStop() } label: {
                big(browser.speaking ? "stop.fill" : "text.bubble", browser.speaking ? "Stop" : "Explain")
                    .background(RoundedRectangle(cornerRadius: 12).fill(browser.speaking ? Color(red: 0.85, green: 0.19, blue: 0.15).opacity(0.2) : Color(.tertiarySystemFill)))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(browser.speaking ? "Stop the tutor" : "Explain what is on the screen")
            Spacer(minLength: 0)
            Button { list = .tabs } label: {
                ZStack {
                    Image(systemName: "square").font(.system(size: 24, weight: .regular))
                    Text("\(browser.tabs.count)").font(.system(size: 12, weight: .semibold))
                }
                .frame(minWidth: 48, minHeight: 48).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Tabs: \(browser.tabs.count) open")
            Menu {
                Button { browser.newTab() } label: { Label("New tab", systemImage: "plus") }
                Button { browser.toggleBookmark() } label: { Label(browser.isBookmarked ? "Remove bookmark" : "Add bookmark", systemImage: browser.isBookmarked ? "star.fill" : "star") }
                Button { list = .bookmarks } label: { Label("Bookmarks", systemImage: "book") }
                Button { list = .history } label: { Label("History", systemImage: "clock") }
                Button { browser.openInReader() } label: { Label("Reader: read this page as a book", systemImage: "doc.plaintext") }
                Button { if let url = URL(string: tab.address) { sharing = ShareItem(url: url) } } label: { Label("Share", systemImage: "square.and.arrow.up") }
                Button { browser.openInSafari() } label: { Label("Open in Safari", systemImage: "safari") }
            } label: {
                Image(systemName: "ellipsis.circle").font(.system(size: 24)).frame(minWidth: 48, minHeight: 48).contentShape(Rectangle())
            }
            .accessibilityLabel("More: bookmarks, history, reader, share")
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .background(Color(.secondarySystemBackground))
    }

    private func small(_ symbol: String, _ title: String, enabled: Bool, _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            Image(systemName: symbol).font(.system(size: 22, weight: .medium)).frame(minWidth: 48, minHeight: 48).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.35)
        .accessibilityLabel(title)
    }

    private func big(_ symbol: String, _ title: String) -> some View {
        VStack(spacing: 3) {
            Image(systemName: symbol).font(.system(size: 22))
            Text(title).font(.system(size: 12, weight: .semibold)).lineLimit(1).fixedSize()
        }
        .frame(minWidth: 84, minHeight: 60)
        .contentShape(Rectangle())
    }
}

/// the lists in a sheet: the open tabs, the bookmarks, the history
struct BrowserListView: View {
    @ObservedObject var browser: BrowserModel
    let which: BrowserList
    @Environment(\.presentationMode) private var presentation

    var body: some View {
        NavigationView {
            List {
                switch which {
                case .tabs:
                    ForEach(browser.tabs) { tab in
                        HStack(spacing: 8) {
                            Button { browser.select(tab); presentation.wrappedValue.dismiss() } label: { row(tab.name, BrowserModel.short(tab.address), bold: tab.id == browser.currentID) }
                                .buttonStyle(.plain)
                            Button { browser.close(tab) } label: {
                                Image(systemName: "xmark.circle.fill").font(.system(size: 24)).foregroundColor(.secondary).frame(minWidth: 48, minHeight: 48).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Close this tab")
                        }
                    }
                    Button { browser.newTab(); presentation.wrappedValue.dismiss() } label: { Label("New tab", systemImage: "plus").frame(minHeight: 48) }
                case .bookmarks:
                    if browser.bookmarks.isEmpty { Text("No bookmarks yet. Open a page, then More ▸ Add bookmark.").foregroundColor(.secondary) }
                    ForEach(browser.bookmarks) { page in
                        HStack(spacing: 8) {
                            Button { browser.go(page.url); presentation.wrappedValue.dismiss() } label: { row(page.name, BrowserModel.short(page.url), bold: false) }
                                .buttonStyle(.plain)
                            Button { browser.removeBookmark(page) } label: {
                                Image(systemName: "trash").font(.system(size: 20)).foregroundColor(.red).frame(minWidth: 48, minHeight: 48).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Remove this bookmark")
                        }
                    }
                case .history:
                    if browser.history.isEmpty { Text("Nothing yet.").foregroundColor(.secondary) }
                    else { Button("Clear history", role: .destructive) { browser.clearHistory() }.frame(minHeight: 48) }
                    ForEach(browser.history) { page in
                        Button { browser.go(page.url); presentation.wrappedValue.dismiss() } label: { row(page.name, BrowserModel.short(page.url), bold: false) }
                            .buttonStyle(.plain)
                    }
                }
            }
            .navigationTitle(which == .tabs ? "Tabs" : which == .bookmarks ? "Bookmarks" : "History")
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarItems(trailing: Button("Done") { presentation.wrappedValue.dismiss() })
        }
        .navigationViewStyle(.stack)
    }

    private func row(_ title: String, _ sub: String, bold: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.system(size: 17, weight: bold ? .semibold : .regular)).lineLimit(1)
            if !sub.isEmpty { Text(sub).font(.footnote).foregroundColor(.secondary).lineLimit(1) }
        }
        .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
        .contentShape(Rectangle())
    }
}

/// the system's share sheet
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: items, applicationActivities: nil) }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
