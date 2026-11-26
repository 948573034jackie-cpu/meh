import SwiftUI

/// The build server's pictures of the native screens (before / after a change of the look). The app started with
/// "-shot <name>" opens that one screen by itself, a moment after the start, so the simulator can photograph it:
///   main       the usual start (nothing is opened): I Know = the Watch tab; I Know Book = the Books tab
///   words      the Words tab (My Vocabulary)
///   settings   the Settings tab (I Know: the native list; I Know Book: its Settings page)
///   more       I Know only: the Watch bar's More sheet
///   tutorpage  My tutor's All settings page in its sheet (TutorPageView with options.html)
///   appsettings I Know Book only: its own settings sheet (the word file, All settings, the help)
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
    /// opens the screen named by -shot (see ShotLaunch); `showSettings` opens the Settings of that app
    func openShotScreen(showSettings: @escaping () -> Void) {
        guard let shot = ShotLaunch.name, shot != "main" else { return }
        // (a moment for the first screen to be drawn: a sheet asked for before that does not open; I Know Book's page
        // must have started)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            guard let self = self else { return }
            switch shot {
            case "tutorpage": self.openPage("ytlearn://app/dream/options.html")
            #if BOOK
            case "words", "settings":
                // (the book page opens that tab once it has started)
                let js = "(function go(n){if(window.__iknowBook&&window.__iknowBook.tab&&document.body.dataset.ready==='1')window.__iknowBook.tab('\(shot)');else if(n<60)setTimeout(function(){go(n+1)},250);})(0);0"
                self.bookHost.web.evaluateJavaScript(js, in: nil, in: .page, completionHandler: nil)
            case "appsettings": self.showAppSettings = true
            #else
            case "settings": showSettings()
            case "words": self.tab = .words
            case "more": self.moreOpen = true
            case "reader": self.showReader = true
            case "browser": self.showBrowser = true
            #endif
            default: break
            }
        }
    }
}
