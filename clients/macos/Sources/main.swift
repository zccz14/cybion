// Cybion — macOS viewer shell.
//
// A minimal WKWebView container for the hosted Cybion web app. It is a viewer
// only: it renders cybion.ntnl.io, keeps the session in the default website
// data store, routes other hosts to the system browser, and injects the shared
// Ed25519 shim before any page script. No model, no worker, no credentials.

@preconcurrency import AppKit
@preconcurrency import WebKit

// MARK: - Configuration

enum ShellConfig {
    static let startURL = URL(string: "https://cybion.ntnl.io/")!
    /// Hosts that stay inside the shell; subdomains are included.
    static let allowedHosts = ["ntnl.io", "ntnl.top", "aliyun.com"]
}

// MARK: - Navigation policy

enum Destination {
    case inApp
    case external
    case blocked
}

enum NavigationPolicy {
    static func decide(_ url: URL?) -> Destination {
        guard let url, let scheme = url.scheme?.lowercased() else { return .blocked }
        switch scheme {
        case "http", "https":
            return isAllowed(url.host) ? .inApp : .external
        case "about", "data", "blob", "javascript":
            return .inApp
        default:
            // mailto, tel, custom schemes, etc.
            return .external
        }
    }

    static func isAllowed(_ host: String?) -> Bool {
        guard let host = host?.lowercased() else { return false }
        return ShellConfig.allowedHosts.contains { host == $0 || host.hasSuffix("." + $0) }
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {

    private var window: NSWindow!
    private var webView: WKWebView!
    private var progress: NSProgressIndicator!
    private var errorView: NSView!
    private let errorLabel = NSTextField(labelWithString: "")
    private var progressObservation: NSKeyValueObservation?

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        webView.load(URLRequest(url: ShellConfig.startURL))
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // MARK: Layout

    private func makeWebView() -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()          // persistent, on-disk session
        if let url = Bundle.main.url(forResource: "ed25519-polyfill", withExtension: "js"),
           let js = try? String(contentsOf: url, encoding: .utf8), !js.isEmpty {
            config.userContentController.addUserScript(
                WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        }
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.allowsMagnification = true
        return webView
    }

    private func buildWindow() {
        let content = NSView()
        let webView = makeWebView()
        let progress = NSProgressIndicator()
        let errorView = buildErrorView()

        for view in [webView, progress, errorView] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            content.addSubview(view)
        }
        progress.isIndeterminate = false
        progress.minValue = 0
        progress.maxValue = 1
        progress.isHidden = true
        progress.controlSize = .small

        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: content.topAnchor),
            webView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),

            errorView.topAnchor.constraint(equalTo: content.topAnchor),
            errorView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            errorView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            errorView.trailingAnchor.constraint(equalTo: content.trailingAnchor),

            progress.topAnchor.constraint(equalTo: content.topAnchor),
            progress.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            progress.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            progress.heightAnchor.constraint(equalToConstant: 2),
        ])

        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1024, height: 720),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.contentView = content
        window.title = "Cybion"
        window.minSize = NSSize(width: 360, height: 480)
        window.center()
        window.makeKeyAndOrderFront(nil)

        self.contentView = content
        self.webView = webView
        self.progress = progress
        self.errorView = errorView

        progressToken = webView.observe(\.estimatedProgress, options: [.new]) { [weak self] webView, _ in
            let value = webView.estimatedProgress
            self?.progress?.doubleValue = value
            self?.progress?.isHidden = value >= 1.0
        }
    }

    private var contentView: NSView?
    private var progressToken: NSKeyValueObservation?

    private func buildErrorView() -> NSView {
        let container = NSView()
        container.isHidden = true

        errorLabel.alignment = .center
        errorLabel.maximumNumberOfLines = 0
        errorLabel.textColor = .secondaryLabelColor
        errorLabel.translatesAutoresizingMaskIntoConstraints = false
        errorLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 420).isActive = true

        let retry = NSButton(title: "Retry", target: self, action: #selector(retryTapped))
        retry.bezelStyle = .rounded

        let stack = NSStackView(views: [errorLabel, retry])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: container.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -24),
        ])
        return container
    }

    private func showError(_ message: String) {
        errorLabel.stringValue = message
        errorView?.isHidden = false
    }

    private func hideError() {
        errorView?.isHidden = true
    }

    @objc private func retryTapped() {
        hideError()
        webView.reload()
    }

    // MARK: Menu

    private func buildMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Cybion",
                        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Cybion", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Cybion", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu

        let viewItem = NSMenuItem()
        mainMenu.addItem(viewItem)
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload", action: #selector(reloadAction), keyEquivalent: "r")
        viewMenu.addItem(withTitle: "Back", action: #selector(backAction), keyEquivalent: "[")
        viewItem.submenu = viewMenu

        NSApp.mainMenu = mainMenu
    }

    @objc private func reloadAction() { webView.reload() }
    @objc private func backAction() { if webView.canGoBack { webView.goBack() } }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // Subframes (iframes) are the page's own business; only steer top-level nav.
        if let frame = navigationAction.targetFrame, !frame.isMainFrame {
            decisionHandler(.allow)
            return
        }
        switch NavigationPolicy.decide(navigationAction.request.url) {
        case .inApp:
            decisionHandler(.allow)
        case .external:
            if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        case .blocked:
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            switch NavigationPolicy.decide(url) {
            case .inApp: webView.load(URLRequest(url: url))
            case .external: NSWorkspace.shared.open(url)
            case .blocked: break
            }
        }
        return nil
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        hideError()
        progress?.isHidden = false
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        progress?.doubleValue = 1
        progress?.isHidden = true
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        progress?.isHidden = true
        showError("Couldn't load Cybion.\n\(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        progress?.isHidden = true
        showError("Couldn't load Cybion.\n\(error.localizedDescription)")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }
}

// MARK: - Entry point

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
