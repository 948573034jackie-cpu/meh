import SwiftUI

@main
struct YTLearnApp: App {
    var body: some Scene {
        WindowGroup {
            // (two apps from the same code: I Know, YouTube with the tutor; and I Know Book, only books)
            #if BOOK
            BookRootView()
            #else
            ContentView()
            #endif
        }
    }
}
