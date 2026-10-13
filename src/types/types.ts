export interface SpotifyToken {
    accessToken: string;
    accessTokenExpirationTimestampMs: number;
    clientId: string;
    isAnonymous: boolean;
}

export interface Cookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
}