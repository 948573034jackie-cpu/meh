import SwiftUI

/// The build server's pictures of the native screens (before / after a change of the look). The app started with
/// "-shot <name>" opens that one screen by itself, a moment after the start, so the simulator can photograph it:
///   main       the usual start (nothing is opened)
///   settings   the app's Settings sheet (SettingsView)
///   tutorpage  My tutor's settings page in its sheet (TutorPageView with options.html)
///   words      My Vocabulary in the same sheet (TutorPageView with vocab.html)
///   reader     I Know only: the reader, full screen (ReaderScreen)
///   browser    I Know only: the browser, full screen (BrowserScreen)
/// Without the argument nothing here does anything (the app the learner uses is not changed).
enum ShotLaunch {
    static let name: String? = {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-shot"), i + 1 < args.count else { return nil }
        return args[i + 1]
    }()
}

extension AppModel {
    /// opens the screen named by -shot (see ShotLaunch); `showSettings` opens the app's Settings sheet of that app
    func openShotScreen(showSettings: @escaping () -> Void) {
        guard let shot = ShotLaunch.name, shot != "main" else { return }
        // (a moment for the first screen to be drawn: a sheet asked for before that does not open)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self = self else { return }
            switch shot {
            case "settings": showSettings()
            case "tutorpage": self.openPage("ytlearn://app/dream/options.html")
            case "words": self.openPage("ytlearn://app/dream/vocab.html")
            #if !BOOK
            case "reader": self.showReader = true
            case "browser": self.showBrowser = true
            #endif
            default: break
            }
        }
    }
}
