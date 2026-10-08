import SwiftUI

struct ContentView: View {
    @EnvironmentObject var model: EyesModel

    var body: some View {
        VStack(spacing: 0) {
            TopBar()
            GeometryReader { geo in
                if geo.size.width > geo.size.height {
                    HStack(spacing: 0) {
                        PagePane().frame(width: geo.size.width * 0.58)
                        Divider()
                        WebPane(controller: model.chat)
                    }
                } else {
                    VStack(spacing: 0) {
                        PagePane().frame(height: geo.size.height * 0.52)
                        Divider()
                        WebPane(controller: model.chat)
                    }
                }
            }
        }
        .onAppear { model.boot() }
    }
}

struct TopBar: View {
    @EnvironmentObject var model: EyesModel
    @State private var showAnyApp = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 12) {
                Circle()
                    .fill(model.listening ? Color.green : Color.yellow)
                    .frame(width: 18, height: 18)
                    .overlay(Circle().stroke(Color.black.opacity(0.25), lineWidth: 1))
                Button(action: { model.setEnabled(!model.enabled) }) {
                    Text(model.enabled ? "ON" : "OFF")
                        .font(.headline)
                        .frame(minWidth: 56)
                        .padding(.vertical, 6)
                        .background(model.enabled ? Color.green : Color.yellow)
                        .foregroundColor(model.enabled ? .white : .black)
                        .cornerRadius(10)
                }
                Menu {
                    Button("Wait 30 seconds") { model.intervalSec = 30 }
                    Button("Wait 1 minute") { model.intervalSec = 60 }
                    Button("Wait 2 minutes") { model.intervalSec = 120 }
                } label: {
                    Text("Wait \(model.intervalSec < 60 ? "\(model.intervalSec) s" : "\(model.intervalSec / 60) min")")
                }
                Spacer()
                Button("Test picture") { Task { await model.captureAndSend(reason: "test") } }
            }
            // second row, so everything also fits on an iPhone
            HStack(spacing: 12) {
                Picker("Chat", selection: $model.service) {
                    ForEach(EyesModel.Service.allCases) { s in Text(s.title).tag(s) }
                }
                .pickerStyle(.segmented)
                Button("Any app") { showAnyApp = true }
            }
            Text(model.status).font(.footnote).foregroundColor(.secondary).lineLimit(2)
            Text(model.lastResult).font(.footnote).lineLimit(2)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(UIColor.secondarySystemBackground))
        .sheet(isPresented: $showAnyApp) { AnyAppView() }
    }
}

struct PagePane: View {
    @EnvironmentObject var model: EyesModel

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                TextField("Type a web address or a search", text: $model.addressText)
                    .textFieldStyle(.roundedBorder)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .disableAutocorrection(true)
                    .onSubmit { model.openPage() }
                Button("Go") { model.openPage() }
            }
            .padding(6)
            WebPane(controller: model.page)
        }
    }
}
