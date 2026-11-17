// The phone's side of the app: what desktop/electron/main.ts is on a computer. The page asks for
// calls by name (mobile/src/bridge.ts); this side holds the token, makes every call to the daemon,
// follows its events, serves the pictures it may show, and opens only web addresses, outside the app.
import Capacitor
import Security
import UIKit
import WebKit

// MARK: - the pairing, in the Keychain

/// Where the paired pine answers and its token: one item, readable on this device only, after the first unlock.
enum Pairing {
	private static let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.pmndre.pine.pairing", kSecAttrAccount as String: "pine"]

	static func load() -> (base: URL, token: String)? {
		var q = query
		q[kSecReturnData as String] = true
		q[kSecMatchLimit as String] = kSecMatchLimitOne
		var out: CFTypeRef?
		guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data,
			let saved = try? JSONSerialization.jsonObject(with: data) as? [String: String],
			let base = saved["base"].flatMap(URL.init(string:)), let token = saved["token"] else { return nil }
		return (base, token)
	}

	static func save(base: URL, token: String) -> Bool {
		clear()
		guard let data = try? JSONSerialization.data(withJSONObject: ["base": base.absoluteString, "token": token]) else { return false }
		var q = query
		q[kSecValueData as String] = data
		q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
		return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
	}

	static func clear() {
		SecItemDelete(query as CFDictionary)
	}
}

/// The address a pairing may name: http(s), a host, no path, no user or password in it.
func pineBase(_ text: String) -> URL? {
	guard var parts = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)), let scheme = parts.scheme?.lowercased(), scheme == "http" || scheme == "https", let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil, parts.path.isEmpty || parts.path == "/" else { return nil }
	parts.path = ""
	return parts.url
}

// MARK: - calls

/// No cookies, no cache, and no redirect: the token goes to the address that was paired and to no other.
final class Daemon: NSObject, URLSessionTaskDelegate {
	static let shared = Daemon()
	lazy var session: URLSession = {
		let c = URLSessionConfiguration.ephemeral
		c.requestCachePolicy = .reloadIgnoringLocalCacheData
		c.httpShouldSetCookies = false
		c.timeoutIntervalForRequest = 60
		return URLSession(configuration: c, delegate: self, delegateQueue: nil)
	}()

	func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
		completionHandler(nil)
	}

	/// A request of the control API, in the owner's name. `path` is the API's own, as the page names it.
	func request(_ base: URL, _ token: String, method: String, path: String, body: Data? = nil) -> URLRequest? {
		guard path.hasPrefix("/"), !path.hasPrefix("//"), let url = URL(string: base.absoluteString + path), url.host == base.host, url.port == base.port, url.scheme == base.scheme else { return nil }
		var r = URLRequest(url: url)
		r.httpMethod = method
		r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
		if let body {
			r.httpBody = body
			r.setValue("application/json", forHTTPHeaderField: "Content-Type")
		}
		return r
	}
}

// MARK: - the plugin the page talks to

@objc(PinePlugin)
public class PinePlugin: CAPPlugin, CAPBridgedPlugin {
	public let identifier = "PinePlugin"
	public let jsName = "Pine"
	public let pluginMethods: [CAPPluginMethod] = [
		CAPPluginMethod(name: "paired", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "pair", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "unpair", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "call", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "follow", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
	]

	private var stream: EventStream?

	override public func load() {
		let center = NotificationCenter.default
		center.addObserver(self, selector: #selector(active), name: UIApplication.didBecomeActiveNotification, object: nil)
		center.addObserver(self, selector: #selector(inactive), name: UIApplication.willResignActiveNotification, object: nil)
	}

	// What is not seen stops: the stream ends while the app is in the background, and comes back with it.
	@objc private func active() {
		stream?.start()
		notifyListeners("focus", data: ["focused": true])
	}

	@objc private func inactive() {
		stream?.stop()
		notifyListeners("focus", data: ["focused": false])
	}

	@objc func paired(_ call: CAPPluginCall) {
		call.resolve(Pairing.load().map { ["base": $0.base.absoluteString] } ?? [:])
	}

	@objc func pair(_ call: CAPPluginCall) {
		guard let base = pineBase(call.getString("base") ?? "") else { return call.resolve(["ok": false, "error": "That is not an address: type it as http://host:port or https://host."]) }
		let token = (call.getString("token") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
		guard !token.isEmpty, let r = Daemon.shared.request(base, token, method: "GET", path: "/overview") else { return call.resolve(["ok": false, "error": "The token is missing."]) }
		Daemon.shared.session.dataTask(with: r) { _, res, err in
			let status = (res as? HTTPURLResponse)?.statusCode ?? 0
			if let err { return call.resolve(["ok": false, "error": "pine does not answer at \(base.absoluteString) (\(err.localizedDescription))."]) }
			if status == 401 || status == 403 { return call.resolve(["ok": false, "error": "pine answers, but does not take this token (\(status))."]) }
			guard status == 200 else { return call.resolve(["ok": false, "error": "Something answers at \(base.absoluteString), but not pine (\(status))."]) }
			call.resolve(Pairing.save(base: base, token: token) ? ["ok": true] : ["ok": false, "error": "The Keychain did not keep the pairing."])
		}.resume()
	}

	@objc func unpair(_ call: CAPPluginCall) {
		stream?.stop()
		stream = nil
		Pairing.clear()
		call.resolve()
	}

	@objc func call(_ call: CAPPluginCall) {
		guard let (base, token) = Pairing.load() else { return call.resolve(["ok": false, "status": 503, "data": ["error": "This phone is not paired with a pine."]]) }
		let method = call.getString("method") ?? ""
		var body: Data?
		if let b = call.options["body"], !(b is NSNull) {
			body = try? JSONSerialization.data(withJSONObject: b, options: [.fragmentsAllowed])
		}
		guard method == "GET" || method == "POST", let r = Daemon.shared.request(base, token, method: method, path: call.getString("url") ?? "", body: body) else {
			return call.resolve(["ok": false, "status": 400, "data": ["error": "not a call of the control API"]])
		}
		Daemon.shared.session.dataTask(with: r) { data, res, err in
			guard let res = res as? HTTPURLResponse, err == nil else {
				return call.resolve(["ok": false, "status": 0, "data": ["error": "pine does not answer (\(err?.localizedDescription ?? "no answer"))"]])
			}
			let ok = (200..<300).contains(res.statusCode)
			let type = res.value(forHTTPHeaderField: "Content-Type") ?? ""
			let bytes = data ?? Data()
			if type.hasPrefix("application/json") {
				let json = (try? JSONSerialization.jsonObject(with: bytes, options: [.fragmentsAllowed])) ?? [String: Any]()
				return call.resolve(["ok": ok, "status": res.statusCode, "data": json])
			}
			// A picture: bytes and their kind.
			call.resolve(["ok": ok, "status": res.statusCode, "data": ["mime": type, "base64": bytes.base64EncodedString()]])
		}.resume()
	}

	@objc func follow(_ call: CAPPluginCall) {
		if stream == nil {
			stream = EventStream(
				batch: { [weak self] events in self?.notifyListeners("events", data: ["batch": events]) },
				connection: { [weak self] up in self?.notifyListeners("connection", data: ["up": up]) })
		}
		stream?.start()
		call.resolve()
	}

	@objc func open(_ call: CAPPluginCall) {
		if let url = URL(string: call.getString("url") ?? ""), webAddress(url) {
			DispatchQueue.main.async { UIApplication.shared.open(url) }
		}
		call.resolve()
	}

	/// The page itself never goes anywhere: a link in an answer opens in Safari when it is a web address, and otherwise nowhere.
	override public func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
		guard let url = navigationAction.request.url, let own = bridge?.config.localURL else { return true }
		if url.absoluteString.hasPrefix(own.absoluteString) || url.scheme == "about" { return nil }
		if navigationAction.targetFrame?.isMainFrame != false, webAddress(url) {
			DispatchQueue.main.async { UIApplication.shared.open(url) }
		}
		return true
	}
}

func webAddress(_ url: URL) -> Bool {
	url.scheme == "http" || url.scheme == "https"
}

// MARK: - the daemon's events

/**
 The daemon's stream of events (`/events/stream`), handed to the page in batches: a model that
 writes fast sends a hundred events a second, and each as a message of its own would keep the
 page busy. A stream that breaks is made again after a second.
 */
final class EventStream: NSObject, URLSessionDataDelegate {
	private let batch: ([Any]) -> Void
	private let connection: (Bool) -> Void
	private var session: URLSession?
	private var buffer = Data()
	private var pending: [Any] = []
	private var flushing = false
	private var running = false
	private let queue = DispatchQueue(label: "pine.events")

	init(batch: @escaping ([Any]) -> Void, connection: @escaping (Bool) -> Void) {
		self.batch = batch
		self.connection = connection
	}

	func start() {
		queue.async {
			guard !self.running else { return }
			self.running = true
			self.connect()
		}
	}

	func stop() {
		queue.async {
			self.running = false
			self.session?.invalidateAndCancel()
			self.session = nil
		}
	}

	private func connect() {
		guard running, let (base, token) = Pairing.load(), var r = Daemon.shared.request(base, token, method: "GET", path: "/events/stream?topic=%23") else { return }
		r.timeoutInterval = .infinity
		let c = URLSessionConfiguration.ephemeral
		c.timeoutIntervalForRequest = .infinity
		c.timeoutIntervalForResource = .infinity
		c.httpShouldSetCookies = false
		let q = OperationQueue()
		q.underlyingQueue = queue
		let s = URLSession(configuration: c, delegate: self, delegateQueue: q)
		session = s
		buffer = Data()
		s.dataTask(with: r).resume()
	}

	func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
		let ok = (response as? HTTPURLResponse)?.statusCode == 200
		if ok { connection(true) }
		completionHandler(ok ? .allow : .cancel)
	}

	func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
		completionHandler(nil)
	}

	func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
		buffer.append(data)
		let end = Data("\n\n".utf8)
		while let range = buffer.range(of: end) {
			let block = buffer.subdata(in: buffer.startIndex..<range.lowerBound)
			buffer.removeSubrange(buffer.startIndex..<range.upperBound)
			guard let text = String(data: block, encoding: .utf8), text.hasPrefix("data: "),
				let event = try? JSONSerialization.jsonObject(with: Data(text.dropFirst(6).utf8)) else { continue }
			pending.append(event)
		}
		if !pending.isEmpty, !flushing {
			flushing = true
			queue.asyncAfter(deadline: .now() + .milliseconds(24)) {
				self.flushing = false
				let out = self.pending
				self.pending = []
				if !out.isEmpty { self.batch(out) }
			}
		}
	}

	func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
		guard session === self.session else { return }
		self.session = nil
		session.finishTasksAndInvalidate()
		guard running else { return }
		connection(false)
		queue.asyncAfter(deadline: .now() + 1) { self.connect() }
	}
}

// MARK: - pictures, videos and sounds

/// What the page may show straight from the daemon (pine-media://daemon/...). Nothing else is served this way.
private let MEDIA = [#"^/media/tool/[^/]+$"#, #"^/tasks/\d+/images/\d+$"#, #"^/agents/[^/]+/image$"#, #"^/agents/[^/]+/browser/frame$"#]

final class MediaHandler: NSObject, WKURLSchemeHandler {
	private var live = Set<ObjectIdentifier>()
	private let lock = NSLock()

	func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
		let id = ObjectIdentifier(task)
		lock.withLock { _ = live.insert(id) }
		guard let url = task.request.url, task.request.httpMethod == "GET", let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
			MEDIA.contains(where: { parts.percentEncodedPath.range(of: $0, options: .regularExpression) != nil }),
			let (base, token) = Pairing.load(),
			let r = Daemon.shared.request(base, token, method: "GET", path: parts.percentEncodedPath + (parts.percentEncodedQuery.map { "?" + $0 } ?? "")) else {
			return fail(task, 404)
		}
		Daemon.shared.session.dataTask(with: r) { data, res, _ in
			guard self.lock.withLock({ self.live.contains(id) }) else { return }
			let type = (res as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type") ?? ""
			guard let res = res as? HTTPURLResponse, res.statusCode == 200, let data else { return self.fail(task, 404) }
			// Only what is drawn or played. A page of HTML or a script under this name would be content from outside.
			guard type.hasPrefix("image/") || type.hasPrefix("video/") || type.hasPrefix("audio/"), !type.hasPrefix("image/svg") else { return self.fail(task, 415) }
			let answer = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"])!
			DispatchQueue.main.async {
				guard self.lock.withLock({ self.live.remove(id) != nil }) else { return }
				task.didReceive(answer)
				task.didReceive(data)
				task.didFinish()
			}
		}.resume()
	}

	func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
		lock.withLock { _ = live.remove(ObjectIdentifier(task)) }
	}

	private func fail(_ task: WKURLSchemeTask, _ status: Int) {
		DispatchQueue.main.async {
			guard self.lock.withLock({ self.live.remove(ObjectIdentifier(task)) != nil }), let url = task.request.url else { return }
			task.didReceive(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: [:])!)
			task.didFinish()
		}
	}
}

// MARK: - the window

final class PineViewController: CAPBridgeViewController {
	override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
		let c = super.webViewConfiguration(for: instanceConfiguration)
		c.setURLSchemeHandler(MediaHandler(), forURLScheme: "pine-media")
		return c
	}

	override func capacitorDidLoad() {
		bridge?.registerPluginInstance(PinePlugin())
	}
}
