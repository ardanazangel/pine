import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
	appId: "com.pmndre.pine",
	appName: "Pine",
	webDir: "dist",
	ios: { contentInset: "never", scheme: "Pine" },
};

export default config;
