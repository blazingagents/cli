import { expect, test } from "vitest";
import {
  AuthenticationError,
  resolveAuthentication,
} from "./authentication.ts";
import {
  API_KEY,
  API_ORIGIN,
  captureAuthentication,
} from "./test/authentication-fixtures.ts";

test("authentication errors preserve safe causes and native loader failures", async () => {
  const login = await captureAuthentication(["--login"], {
    loadCredentialStore: () => Promise.reject(new Error("SECRET loader")),
    readSecret: async () => API_KEY,
    stdinIsTTY: true,
  });
  expect(login.stderr).toContain("native credential store is unavailable");
  expect(login.stderr).not.toContain("SECRET");

  const logout = await captureAuthentication(["--logout"], {
    loadCredentialStore: () => Promise.reject(new Error("SECRET loader")),
  });
  expect(logout.stderr).toContain("native credential store is unavailable");
  expect(logout.stderr).not.toContain("SECRET");

  await expect(
    resolveAuthentication({
      configuration: { baseUrl: API_ORIGIN, source: "default" },
      environment: {},
      loadCredentialStore: () => Promise.reject(new Error("SECRET loader")),
    })
  ).rejects.toBeInstanceOf(AuthenticationError);
});
