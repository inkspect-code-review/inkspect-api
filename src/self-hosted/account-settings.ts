import type { Pool } from "pg";
import type { Auth } from "@inkspect/core/lib/github";
import { readReviewJSON, ReviewError, reviewFailure, reviewJSON } from "@inkspect/core/lib/review-access";

type AccountSection = "devices" | "notifications";

export async function accountSettings(request: Request, auth: Auth, pool: Pool, section: AccountSection) {
  try {
    const writing = request.method === "POST";
    if (!writing && request.method !== "GET") throw new ReviewError(405, "Method not allowed.");
    if (writing && request.headers.get("origin") !== new URL(auth.options.baseURL).origin) {
      throw new ReviewError(403, "This request is not allowed.");
    }
    const headers = request.headers;
    const current = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
    if (!current) throw new ReviewError(401, "Sign in to manage your account.");
    const userId = current.user.id;

    if (section === "notifications") {
      if (!writing) {
        const result = await pool.query("SELECT product, transactional FROM account_email_preference WHERE user_id = $1", [userId]);
        return reviewJSON(result.rows[0] ?? { product: true, transactional: true });
      }
      const { category, enabled } = await readReviewJSON(request);
      if ((category !== "product" && category !== "transactional") || typeof enabled !== "boolean") {
        throw new ReviewError(400, "Choose a valid email preference.");
      }
      // Update one preference so independent changes from two devices are both retained.
      const result = await pool.query(
        `INSERT INTO account_email_preference (user_id, ${category}) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET ${category} = EXCLUDED.${category}
         RETURNING product, transactional`, [userId, enabled]);
      return reviewJSON(result.rows[0]);
    }

    const { internalAdapter } = await auth.$context;
    const sessions = await internalAdapter.listSessions(userId, { onlyActiveSessions: true });
    if (!writing) {
      return reviewJSON(sessions.map(({ id, userAgent, ipAddress, createdAt }) => ({
        id, userAgent, ipAddress, createdAt, current: id === current.session.id,
      })));
    }
    const action = await readReviewJSON(request);
    if (action.others === true && action.id === undefined) {
      await auth.api.revokeOtherSessions({ headers });
    } else {
      if (typeof action.id !== "string" || action.others !== undefined || action.id === current.session.id) {
        throw new ReviewError(400, "Select another device to sign out.");
      }
      const target = sessions.find(session => session.id === action.id);
      if (!target) throw new ReviewError(404, "This device is no longer signed in.");
      await auth.api.revokeSession({ headers, body: { token: target.token } });
    }
    return reviewJSON({ success: true });
  } catch (error) { return reviewFailure(error); }
}
