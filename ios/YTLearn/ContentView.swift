import SwiftUI

struct ContentView: View {
    @StateObject private var model = AppModel()
    @State private var showSettings = false

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            GeometryReader { geo in
                panes(in: geo.size)
            }
        }
        .onAppear { model.start() }
        .overlay(alignment: .bottom) { toastView }
        .sheet(isPresented: $showSettings) { SettingsView(model: model) }
    }

    private var toolbar: some View {
        HStack(spacing: 10) {
            // green = on (the full transcript goes once, then every pause), red = off (plain YouTube)
            chatToggle("chatgpt", "ChatGPT")
            chatToggle("claude", "Claude")

            Spacer(minLength: 0)

            // the one big button: tap, say your question, and hear the answer
            Button { model.micTapped() } label: {
                Label(model.listening ? "Send" : "Ask",
                      systemImage: model.listening ? "waveform" : "mic.fill")
                    .font(.subheadline.weight(.semibold))
            }
            .buttonStyle(.borderedProminent)
            .tint(model.listening ? .red : .blue)

            Button { model.cycleLayout() } label: { Label("AI", systemImage: "bubble.left.and.bubble.right").font(.footnote) }

            Menu {
                Button { model.sendVideoNow() } label: { Label("Send video + full transcript (once)", systemImage: "paperplane") }
                Button { model.goHome() } label: { Label("YouTube home", systemImage: "house") }
                Button { model.pasteLink() } label: { Label("Open copied YouTube link", systemImage: "link") }
                Button { showSettings = true } label: { Label("Settings", systemImage: "gearshape") }
            } label: { Image(systemName: "ellipsis.circle").font(.title3) }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    private func chatToggle(_ id: String, _ name: String) -> some View {
        let on = model.sendOn && model.target == id
        return Button { model.toggleChat(id) } label: {
            Text((on ? "● " : "○ ") + name)
                .font(.footnote.weight(.semibold))
                .foregroundColor(.white)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Capsule().fill(on ? Color(red: 0.12, green: 0.56, blue: 0.24) : Color(red: 0.85, green: 0.19, blue: 0.15)))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(name + (on ? " on" : " off"))
    }

    @ViewBuilder
    private func panes(in size: CGSize) -> some View {
        // video on top (the main thing), the AI window under it (a small strip until you open it)
        VStack(spacing: 0) {
            WebHost(webView: model.youtube).frame(height: model.videoLength(in: size))
            Divider()
            WebHost(webView: model.chat)
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

    var body: some View {
        NavigationView {
            Form {
                Section(header: Text("Chat")) {
                    Picker("Send to", selection: $model.target) {
                        Text("Claude").tag("claude")
                        Text("ChatGPT").tag("chatgpt")
                    }
                    .pickerStyle(.segmented)
                    Toggle("Read the AI's answer out loud", isOn: $model.speakOn)
                }
                Section(header: Text("When I pause the video")) {
                    Toggle("Show the last ~30 seconds as subtitles and send them", isOn: $model.pauseOn)
                    Toggle("Play those sentences again once", isOn: $model.replayOn)
                    Toggle("Say “let's go” to play that part again and keep going", isOn: $model.voiceOn)
                }
                Section(header: Text("Touch the video"), footer: Text("Touch the middle of the video: it pauses, shows the sentences and sends them. Touch again: it plays that part again and keeps going. The small label in the corner shows what the app is doing.")) {
                    Toggle("Touching the video pauses / plays it", isOn: $model.tapOn)
                    Toggle("Show the small status label on the video", isOn: $model.badgeOn)
                }
                Section(header: Text("Text size on the video: \(String(format: "%.2f", model.textLevel))"),
                        footer: Text("1 = smallest, 6 = medium, 10 = biggest. Play (▶) or tap the video also means “let's go”.")) {
                    Slider(value: $model.textLevel, in: 1...10, step: 0.25)
                }
            }
            .navigationTitle("Settings")
            .navigationBarItems(trailing: Button("Done") { presentation.wrappedValue.dismiss() })
        }
        .navigationViewStyle(.stack)
    }
}
