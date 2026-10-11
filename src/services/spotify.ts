import { SpotifyBrowser } from './browser';
import type { SpotifyToken, Cookie } from '../types/types';
import { logs } from '../utils/logger';

export class Spotify {
    private browser: SpotifyBrowser;
    private anonymousToken: SpotifyToken | null = null;
    private authenticatedToken: SpotifyToken | null = null;
    private clientCredentialsToken: SpotifyToken | null = null;
    private proactiveRefreshTimer: NodeJS.Timeout | null = null;
    private isRefreshing = false;

    private readonly PROACTIVE_REFRESH_BUFFER = 5 * 60 * 1000;
    private readonly CHECK_INTERVAL = 60 * 1000; 

    constructor() {
        this.browser = new SpotifyBrowser();
        
        // Only spin up proactive refresh if anonymous mode is permitted
        if (this.isAnonymousAllowed()) {
            this.initializeProactiveRefresh();
            this.getAnonymousToken().catch(err => {
                logs('error', 'Failed initial anonymous token fetch', err);
            });
        }
        
        logs('info', 'Spotify Token Service initialized');
    }

    /**
     * Strict Mode Getters
     */
    private isClientCredentialsExplicit(): boolean {
        return process.env.USE_CLIENT_CREDENTIALS === 'true';
    }

    private isSpDcAuthExplicit(): boolean {
        return process.env.USE_SP_DC_AUTH === 'true';
    }

    private isAnonymousExplicit(): boolean {
        return process.env.USE_ANONYMOUS === 'true';
    }

    private isAnonymousAllowed(): boolean {
        if (process.env.USE_ANONYMOUS === 'false') return false;
        return this.isAnonymousExplicit() || (!this.isClientCredentialsExplicit() && !this.isSpDcAuthExplicit());
    }

    /**
     * Token Resolution Engine
     */
    public async getToken(cookies?: Cookie[]): Promise<SpotifyToken | null> {
        // 1. Explicit Mode Flags take absolute priority
        if (this.isAnonymousExplicit()) {
            logs('info', 'USE_ANONYMOUS=true -> Fetching anonymous token');
            return this.getAnonymousToken();
        }

        if (this.isClientCredentialsExplicit()) {
            logs('info', 'USE_CLIENT_CREDENTIALS=true -> Fetching client credentials token');
            return this.getClientCredentialsToken();
        }

        if (this.isSpDcAuthExplicit()) {
            logs('info', 'USE_SP_DC_AUTH=true -> Fetching sp_dc authenticated token');
            const activeCookies = cookies ?? this.getCookiesFromEnv();
            return this.getAuthenticatedToken(activeCookies);
        }

        // 2. Implicit Fallback (When no USE_* flags are explicitly true)
        const activeCookies = cookies ?? this.getCookiesFromEnv();
        const hasSpDcCookie = this.hasSpDcCookie(activeCookies);

        if (hasSpDcCookie && process.env.USE_SP_DC_AUTH !== 'false') {
            return this.getAuthenticatedToken(activeCookies);
        }

        if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET && process.env.USE_CLIENT_CREDENTIALS !== 'false') {
            return this.getClientCredentialsToken();
        }

        if (this.isAnonymousAllowed()) {
            return this.getAnonymousToken();
        }

        logs('error', 'No valid token strategy could be resolved based on configuration');
        return null;
    }

    /**
     * Obtain token using Spotify Client ID and Client Secret
     */
    private async getClientCredentialsToken(): Promise<SpotifyToken | null> {
        if (this.clientCredentialsToken && this.isTokenValid(this.clientCredentialsToken)) {
            logs('debug', 'Returning cached client credentials token');
            return this.clientCredentialsToken;
        }

        const clientId = process.env.SPOTIFY_CLIENT_ID;
        const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

        if (!clientId || !clientSecret) {
            logs('error', 'SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET missing in environment');
            return null;
        }

        try {
            logs('info', 'Fetching fresh OAuth token using Client Credentials');
            const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
            
            const response = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${authHeader}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: 'grant_type=client_credentials',
            });

            if (!response.ok) {
                throw new Error(`Spotify Auth API returned status ${response.status}`);
            }

            const data = await response.json() as { access_token: string; expires_in: number };

            const token: SpotifyToken = {
                clientId,
                accessToken: data.access_token,
                accessTokenExpirationTimestampMs: Date.now() + (data.expires_in * 1000),
                isAnonymous: false,
            };

            this.clientCredentialsToken = token;
            logs('info', 'Successfully obtained Client Credentials token');
            return token;
        } catch (error) {
            logs('error', 'Client Credentials token fetch failed', error instanceof Error ? error.message : error);
            return null;
        }
    }

    /**
     * Handle authenticated token requests (sp_dc cookie via Playwright)
     */
    private async getAuthenticatedToken(cookies?: Cookie[]): Promise<SpotifyToken | null> {
        logs('info', 'Fetching fresh authenticated token for sp_dc user');

        try {
            const token = await this.browser.getToken(cookies);

            if (!token.isAnonymous) {
                this.authenticatedToken = token;
                logs('info', 'Successfully obtained authenticated token');
            }

            return token;
        } catch (error) {
            logs('error', 'Authenticated token fetch failed', error instanceof Error ? error.message : error);
            return null;
        }
    }

    /**
     * Handle anonymous token requests
     */
    private async getAnonymousToken(): Promise<SpotifyToken | null> {
        if (this.anonymousToken && this.isTokenValid(this.anonymousToken)) {
            logs('debug', 'Returning cached anonymous token');
            return this.anonymousToken;
        }

        if (this.isRefreshing) {
            logs('info', 'Waiting for ongoing refresh to complete');
            await this.waitForRefresh();

            if (this.anonymousToken && this.isTokenValid(this.anonymousToken)) {
                return this.anonymousToken;
            }

            logs('warn', 'Ongoing refresh finished without producing a valid token. Attempting fresh fetch...');
        }

        logs('info', 'Fetching fresh anonymous token');
        return this.refreshAnonymousToken();
    }

    private async refreshAnonymousToken(): Promise<SpotifyToken | null> {
        if (this.isRefreshing) {
            await this.waitForRefresh();
            return this.anonymousToken;
        }

        this.isRefreshing = true;

        try {
            const token = await this.browser.getToken();

            if (token.isAnonymous) {
                this.anonymousToken = token;
                logs('info', 'Anonymous token refreshed successfully');
            } else {
                logs('warn', 'Expected anonymous token but got authenticated token');
            }

            return token;
        } catch (error) {
            logs('error', 'Anonymous token refresh failed', error instanceof Error ? error.message : error);
            return null;
        } finally {
            this.isRefreshing = false;
        }
    }

private lastRefreshAttempt = 0;
    private readonly REFRESH_COOLDOWN = 2 * 60 * 1000; // 2 minutes cooldown

    private initializeProactiveRefresh(): void {
        const checkAndRefresh = async () => {
            try {
                if (this.anonymousToken && !this.isRefreshing) {
                    const timeUntilExpiry = this.anonymousToken.accessTokenExpirationTimestampMs - Date.now();
                    const now = Date.now();

                    // Proactively refresh only if within buffer AND cooldown has passed
                    if (timeUntilExpiry <= this.PROACTIVE_REFRESH_BUFFER && (now - this.lastRefreshAttempt) > this.REFRESH_COOLDOWN) {
                        logs('info', `Anonymous token expires in ${Math.round(timeUntilExpiry / 1000 / 60)} minutes - proactively refreshing`);
                        this.lastRefreshAttempt = now;
                        await this.refreshAnonymousToken();
                    }
                }
            } catch (error) {
                logs('error', 'Proactive refresh check failed', error);
            }

            this.proactiveRefreshTimer = setTimeout(checkAndRefresh, this.CHECK_INTERVAL);
        };

        this.proactiveRefreshTimer = setTimeout(checkAndRefresh, this.CHECK_INTERVAL);
        logs('info', 'Proactive refresh scheduler started for anonymous tokens');
    }

    private hasSpDcCookie(cookies?: Cookie[]): boolean {
        return cookies?.some(cookie => cookie.name === 'sp_dc') || false;
    }

    private getCookiesFromEnv(): Cookie[] | undefined {
        const rawEnvCookie = process.env.SPOTIFY_COOKIE?.trim();
        if (!rawEnvCookie) return undefined;

        if (rawEnvCookie.startsWith('[')) {
            try {
                return JSON.parse(rawEnvCookie);
            } catch {
                logs('error', 'Failed to parse SPOTIFY_COOKIE JSON array from env');
            }
        }

        return [{
            name: 'sp_dc',
            value: rawEnvCookie,
            domain: '.spotify.com',
            path: '/',
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax'
        }];
    }

    private isTokenValid(token: SpotifyToken): boolean {
        return token.accessTokenExpirationTimestampMs > Date.now();
    }

    private async waitForRefresh(): Promise<void> {
        let attempts = 0;
        const maxAttempts = 30;

        while (this.isRefreshing && attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
        }
    }

    public async cleanup(): Promise<void> {
        if (this.proactiveRefreshTimer) {
            clearTimeout(this.proactiveRefreshTimer);
            this.proactiveRefreshTimer = null;
            logs('info', 'Proactive refresh timer stopped');
        }

        await this.browser.close();
        this.anonymousToken = null;
        this.authenticatedToken = null;
        this.clientCredentialsToken = null;
        logs('info', 'Token service cleanup completed');
    }

    public getStatus() {
        return {
            modeFlags: {
                USE_ANONYMOUS: process.env.USE_ANONYMOUS,
                USE_CLIENT_CREDENTIALS: process.env.USE_CLIENT_CREDENTIALS,
                USE_SP_DC_AUTH: process.env.USE_SP_DC_AUTH,
            },
            hasAnonymousToken: !!this.anonymousToken,
            hasAuthenticatedToken: !!this.authenticatedToken,
            hasClientCredentialsToken: !!this.clientCredentialsToken,
            isRefreshing: this.isRefreshing,
        };
    }
}