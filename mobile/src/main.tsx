// The phone's page: the pairing screen until this phone knows a pine, then the desktop app's page.
// The bridge goes in first: the desktop's modules take `window.pine` when they are loaded.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { mobileBridge, Pine } from "./bridge.ts";
import "../../desktop/src/styles.css";
import "./mobile.css";

window.pine = mobileBridge;

function Pair({ done }: { done: () => void }) {
	const [base, setBase] = useState("");
	const [token, setToken] = useState("");
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const pair = async () => {
		setBusy(true);
		setError(undefined);
		const r = await Pine.pair({ base: base.trim(), token: token.trim() }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
		setBusy(false);
		if (r.ok) done();
		else setError(r.error ?? "pine did not answer.");
	};
	return (
		<div className="pair">
			<h1>Pine</h1>
			<p className="muted">Pair this phone with the pine on your computer. Your phone reaches it over your own network, for example Tailscale.</p>
			<label>
				<span>Address</span>
				<input value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://mac.tailnet.ts.net" autoCapitalize="off" autoCorrect="off" inputMode="url" />
			</label>
			<label>
				<span>Token</span>
				<input value={token} onChange={(e) => setToken(e.target.value)} placeholder="the token of pine's control API" autoCapitalize="off" autoCorrect="off" type="password" />
			</label>
			{error ? <p className="error">{error}</p> : null}
			<button className="btn btn-primary" disabled={busy || !base.trim() || !token.trim()} onClick={() => void pair()}>
				{busy ? "Connecting…" : "Pair"}
			</button>
			<p className="faint">The token stays in this phone's Keychain. The page you see never holds it.</p>
		</div>
	);
}

async function start() {
	const root = createRoot(document.getElementById("root")!);
	const { base } = await Pine.paired();
	const app = async () => {
		const [{ App }, { store }] = await Promise.all([import("../../desktop/src/App.tsx"), import("../../desktop/src/model.ts")]);
		// On a phone the side bar is a drawer: closed at the start, and closed again once a
		// conversation is chosen or the conversation behind it is touched.
		const narrow = () => window.matchMedia("(max-width: 760px)").matches;
		if (narrow() && store.sidebar) store.sidebar = false;
		document.addEventListener("click", (e) => {
			const at = e.target as Element;
			if (!narrow() || !store.sidebar) return;
			if (at.closest(".side-conv") || (at.closest(".main") && !at.closest(".scrim"))) (store.sidebar = false), store.touch();
		});
		root.render(<App />);
	};
	if (base) return app();
	root.render(<Pair done={() => void app()} />);
}

void start();
