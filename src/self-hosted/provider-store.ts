import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ByokSelection, ProviderSettingsService } from "@inkspect/core/lib/byok/service";
import { encryptCredential, encryptionReady, type Envelope } from "@inkspect/core/lib/byok/encryption";
import { supportedModel } from "@inkspect/core/lib/byok/catalog";
import { ReviewError } from "@inkspect/core/lib/review-access";

type Connection = { id: string; provider: string; model: string; key_suffix: string; updated_at: Date; envelope: Envelope };
export function selfHostedProviders(pool: Pool) {
  async function managerTransaction<T>(org: string, user: string, run: (tx: PoolClient) => Promise<T>) {
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      if (!(await tx.query('SELECT id FROM organization WHERE id=$1 FOR UPDATE', [org])).rowCount) throw new ReviewError(404, "Workspace not found.");
      const member = (await tx.query<{ role: string }>('SELECT role FROM member WHERE "organizationId"=$1 AND "userId"=$2 FOR SHARE', [org, user])).rows[0];
      if (!member?.role.split(",").some(role => ["owner", "admin"].includes(role.trim()))) throw new ReviewError(403, "Only workspace owners and admins can manage provider keys.");
      const result = await run(tx); await tx.query("COMMIT"); return result;
    } catch (error) { await tx.query("ROLLBACK"); throw error; }
    finally { tx.release(); }
  }
  const services: ProviderSettingsService = {
    ready: encryptionReady,
    state: async org => {
      const settings = (await pool.query("SELECT review_provider FROM workspace_provider_settings WHERE organization_id=$1", [org])).rows[0];
      const saved = (await pool.query<Connection>("SELECT id,provider,model,key_suffix,updated_at FROM workspace_provider_credential WHERE organization_id=$1", [org])).rows[0];
      return { review_provider: settings?.review_provider || "managed", eligible: true, connection: saved || null };
    },
    save: async (org, user, provider, model, key) => {
      const entry = supportedModel(provider, model);
      if (!entry || typeof key !== "string" || key.length < 16 || key.length > 4096 || /[^\x21-\x7e]/.test(key)) throw new ReviewError(400, "Choose a supported model and enter a valid API key.");
      const id = randomUUID();
      let envelope: Envelope;
      try { envelope = encryptCredential(key, { organization: org, id, provider: entry.provider, model: entry.id }); }
      catch { throw new ReviewError(503, "Secure provider key storage is not configured."); }
      await managerTransaction(org, user, async tx => {
        await tx.query(`INSERT INTO workspace_provider_credential(organization_id,id,provider,model,envelope,key_suffix,updated_by)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(organization_id) DO UPDATE SET id=excluded.id,provider=excluded.provider,
          model=excluded.model,envelope=excluded.envelope,key_suffix=excluded.key_suffix,updated_by=excluded.updated_by,updated_at=now()`, [org,id,entry.provider,entry.id,envelope,key.slice(-4),user]);
        await tx.query("INSERT INTO workspace_provider_settings(organization_id,review_provider) VALUES($1,'byok') ON CONFLICT(organization_id) DO UPDATE SET review_provider='byok'", [org]);
      });
    },
    remove: async (org, user) => { await managerTransaction(org, user, async tx => { await tx.query("DELETE FROM workspace_provider_credential WHERE organization_id=$1", [org]); }); },
    setMode: async (org, user, mode) => {
      if (mode !== "managed" && mode !== "byok") throw new ReviewError(400, "Choose the instance or organization provider.");
      await managerTransaction(org, user, async tx => {
        if (mode === "byok" && !(await tx.query("SELECT 1 FROM workspace_provider_credential WHERE organization_id=$1", [org])).rowCount) throw new ReviewError(409, "Save a provider key first.");
        await tx.query("INSERT INTO workspace_provider_settings(organization_id,review_provider) VALUES($1,$2) ON CONFLICT(organization_id) DO UPDATE SET review_provider=excluded.review_provider", [org,mode]);
      });
    },
  };
  // Engine-only consumers must additionally authenticate and scope the job.
  async function forReview(org: string, user: string): Promise<ByokSelection | null> {
    if (!(await pool.query('SELECT 1 FROM member WHERE "organizationId"=$1 AND "userId"=$2', [org,user])).rowCount) throw new ReviewError(403, "Workspace membership required.");
    const state = await services.state(org);
    if (state.review_provider !== "byok") return null;
    const saved = state.connection;
    if (!saved || !supportedModel(saved.provider,saved.model)) throw new ReviewError(409, "Configure your review provider and API key in Settings.");
    return { credential_id: saved.id, provider: saved.provider, model: saved.model };
  }
  async function credentials(org: string, user: string, requested: ByokSelection) {
    const selection = await forReview(org,user);
    if (!selection || selection.credential_id !== requested.credential_id || selection.provider !== requested.provider || selection.model !== requested.model) throw new ReviewError(403, "The provider key or model changed. Start a new review.");
    const saved = (await pool.query<Connection>("SELECT envelope FROM workspace_provider_credential WHERE organization_id=$1 AND id=$2", [org,selection.credential_id])).rows[0];
    if (!saved) throw new ReviewError(403, "The provider key was removed.");
    return { selection, envelope: saved.envelope };
  }
  return { ...services, forReview, credentials };
}
