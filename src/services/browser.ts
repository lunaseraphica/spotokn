import playwright from "playwright";
import type {
    Browser,
    LaunchOptions,
    BrowserContext,
    Response,
} from "playwright";
import type { SpotifyToken, Cookie } from "../types/types";
import { logs } from "../utils/logger";

export class SpotifyBrowser {
    private browser: Browser | undefined;
    private context: BrowserContext | undefined;

    private async launch(): Promise<{
        browser: Browser;
        context: BrowserContext;
    }> {
        if (!this.browser || !this.context) {
            try {
                const executablePath =
                    process.env.BROWSER_PATH && process.env.BROWSER_PATH.trim() !== ""
                        ? process.env.BROWSER_PATH
                        : undefined;
                const launchOptions: LaunchOptions = {
                    headless: process.env.HEADLESS !== 'false',
                    args: [
                        "--disable-gpu",
                        "--disable-dev-shm-usage",
                        "--disable-setuid-sandbox",
                        "--no-sandbox",
                        "--no-zygote",
                        "--disable-extensions",
                        "--disable-background-timer-throttling",
                        "--disable-backgrounding-occluded-windows",
                        "--disable-renderer-backgrounding",
                    ],
                };
                if (executablePath) launchOptions.executablePath = executablePath;

                this.browser = await playwright.chromium.launch(launchOptions);
                this.context = await this.browser.newContext({
                    userAgent:
                        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
                });
            } catch (err) {
                this.browser = undefined;
                this.context = undefined;
                logs("error", "Failed to launch browser or context", err);
                throw err;
            }
        } else {
            if (this.browser.isConnected() === false) {
                logs("warn", "Browser is not connected, relaunching...");
                this.browser = undefined;
                this.context = undefined;
                return this.launch();
            }
            try {
                this.context.pages();
            } catch {
                logs("warn", "Context is closed, relaunching...");
                this.browser = undefined;
                this.context = undefined;
                return this.launch();
            }
        }
        return { browser: this.browser, context: this.context };
    }

    public async getToken(cookies?: Cookie[]): Promise<SpotifyToken> {
        const { context } = await this.launch();
        const page = await context.newPage();

        try {
            await context.clearCookies();

            if (cookies && cookies.length > 0) {
                const cookieObjects = cookies.map((cookie) => ({
                    name: cookie.name,
                    value: cookie.value,
                    domain: ".spotify.com",
                    path: "/",
                    httpOnly: false,
                    secure: true,
                    sameSite: "Lax" as const,
                }));
                await context.addCookies(cookieObjects);
                logs(
                    "info",
                    "Cookies set for request",
                    cookieObjects.map((c) => ({
                        name: c.name,
                        value: `${c.value.slice(0, 20)}...`,
                    })),
                );
            }

            // Route blocking: block unnecessary assets but keep JS and essential API traffic
            await page.route("**/*", (route) => {
                const url = route.request().url();
                const type = route.request().resourceType();

                const blockedTypes = new Set([
                    "image",
                    "font",
                    "media",
                    "websocket",
                ]);

                const blockedPatterns = [
                    "google-analytics",
                    "doubleclick.net",
                    "googletagmanager.com",
                    "https://open.spotifycdn.com/cdn/images/",
                    "https://encore.scdn.co/fonts/",
                ];

                if (blockedTypes.has(type) || blockedPatterns.some((pat) => url.includes(pat))) {
                    route.abort();
                    return;
                }

                route.continue();
            });

            // Promise setup to capture Spotify's token response
            const tokenPromise = page.waitForResponse(
                (response: Response) => response.url().includes("/api/token"),
                { timeout: 15000 }
            );

            // Use domcontentloaded so client JS initializes and calls /api/token
            await page.goto("https://open.spotify.com/", {
                waitUntil: "domcontentloaded",
                timeout: 20000,
            });

            const response = await tokenPromise;

            if (!response.ok()) {
                throw new Error(`Invalid response status from Spotify: ${response.status()}`);
            }

            const responseBody = await response.text();
            let json: Record<string, unknown>;

            try {
                json = JSON.parse(responseBody);
            } catch {
                logs("error", "Failed to parse response JSON");
                throw new Error("Failed to parse response JSON");
            }

            if (json && typeof json === "object" && "_notes" in json) {
                delete json._notes;
            }

            return json as unknown as SpotifyToken;
        } catch (error) {
            logs("error", `Token fetch failed: ${error}`);
            throw error instanceof Error ? error : new Error(String(error));
        } finally {
            await page.close().catch(() => {});
        }
    }

    public async close(): Promise<void> {
        if (this.browser) {
            await this.browser.close();
            this.browser = undefined;
            this.context = undefined;
        }
    }
}