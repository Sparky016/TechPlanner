import type { PoolClient } from 'pg';
import { recordAudit } from '@/server/audit/audit';
import { decryptSecret, encryptSecret } from '@/server/crypto/secrets';
import { query, withTransaction } from '@/server/db/pool';
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
  fresh: boolean;
}

const SELECT_TOKEN = `SELECT enc_access_token, enc_refresh_token,
                             expires_at > now() + make_interval(secs => $2) AS fresh
                        FROM oauth_token WHERE user_id = $1`;

// Inserts or replaces the user's tokens inside the caller's transaction.
export async function storeTokens(client: PoolClient, userId: string, tokens: TokenSet): Promise<void> {
  await client.query(
    `INSERT INTO oauth_token (user_id, enc_access_token, enc_refresh_token, expires_at, scopes, updated_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4), $5, now())
     ON CONFLICT (user_id) DO UPDATE
       SET enc_access_token = EXCLUDED.enc_access_token,
           enc_refresh_token = EXCLUDED.enc_refresh_token,
           expires_at = EXCLUDED.expires_at,
           -- A refresh response may omit scope; keep the granted scopes then.
           scopes = CASE WHEN cardinality(EXCLUDED.scopes) = 0 THEN oauth_token.scopes ELSE EXCLUDED.scopes END,
           updated_at = now()`,
    [
      userId,
      encryptSecret(tokens.accessToken),
      tokens.refreshToken === null ? null : encryptSecret(tokens.refreshToken),
      tokens.expiresInSeconds,
      tokens.scopes,
    ],
  );
}

// Returns a usable access token for the user, refreshing it when it expires within 60 s.
// Concurrent refreshes for one user are serialised; Atlassian rotates refresh tokens, so only one may win.
export async function getValidAccessToken(userId: string): Promise<string> {
  const [row] = await query<TokenRow>(SELECT_TOKEN, [userId, REFRESH_MARGIN_SECONDS]);
  if (!row) throw new ReauthRequiredError();
  if (row.fresh) return decryptSecret(row.enc_access_token);

  // The failure path must commit (row deleted, audit written) before the error is thrown.
  const outcome = await withTransaction(async (client): Promise<{ token: string } | { reauth: true }> => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('refresh:' || $1))", [userId]);
    const reread = await client.query<TokenRow>(`${SELECT_TOKEN} FOR UPDATE`, [userId, REFRESH_MARGIN_SECONDS]);
    const current = reread.rows[0];
    if (!current) return { reauth: true };
    // Another caller refreshed while we waited for the lock.
    if (current.fresh) return { token: decryptSecret(current.enc_access_token) };

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
      await client.query('DELETE FROM oauth_token WHERE user_id = $1', [userId]);
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
