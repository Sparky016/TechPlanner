import { recordAudit } from '@/server/audit/audit';
import { decryptSecret, encryptSecret } from '@/server/crypto/secrets';
import { withTxLock } from '@/server/db/locks';
import { type DbClient, query, withTransaction } from '@/server/db/pool';
import { logger } from '@/server/observability/logger';
import { getCorrelationId } from '@/server/observability/context';
import { type TokenSet, refreshTokens } from './atlassianOAuth';

// Server-only: never import from src/lib or client components.
// Per-user Atlassian tokens (SR-1.2), stored encrypted. Tokens never appear in logs, audit details or errors.

const REFRESH_MARGIN_SECONDS = 60;

// The user must sign in again; task 13 maps this to 401 with code 'reauth_required'.
export class ReauthRequiredError extends Error {
  readonly code = 'reauth_required';

  constructor() {
    super('Atlassian re-authentication required');
    this.name = 'ReauthRequiredError';
  }
}

interface TokenRow {
  enc_access_token: Buffer;
  enc_refresh_token: Buffer | null;
  // A comparison is a BIGINT in MySQL, which the driver returns as the string '1' or '0'.
  fresh: string;
}

const SELECT_TOKEN = `SELECT enc_access_token, enc_refresh_token,
                             expires_at > NOW(6) + INTERVAL ? SECOND AS fresh
                        FROM oauth_token WHERE user_id = ?`;

const isFresh = (row: TokenRow): boolean => Number(row.fresh) === 1;

// Inserts or replaces the user's tokens inside the caller's transaction.
export async function storeTokens(client: DbClient, userId: string, tokens: TokenSet): Promise<void> {
  await client.query(
    `INSERT INTO oauth_token (user_id, enc_access_token, enc_refresh_token, expires_at, scopes, updated_at)
     VALUES (?, ?, ?, NOW(6) + INTERVAL ? SECOND, ?, NOW(6)) AS new
     ON DUPLICATE KEY UPDATE
       enc_access_token = new.enc_access_token,
       enc_refresh_token = new.enc_refresh_token,
       expires_at = new.expires_at,
       -- A refresh response may omit scope; keep the granted scopes then.
       scopes = IF(JSON_LENGTH(new.scopes) = 0, oauth_token.scopes, new.scopes),
       updated_at = NOW(6)`,
    [
      userId,
      encryptSecret(tokens.accessToken),
      tokens.refreshToken === null ? null : encryptSecret(tokens.refreshToken),
      tokens.expiresInSeconds,
      JSON.stringify(tokens.scopes),
    ],
  );
}

// Returns a usable access token for the user, refreshing it when it expires within 60 s.
// `force` refreshes regardless of expiry (Atlassian rejected the stored token with 401).
// Concurrent refreshes for one user are serialised; Atlassian rotates refresh tokens, so only one may win.
export async function getValidAccessToken(userId: string, opts: { force?: boolean } = {}): Promise<string> {
  const force = opts.force === true;
  const [row] = await query<TokenRow>(SELECT_TOKEN, [REFRESH_MARGIN_SECONDS, userId]);
  if (!row) throw new ReauthRequiredError();
  if (isFresh(row) && !force) return decryptSecret(row.enc_access_token);

  // The failure path must commit (row deleted, audit written) before the error is thrown.
  const outcome = await withTransaction(async (client): Promise<{ token: string } | { reauth: true }> => {
    await withTxLock(client, `refresh:${userId}`);
    const reread = await client.query<TokenRow>(`${SELECT_TOKEN} FOR UPDATE`, [REFRESH_MARGIN_SECONDS, userId]);
    const current = reread.rows[0];
    if (!current) return { reauth: true };
    // Another caller refreshed while we waited for the lock.
    if (isFresh(current) && !force) return { token: decryptSecret(current.enc_access_token) };

    let refreshed: TokenSet | null = null;
    let reason = 'no_refresh_token';
    if (current.enc_refresh_token) {
      const refreshToken = decryptSecret(current.enc_refresh_token);
      try {
        refreshed = await refreshTokens(refreshToken);
        if (refreshed.refreshToken === null) refreshed = { ...refreshed, refreshToken };
      } catch (err) {
        const status = (err as { status?: number }).status;
        reason = status ? `refresh_rejected_${status}` : 'refresh_unavailable';
      }
    }

    if (!refreshed) {
      await client.query('DELETE FROM oauth_token WHERE user_id = ?', [userId]);
      await recordAudit(
        {
          action: 'auth.refresh_failed',
          result: 'failure',
          userId,
          details: { reason },
          correlationId: getCorrelationId() ?? null,
        },
        client,
      );
      logger.warn({ userId, reason }, 'Atlassian token refresh failed; re-authentication required');
      return { reauth: true };
    }

    await storeTokens(client, userId, refreshed);
    return { token: refreshed.accessToken };
  });

  if ('reauth' in outcome) throw new ReauthRequiredError();
  return outcome.token;
}
