import { expect, test } from "vitest";
import { loadNativeCredentialStore } from "./credentials.ts";

test("the exactly pinned native store exposes the expected asynchronous contract", async () => {
  const store = await loadNativeCredentialStore();

  expect(store).toMatchObject({
    deletePassword: expect.any(Function),
    getPassword: expect.any(Function),
    setPassword: expect.any(Function),
  });
});
