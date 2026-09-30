import SwiftUI

@main
struct ClaudeEyesApp: App {
    @StateObject private var model = EyesModel()

    var body: some Scene {
        WindowGroup {
            ContentView().environmentObject(model)
        }
    }
}
