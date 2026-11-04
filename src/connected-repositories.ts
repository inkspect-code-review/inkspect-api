import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
export type ConnectedRepository = { organization: string; connection: string; installation: number; repository: number; fullName: string };
export function repositoryIdentity(repo: ConnectedRepository) {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(repo.organization) || !/^[A-Za-z0-9_-]{1,200}$/.test(repo.connection) ||
      !Number.isSafeInteger(repo.repository) || repo.repository < 1 || !Number.isSafeInteger(repo.installation) || repo.installation < 1 ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.fullName)) throw new Error('Invalid connected repository identity');
  return createHash('sha256').update(JSON.stringify([repo.organization, repo.connection, repo.installation, repo.repository, repo.fullName])).digest('hex').slice(0, 24);
}
// Read only connections verified by the GitHub callback, with the workspace's
// repository claim still present. Request bodies never choose worker identities.
export async function connectedRepositories(pool: Pool): Promise<ConnectedRepository[]> {
  const { rows } = await pool.query(`SELECT c.id AS connection,c."organizationId" AS organization,
    c."installationId" AS installation,r->>'id' AS repository,r->>'fullName' AS "fullName"
    FROM "githubConnection" c CROSS JOIN LATERAL jsonb_array_elements(c.repositories::jsonb) r
    JOIN "githubRepositoryClaim" claim ON claim."repositoryId"=r->>'id' AND claim."organizationId"=c."organizationId"
    ORDER BY c."organizationId",c.id,r->>'id'`);
  return rows.map(row => {
    const repo = { ...row, installation: Number(row.installation), repository: Number(row.repository) } as ConnectedRepository;
    repositoryIdentity(repo);
    return repo;
  });
}
