import SwiftUI

@main
struct YTLearnApp: App {
    var body: some Scene {
        WindowGroup {
            // (two apps from the same code: I Know, YouTube with the tutor; and I Know Book, only books)
            // (the one look, design/theme.json: the warm accent tints every native button of both apps)
            #if BOOK
            BookRootView().tint(Theme.accent)
            #else
            ContentView().tint(Theme.accent)
            #endif
        }
    }
}
