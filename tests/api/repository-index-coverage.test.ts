import assert from "node:assert/strict";
import test from "node:test";
import { repositories } from "../../src/repositories";

test("index coverage reads only the connected repositories on the requested page", async () => {
  const auth = {
    api: { getSession: async () => ({ session: { activeOrganizationId: "org" }, user: { id: "member" } }) },
    $context: Promise.resolve({ adapter: {
      findOne: async () => ({ role: "member" }),
      findMany: async () => [{ id: "conn", installationId: "44", repositories: JSON.stringify([{ id: 17 }, { id: 19 }]) }],
    } }),
  } as unknown as Parameters<typeof repositories>[1];
  let reads = 0;
  const store = { repositoryIndexCoverage: async (org: string, scopes: unknown[]) => {
    reads++;
    assert.equal(org, "org");
    assert.deepEqual(scopes, [{ repository_id: "17", connection_id: "conn", installation_id: "44" }]);
    return { "17": "partial" };
  } } as unknown as Parameters<typeof repositories>[2];
  const request = (ids: string) => repositories(new Request(`http://localhost/api/repositories?organizationId=org&action=index-coverage&ids=${ids}`), auth, store);
  const response = await request("17,17,99");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { coverage: { "17": "partial" } });
  assert.equal((await request("")).status, 400);
  assert.equal((await request(Array.from({ length: 21 }, (_, i) => i + 1).join(","))).status, 400);
  assert.equal(reads, 1);
});
