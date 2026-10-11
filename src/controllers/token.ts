import type { Spotify } from '../services/spotify';
import type { Cookie } from '../types/types';
import { logs } from '../utils/logger';

export class TokenController {
    constructor(private readonly tokenService: Spotify) { }

    public async handle(
        queryParams: { force?: string; debug?: string },
        cookies: Record<string, string> | undefined,
        setStatus: (status: number) => void
    ) {
        try {
            // Debug endpoint
            if (queryParams.debug === 'true') {
                logs('info', 'Debug status requested');
                return this.tokenService.getStatus();
            }

            // Read environment strategy flags
            const isAnonymous = process.env.USE_ANONYMOUS === 'true';
            const isClientCredentials = process.env.USE_CLIENT_CREDENTIALS === 'true';
            const isSpDcAuth = process.env.USE_SP_DC_AUTH === 'true';

            // Extract cookies passed from request or fallback to env
            const cookieArray = this.extractCookies(cookies);
            const hasSpDc = cookieArray.some(c => c.name === 'sp_dc');

            // Log strategy in sync with Spotify.ts priority
            if (isAnonymous) {
                logs('info', 'Processing anonymous request (USE_ANONYMOUS=true)');
            } else if (isClientCredentials) {
                logs('info', 'Processing request using Spotify Client Credentials Flow');
            } else if (isSpDcAuth || hasSpDc) {
                logs('info', 'Processing request with sp_dc cookie - fetching authenticated token');
            } else {
                logs('debug', 'Processing request using default fallback strategy');
            }

            // Get token
            const token = await this.tokenService.getToken(cookieArray);

            if (!token) {
                setStatus(503);
                logs('error', 'Token service returned null - service temporarily unavailable');
                return this.createErrorResponse('Token service temporarily unavailable');
            }

            // Determine actual token type returned for success log
            const tokenType = token.clientId && !token.isAnonymous
                ? 'client credentials'
                : token.isAnonymous
                ? 'anonymous'
                : 'authenticated';

            logs('info', `Returned ${tokenType} token successfully`);
            return token;

        } catch (error) {
            logs('error', 'Token controller error', error);
            setStatus(500);
            return this.createErrorResponse('Internal server error');
        }
    }

    private extractCookies(cookies?: Record<string, string>): Cookie[] {
        if (cookies && Object.keys(cookies).length > 0) {
            return Object.entries(cookies).map(([name, value]) => ({
                name,
                value
            }));
        }

        // Fallback to SPOTIFY_COOKIE in environment
        const envCookie = process.env.SPOTIFY_COOKIE?.trim();
        if (envCookie) {
            // Handle JSON string array format
            if (envCookie.startsWith('[')) {
                try {
                    const parsed = JSON.parse(envCookie);
                    if (Array.isArray(parsed)) return parsed;
                } catch {
                    logs('error', 'Failed to parse SPOTIFY_COOKIE JSON array from env');
                }
            }

            // Handle plain sp_dc string format
            return [{
                name: 'sp_dc',
                value: envCookie
            }];
        }

        return [];
    }

    private createErrorResponse(error: string) {
        return {
            success: false,
            error,
            timestamp: Date.now()
        };
    }
}