import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Invitation, MembershipService } from "@inkspect/core/lib/membership-service";
import { ReviewError } from "@inkspect/core/lib/review-access";

type StoredInvitation = Invitation & { organization_id: string; status: string; expires_at: Date };

export function selfHostedMembership(pool: Pool): MembershipService {
  async function transaction<T>(organization: string, run: (tx: PoolClient) => Promise<T>) {
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      // Serialize invitations within a workspace without creating a billing row.
      if (!(await tx.query('SELECT id FROM organization WHERE id=$1 FOR UPDATE', [organization])).rowCount) {
        throw new ReviewError(404, "Workspace not found.");
      }
      const result = await run(tx);
      await tx.query("COMMIT");
      return result;
    } catch (error) { await tx.query("ROLLBACK"); throw error; }
    finally { tx.release(); }
  }

  async function manager(tx: PoolClient, organization: string, user: string) {
    const row = (await tx.query<{ role: string }>('SELECT role FROM member WHERE "organizationId"=$1 AND "userId"=$2 FOR SHARE', [organization, user])).rows[0];
    if (!row?.role.split(",").some(role => ["owner", "admin"].includes(role.trim()))) {
      throw new ReviewError(403, "Only workspace owners and admins can manage invitations.");
    }
  }

  return {
    list: async organization => (await pool.query<Invitation>("SELECT id,email,role,status,expires_at FROM workspace_invitation WHERE organization_id=$1 AND status='pending' AND expires_at>now() ORDER BY created_at DESC", [organization])).rows,
    invite: async (organization, inviter, body) => {
      if (typeof body.email !== "string" || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) || !["member", "admin"].includes(String(body.role))) {
        throw new ReviewError(400, "Enter an email address and a member or admin role.");
      }
      const email = body.email.trim().toLowerCase();
      return transaction(organization, async tx => {
        await manager(tx, organization, inviter);
        if ((await tx.query('SELECT 1 FROM member m JOIN "user" u ON u.id=m."userId" WHERE m."organizationId"=$1 AND lower(u.email)=$2', [organization, email])).rowCount) throw new ReviewError(409, "This person is already a member.");
        await tx.query("UPDATE workspace_invitation SET status='expired' WHERE organization_id=$1 AND status='pending' AND expires_at<=now()", [organization]);
        if ((await tx.query("SELECT 1 FROM workspace_invitation WHERE organization_id=$1 AND email=$2 AND status='pending'", [organization, email])).rowCount) throw new ReviewError(409, "A pending invitation already exists for this email.");
        return (await tx.query<Invitation>("INSERT INTO workspace_invitation(id,organization_id,email,role,invited_by) VALUES($1,$2,$3,$4,$5) RETURNING id,email,role,status,expires_at", [randomUUID(), organization, email, body.role, inviter])).rows[0];
      });
    },
    cancel: async (organization, actor, id) => {
      await transaction(organization, async tx => {
        await manager(tx, organization, actor);
        await tx.query("UPDATE workspace_invitation SET status='cancelled' WHERE id=$1 AND organization_id=$2 AND status='pending'", [id, organization]);
      });
    },
    find: async (id, email) => (await pool.query<Invitation>('SELECT i.id,i.email,i.role,i.status,i.expires_at,o.name FROM workspace_invitation i JOIN organization o ON o.id=i.organization_id WHERE i.id=$1 AND i.email=$2', [id, email.toLowerCase()])).rows[0],
    accept: async (id, user) => {
      if (!user.emailVerified) throw new ReviewError(403, "Verify your email address before accepting an invitation.");
      const candidate = (await pool.query<StoredInvitation>("SELECT * FROM workspace_invitation WHERE id=$1 AND email=$2", [id, user.email.toLowerCase()])).rows[0];
      if (!candidate) throw new ReviewError(404, "No invitation for this account.");
      return transaction(candidate.organization_id, async tx => {
        const invite = (await tx.query<StoredInvitation>("SELECT * FROM workspace_invitation WHERE id=$1 FOR UPDATE", [id])).rows[0];
        if (!invite || invite.email !== user.email.toLowerCase()) throw new ReviewError(404, "No invitation for this account.");
        const member = (await tx.query('SELECT 1 FROM member WHERE "organizationId"=$1 AND "userId"=$2', [invite.organization_id, user.id])).rowCount;
        // A replay is safe only while the recipient still belongs to the workspace.
        if (invite.status === "accepted" && member) return { organizationId: invite.organization_id };
        if (invite.status !== "pending" || invite.expires_at <= new Date()) throw new ReviewError(410, "This invitation has expired or was cancelled.");
        if (member) throw new ReviewError(409, "You already belong to this workspace.");
        if (!["member", "admin"].includes(invite.role)) throw new ReviewError(403, "Invalid invitation role.");
        await tx.query('INSERT INTO member(id,"organizationId","userId",role,"createdAt") VALUES($1,$2,$3,$4,now())', [randomUUID(), invite.organization_id, user.id, invite.role]);
        await tx.query("UPDATE workspace_invitation SET status='accepted' WHERE id=$1", [id]);
        return { organizationId: invite.organization_id };
      });
    },
  };
}
