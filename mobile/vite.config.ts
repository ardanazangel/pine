import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The page is the desktop app's (../desktop/src) with a bridge of the phone's own. React and the
// rest come from the desktop's packages, so that there is one React.
const desktop = path.resolve(import.meta.dirname, "../desktop/node_modules");

export default defineConfig({
	base: "./",
	plugins: [react()],
	resolve: { alias: { react: path.join(desktop, "react"), "react-dom": path.join(desktop, "react-dom") }, dedupe: ["react", "react-dom"] },
	build: { outDir: "dist", emptyOutDir: true, target: "safari17", chunkSizeWarningLimit: 4000 },
});
